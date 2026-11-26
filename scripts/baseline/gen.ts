/**
 * §9.12: writes the ast-grep baseline rules (one file per order) into scripts/baseline/rules/.
 * Same as `dnr trial baseline --generate`. The rule logic is packages/trial/src/baseline-gen.ts;
 * this file and that one are hashed together (MANIFEST.json gen_sha256) before prereg-v1.
 *
 *   pnpm tsx scripts/baseline/gen.ts
 */
import { generateBaseline } from '../../packages/trial/src/commands';

const code = await generateBaseline(process.env, (m) => process.stderr.write(`${m}\n`));
process.exit(code);
