/// <reference types="vite/client" />
/** Optional data files present in this build (vite.config.ts). */
declare const __DNR_DATA__: { trial: boolean; prereg: boolean; capture: boolean };
interface ImportMetaEnv {
  readonly VITE_REPO_URL?: string;
  readonly VITE_DNR_VERSION?: string;
}
