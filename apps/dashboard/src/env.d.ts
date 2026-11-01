interface ImportMetaEnv {
  /** AG Studio licence key, written into the browser bundle at build time. */
  readonly VITE_AG_STUDIO_LICENSE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
