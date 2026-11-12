/**
 * The workspace shell's client script, as nine text fragments.
 *
 * Why it is split: the script used to be **one 4,200-line template literal**
 * inside `pycharm-client.ts`. A single backtick anywhere in it — including in a
 * comment — silently ended the string, and the failure surfaced dozens of lines
 * later (twice: 0.7.2 and 0.7.4). Keeping the code in real `.js` files removes
 * that failure mode entirely: there is no enclosing literal to truncate.
 *
 * The files are imported as **text** (`?raw`, the same mechanism the vendored
 * CodeMirror and the perf app use), so nothing is bundled, transpiled or
 * minified — the page still ships byte-identical output and the packaged exe
 * carries them like every other asset.
 *
 * Order matters: these fragments share one IIFE closure, so a later file may
 * use a function an earlier one declared (function declarations hoist; `var`
 * initialisers do not, and run in this order).
 *
 *  00-core         hardening, helpers, i18n, interaction layer
 *  10-state        preferences (localStorage), transport bridge
 *  20-editor       editor, CodeMirror adapter, tokeniser, catalogue, ctx menu
 *  30-panels       buffers/tabs, tool windows, project tree (+ editing)
 *  40-docks        MCP, performance, flame graph, logs, problems
 *  45-preview      Markdown preview pane + outline (#40)
 *  50-runtime      run / debug / coverage / formatting / terminal / messages
 *  60-menus        menus, theme, language mode, modals, settings, run configs
 *  70-shell        pickers, search, toolbar, keymap, interpreter, boot
 */
import core from './client/00-core.js?raw';
import state from './client/10-state.js?raw';
import editor from './client/20-editor.js?raw';
import panels from './client/30-panels.js?raw';
import docks from './client/40-docks.js?raw';
import preview from './client/45-preview.js?raw';
import runtime from './client/50-runtime.js?raw';
import menus from './client/60-menus.js?raw';
import shell from './client/70-shell.js?raw';

export interface ClientFragment {
  /** File name, for error messages and the self-containment checks. */
  file: string;
  text: string;
}

/** Fragments in load order. */
export const CLIENT_FRAGMENTS: ClientFragment[] = [
  { file: '00-core.js', text: core },
  { file: '10-state.js', text: state },
  { file: '20-editor.js', text: editor },
  { file: '30-panels.js', text: panels },
  { file: '40-docks.js', text: docks },
  { file: '45-preview.js', text: preview },
  { file: '50-runtime.js', text: runtime },
  { file: '60-menus.js', text: menus },
  { file: '70-shell.js', text: shell },
];
