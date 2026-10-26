declare module "*.css";
declare module "*.png" {
  const src: string;
  export default src;
}
declare module "*.svg" {
  const src: string;
  export default src;
}

interface ImportMetaEnv {
  readonly BUN_PUBLIC_CONVEX_URL?: string;
  readonly BUN_PUBLIC_ERROR_REPORT_URL?: string;
}

interface ImportMeta {
  readonly env?: ImportMetaEnv;
}

interface Window {
  __DFTSTREAM_VERSION__?: string;
  /** True when the serving binary exposes /api/local-file (Tools tab). */
  __DFTSTREAM_LOCAL_FILES__?: boolean;
}
