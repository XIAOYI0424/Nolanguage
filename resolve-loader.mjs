// Dev-only ESM resolver: lets `node --experimental-transform-types` resolve
// `.js` import specifiers to sibling `.ts` files (Node's built-in stripping
// does not do this automatically in this environment). Not used in production
// builds (tsx / tsc emit real .js).
//
// It also implements a Vite-style `?raw` suffix: the imported file's text is
// inlined as the module's default export. The panel HTML renderers use it to
// vendor third-party runtimes (Vue) and browser-side app sources without a
// bundler step — see `scripts/build-exe.mjs`, which mirrors both rules.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && specifier.endsWith('.js')) {
    const tsSpec = specifier.slice(0, -3) + '.ts';
    try {
      return await next(tsSpec, context);
    } catch {
      // fall through to default resolution
    }
  }
  return next(specifier, context);
}

/**
 * `./assets/app.js?raw` — turn the file into a module whose default export is
 * its own text. Handled here (rather than in `resolve`) so Node's normal
 * relative-URL resolution, including the query suffix, still applies.
 */
export async function load(url, context, next) {
  if (!url.endsWith('?raw')) return next(url, context);
  const fileUrl = url.slice(0, -4); // drop "?raw"
  let filePath;
  try {
    filePath = fileURLToPath(fileUrl);
  } catch {
    return next(url, context);
  }
  return {
    format: 'module',
    source: `export default ${JSON.stringify(readFileSync(filePath, 'utf8'))};`,
    shortCircuit: true,
  };
}
