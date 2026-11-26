/**
 * Owner-set ACLs for `--isolation os-user`, per platform: macOS `chmod +a` (with file_inherit and
 * directory_inherit), Linux `setfacl` (with default ACLs for inheritance). Where neither exists,
 * os-user isolation is refused (exit 69); no root is needed for either.
 */
import { execFile, execFileSync } from 'node:child_process';

export type AclMechanism = 'macos-chmod' | 'posix-setfacl';

export type AclPerm = 'full' | 'search' | 'lockdir' | 'write' | 'read';

let cached: AclMechanism | null | undefined;

/** The ACL mechanism of this platform, or null. */
export function aclMechanism(): AclMechanism | null {
  if (cached !== undefined) return cached;
  if (process.platform === 'darwin') cached = 'macos-chmod';
  else {
    try {
      execFileSync('setfacl', ['--version'], { stdio: 'ignore' });
      cached = 'posix-setfacl';
    } catch {
      cached = null;
    }
  }
  return cached;
}

const MAC: Record<AclPerm, string> = {
  full: 'list,add_file,search,add_subdirectory,delete_child,readattr,writeattr,readextattr,writeextattr,readsecurity,read,write,append,execute,delete,file_inherit,directory_inherit',
  search: 'search',
  lockdir: 'search,list,add_subdirectory,delete_child',
  write: 'write,append',
  read: 'read',
};
const POSIX: Record<AclPerm, string> = { full: 'rwX', search: 'x', lockdir: 'rwx', write: 'w', read: 'r' };

/** The command that grants `perm` on `path` to `user` (recursive and inherited for `full`). */
export function aclCommand(
  m: AclMechanism,
  user: string,
  perm: AclPerm,
  path: string,
): { cmd: string; args: string[] } {
  if (m === 'macos-chmod')
    return {
      cmd: 'chmod',
      args: [...(perm === 'full' ? ['-R'] : []), '+a', `${user} allow ${MAC[perm]}`, path],
    };
  const spec = `u:${user}:${POSIX[perm]}`;
  return perm === 'full'
    ? { cmd: 'setfacl', args: ['-R', '-m', `${spec},d:${spec}`, path] }
    : { cmd: 'setfacl', args: ['-m', spec, path] };
}

export function grantAcl(user: string, perm: AclPerm, path: string): Promise<void> {
  const m = aclMechanism();
  if (!m)
    return Promise.reject(new Error('no ACL mechanism on this platform (macOS chmod +a or Linux setfacl)'));
  const c = aclCommand(m, user, perm, path);
  return new Promise((resolve, reject) => {
    execFile(c.cmd, c.args, (e, _o, se) =>
      e ? reject(new Error(`${c.cmd} ${c.args.join(' ')}: ${se || e.message}`)) : resolve(),
    );
  });
}

/** Text listing of a path's ACL entries (`ls -led` on macOS, `getfacl` on Linux), for checks. */
export function aclListing(path: string): string {
  return aclMechanism() === 'macos-chmod'
    ? execFileSync('ls', ['-led', path]).toString()
    : execFileSync('getfacl', ['-p', path]).toString();
}
