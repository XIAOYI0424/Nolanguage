/**
 * CodeMirror 5, vendored and inlined.
 *
 * The editor is part of the self-contained page: the core, the modes the shell
 * offers, and the addons the editor uses are imported as text (`?raw`) and
 * emitted as plain `<script>` blocks. No CDN, no build-time bundler, and the
 * packaged exe carries them exactly like the vendored Vue runtime.
 *
 * Import order is the load order: core → modes (xml before markdown/htmlmixed,
 * which resolve it at mode-creation time) → addons → show-hint.
 */
import cmJs from '../vendor/codemirror/codemirror.js?raw';
import cmCss from '../vendor/codemirror/codemirror.css?raw';

import modeXml from '../vendor/codemirror/mode/xml/xml.js?raw';
import modePython from '../vendor/codemirror/mode/python/python.js?raw';
import modeGo from '../vendor/codemirror/mode/go/go.js?raw';
import modeJs from '../vendor/codemirror/mode/javascript/javascript.js?raw';
import modeMarkdown from '../vendor/codemirror/mode/markdown/markdown.js?raw';
import modeCss from '../vendor/codemirror/mode/css/css.js?raw';
import modeYaml from '../vendor/codemirror/mode/yaml/yaml.js?raw';
import modeSql from '../vendor/codemirror/mode/sql/sql.js?raw';
import modeShell from '../vendor/codemirror/mode/shell/shell.js?raw';
import modeToml from '../vendor/codemirror/mode/toml/toml.js?raw';
import modeHtmlMixed from '../vendor/codemirror/mode/htmlmixed/htmlmixed.js?raw';

import addonMatchBrackets from '../vendor/codemirror/addon/edit/matchbrackets.js?raw';
import addonCloseBrackets from '../vendor/codemirror/addon/edit/closebrackets.js?raw';
import addonActiveLine from '../vendor/codemirror/addon/selection/active-line.js?raw';
import addonShowHintJs from '../vendor/codemirror/addon/hint/show-hint.js?raw';
import addonShowHintCss from '../vendor/codemirror/addon/hint/show-hint.css?raw';

/**
 * Theme bridge: CodeMirror ships a light theme, the shell is variable-driven
 * (Light / Darcula). Mapping CM's token classes onto the shell's `--syn-*`
 * variables keeps the editor visually identical in both themes.
 */
const THEME_CSS = `
#cmHost { position:absolute; inset:0; }
#cmHost .CodeMirror { height:100%; font:13px/20px var(--mono); background:var(--bg-editor); color:var(--text-primary); }
#cmHost .CodeMirror-scroll { min-height:100%; }
#cmHost .CodeMirror-gutters { background:var(--bg-gutter); border-right:1px solid var(--border-soft); }
#cmHost .CodeMirror-linenumber { color:var(--text-tertiary); padding:0 8px 0 10px; }
#cmHost .CodeMirror-cursor { border-left:1px solid var(--accent); }
#cmHost .CodeMirror-selected { background:var(--sel-bg, rgba(53,116,240,.22)); }
#cmHost .CodeMirror-focused .CodeMirror-selected { background:var(--sel-bg, rgba(53,116,240,.22)); }
#cmHost .CodeMirror-activeline-background { background:var(--bg-hover); }
#cmHost .CodeMirror-matchingbracket { color:var(--accent) !important; border-bottom:1px solid var(--accent); }
#cmHost .CodeMirror-nonmatchingbracket { color:var(--error) !important; }
#cmHost .cm-keyword { color:var(--syn-keyword); }
#cmHost .cm-atom, #cmHost .cm-number { color:var(--syn-number); }
#cmHost .cm-def { color:var(--syn-func); }
#cmHost .cm-variable-3, #cmHost .cm-type { color:var(--syn-class); }
#cmHost .cm-operator { color:var(--text-secondary); }
#cmHost .cm-comment { color:var(--syn-comment); font-style:italic; }
#cmHost .cm-string, #cmHost .cm-string-2 { color:var(--syn-string); }
#cmHost .cm-meta { color:var(--syn-deco); }
#cmHost .cm-builtin { color:var(--syn-const); }
#cmHost .cm-tag { color:var(--syn-keyword); }
#cmHost .cm-attribute { color:var(--syn-deco); }
#cmHost .cm-header { color:var(--syn-keyword); font-weight:600; }
#cmHost .cm-quote { color:var(--syn-comment); }
#cmHost .cm-link { color:var(--syn-func); text-decoration:underline; }
#cmHost .cm-error { color:var(--error); }
`;

export const CODEMIRROR_CSS = [cmCss, addonShowHintCss, THEME_CSS].join('\n');

export const CODEMIRROR_JS = [
  cmJs,
  modeXml,
  modePython,
  modeGo,
  modeJs,
  modeMarkdown,
  modeCss,
  modeYaml,
  modeSql,
  modeShell,
  modeToml,
  modeHtmlMixed,
  addonMatchBrackets,
  addonCloseBrackets,
  addonActiveLine,
  addonShowHintJs,
].join('\n;\n');

/** True when the vendored assets are present (they always are once built). */
export const HAS_CODEMIRROR = cmJs.length > 1000;
