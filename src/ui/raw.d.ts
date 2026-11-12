/**
 * Bundler `?raw` imports.
 *
 * `scripts/build-exe.mjs` (esbuild) and `scripts/build-frontend.mjs` load the
 * standalone panel pages as text (`import page from './ui.js?raw'`) so the
 * bytes served to the browser are byte-identical to the files on disk. esbuild
 * understands the suffix; the TypeScript checker does not, so the module shape
 * is declared here (the `*.d.ts` sits next to the importers, which keeps it in
 * the program without touching `tsconfig.json`).
 */
declare module '*?raw' {
  const text: string;
  export default text;
}
