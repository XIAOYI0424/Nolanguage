/**
 * The workspace shell's browser half — assembled from eight text fragments.
 *
 * This file used to *be* the script: one 4,200-line template literal. Two
 * incidents (0.7.2, 0.7.4) proved the cost of that shape — a stray backtick in
 * a comment ended the literal, and the parser reported the damage dozens of
 * lines later. The code now lives in `ui/client/*.js` as plain JavaScript and
 * is stitched back together here.
 *
 * Everything the page needs is still inlined: the fragments are imported as
 * text (`?raw`), so the served HTML and the packaged exe carry exactly the same
 * bytes as before the split. See `client-assets.ts` for the file map.
 *
 * The fragments share one IIFE closure, in load order, exactly like the single
 * literal did — this is a file split, not a module boundary.
 */
import { CLIENT_FRAGMENTS } from './client-assets.js';

export interface PanelClientData {
  iconsJson: string;
  patternJson: string;
  mainJson: string;
  utilsJson: string;
  jsJson: string;
  readmeJson: string;
  i18nJson: string;
}

/**
 * The seeds the script interpolates.
 *
 * They appear in the fragments as `${name}` and are substituted here. Writing
 * them as tokens instead of evaluating a template keeps the fragments valid
 * JavaScript for editors, linters and the `new Function(...)` check the suite
 * runs on the assembled output.
 */
const SEEDS: Array<keyof PanelClientData> = [
  'iconsJson',
  'patternJson',
  'mainJson',
  'utilsJson',
  'jsJson',
  'readmeJson',
  'i18nJson',
];

/** The complete inline `<script>` body for the workspace page. */
export function pyCharmClientScript(d: PanelClientData): string {
  // Joined with a newline because the fragments are contiguous *line ranges* of
  // the original body: `lines.slice(a, b).join('\n')` on both sides, so the
  // concatenation is byte-identical to what the template produced.
  let out = CLIENT_FRAGMENTS.map((f) => f.text).join('\n');
  for (const key of SEEDS) {
    // split/join rather than replace: a seed is JSON and may contain `$&`.
    out = out.split('${' + key + '}').join(d[key]);
  }
  return out;
}
