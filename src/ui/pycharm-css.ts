/**
 * The PyCharm New UI stylesheet, verbatim.
 *
 * Split out of `pycharm-ui.ts` so the assembly file stays readable; the CSS
 * is still served inline in one `<style>` block (no build step, no CDN).
 * Both themes are a `data-theme` flip on <html>; every colour is a variable.
 */
export const PYCHARM_CSS = `
  :root, :root[data-theme="darcula"] {
    --bg-primary:#3C3F41; --bg-secondary:#343638; --bg-tertiary:#45494B;
    --bg-editor:#2B2B2B; --bg-gutter:#2B2B2B; --bg-toolbar:#3C3F41;
    --bg-hover:#484B4D; --bg-active:#214283; --current-line:#2F3B4D; --border:#323232; --border-soft:#323232;
    --text-primary:#A9B7C6; --text-secondary:#9DA0A8; --text-tertiary:#808080; --gutter-number:#606366;
    --accent:#9876AA; --success:#499C54; --warning:#F9A825; --error:#DB5860;
    --icon-default:#9DA0A8; --icon-active:#DADADA;
    --sel:#214283; --sel-text:#FFFFFF; --sel-bg:rgba(33,66,131,.48);
    --syn-keyword:#CC7832; --syn-string:#6A8759; --syn-number:#6897BB; --syn-comment:#808080;
    --syn-func:#FFC66D; --syn-class:#A9B7C6; --syn-var:#A9B7C6; --syn-const:#6897BB; --syn-deco:#9876AA;
    --shadow:0 8px 24px rgba(0,0,0,.34);
    --project-width:240px; --right-width:220px; --dock-height:205px;
    --mono:"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --sans:Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", system-ui, sans-serif;
    --ui-transition:color .14s ease, background-color .14s ease, border-color .14s ease;
  }
  :root[data-theme="light"] {
    --bg-primary:#F4F5F7; --bg-secondary:#ECEEF1; --bg-tertiary:#FFFFFF;
    --bg-editor:#FFFFFF; --bg-gutter:#F4F5F7; --bg-toolbar:#F4F5F7;
    --bg-hover:#E5E8EC; --bg-active:#D9E7FA; --current-line:#EDF2F8; --border:#D8DADD; --border-soft:#E1E3E6;
    --text-primary:#30343A; --text-secondary:#555B63; --text-tertiary:#777D85; --gutter-number:#9AA0A6;
    --accent:#8156A4; --success:#3B8745; --warning:#B87900; --error:#C33F48; --run-accent:#3B8745;
    --icon-default:#6C707E; --icon-active:#20242A;
    --sel:#CFE2FF; --sel-text:#20242A; --sel-bg:rgba(69,119,195,.2);
    --syn-keyword:#A65300; --syn-string:#38713A; --syn-number:#28649A; --syn-comment:#8A8F95;
    --syn-func:#9A6500; --syn-class:#30343A; --syn-var:#30343A; --syn-const:#28649A; --syn-deco:#8156A4;
    --shadow:0 8px 24px rgba(20,25,35,.16);
  }
  * { box-sizing:border-box; transition:var(--ui-transition); }
  html, body { height:100%; margin:0; }
  body {
    background:var(--bg-primary); color:var(--text-primary);
    font:12px/1.45 var(--sans); overflow:hidden; -webkit-font-smoothing:antialiased;
    overscroll-behavior:none; user-select:none; -webkit-user-select:none; cursor:default;
  }
  button { font:inherit; color:inherit; background:none; border:0; padding:0; cursor:pointer; }
  .ic { display:inline-block; vertical-align:middle; flex:0 0 auto; }
  ::selection { background:var(--sel); color:var(--sel-text); }

  /* ---------- native-app hardening ----------
     A desktop IDE does not behave like a web page: text is not selectable,
     images are not draggable and the scrollbars are the thin PyCharm kind.
     Editable surfaces opt back into native text behaviour. */
  input, textarea, [contenteditable], .selectable, #ta {
    user-select:text; -webkit-user-select:text; cursor:text;
  }
  #hl, #hlCode, #gutter, .glines { user-select:none !important; -webkit-user-select:none !important; }
  *:focus { outline:none; }
  *:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
  img { -webkit-user-drag:none; }
  ::-webkit-scrollbar { width:10px; height:10px; }
  ::-webkit-scrollbar-track { background:transparent; }
  ::-webkit-scrollbar-thumb { background:var(--border); border-radius:5px; border:2px solid transparent; background-clip:padding-box; }
  ::-webkit-scrollbar-thumb:hover { background:var(--text-tertiary); background-clip:padding-box; border:2px solid transparent; }

  /* ---------- shell grid: title / menu / toolbar / work / status ----------
     The self-drawn title bar only exists when the OS chrome is off (Tauri), so
     the row list is per mode. A grid with one row too few shifts every band up
     by one: the toolbar would swallow the work area and the editor would end up
     in the 24px status row — which is invisible in the Edge build, where
     .titlebar is display:none and four rows are exactly right. */
  .ide { display:grid; grid-template-rows:29px 38px minmax(0,1fr) 22px; height:100vh; }
  html[data-tauri="1"] .ide { grid-template-rows:32px 29px 38px minmax(0,1fr) 22px; }

  /* menu bar */
  .menubar { display:flex; align-items:center; gap:1px; padding:0 8px; background:var(--bg-primary);
    border-bottom:1px solid var(--border); font-size:12px; position:relative; z-index:40; }
  .menubar .brand { font-weight:600; color:var(--text-primary); margin-right:9px; letter-spacing:.1px; }
  .menu { padding:3px 7px; border-radius:2px; color:var(--text-secondary); position:relative; }
  .menu:hover, .menu.open { background:var(--bg-hover); color:var(--text-primary); }
  .menubar .spacer { flex:1; }

  /* dropdown popover shared by menus */
  .pop { position:absolute; top:26px; left:0; min-width:230px; background:var(--bg-tertiary);
    border:1px solid var(--border); border-radius:3px; box-shadow:var(--shadow); padding:4px; display:none; z-index:60; }
  .menu.open .pop { display:block; }
  .pop .item { display:flex; align-items:center; gap:10px; width:100%; min-height:25px; text-align:left;
    padding:4px 8px; border-radius:2px; color:var(--text-primary); font-size:12px; }
  .pop .item:hover { background:#4B6EAF; color:#fff; }
  .pop .item .sc { margin-left:auto; color:var(--text-tertiary); font-size:10.5px; }
  .pop .item:hover .sc { color:rgba(255,255,255,.86); }
  .pop .sep { height:1px; background:var(--border); margin:4px 5px; }
  .pop .grp { padding:5px 9px 3px; font-size:10.5px; text-transform:uppercase; letter-spacing:.6px; color:var(--text-tertiary); }

  /* main toolbar */
  .toolbar { display:flex; align-items:center; gap:5px; padding:0 8px; background:var(--bg-toolbar);
    border-bottom:1px solid var(--border); }
  .widget { display:flex; align-items:center; gap:6px; height:26px; padding:0 7px; border-radius:2px;
    border:1px solid var(--border); background:var(--bg-secondary); color:var(--text-primary); font-size:12px; max-width:280px; }
  .widget:hover { background:var(--bg-hover); border-color:var(--text-tertiary); }
  .widget .lbl { color:var(--text-tertiary); }
  .widget .val { font-weight:500; }
  .widget .ic { color:var(--icon-default); }
  .run-group { display:flex; align-items:center; gap:4px; }
  .tbtn { display:flex; align-items:center; gap:6px; height:26px; padding:0 8px; border-radius:2px;
    border:1px solid var(--border); background:var(--bg-secondary); color:var(--text-primary); font-size:12px; }
  .tbtn:hover { background:var(--bg-hover); border-color:var(--text-tertiary); }
  .tbtn.iconly { padding:0 6px; }
  .tbtn .ic { color:var(--icon-default); }
  .tbtn:hover .ic { color:var(--icon-active); }
  .tbtn.primary { background:var(--run-accent,var(--success)); border-color:var(--run-accent,var(--success)); color:#fff; }
  .tbtn.primary .ic { color:#fff; }
  .tbtn.primary:hover { filter:brightness(1.1); border-color:var(--run-accent,var(--success)); }
  .toolbar .spacer { flex:1; }

  /* work area */
  .work { display:flex; min-height:0; }

  /* left tool strip */
  .strip { width:34px; flex:0 0 34px; background:var(--bg-secondary); border-right:1px solid var(--border);
    display:flex; flex-direction:column; align-items:center; padding:4px 0; gap:2px; }
  .strip .sbtn { width:28px; height:30px; border-radius:2px; display:flex; align-items:center; justify-content:center;
    color:var(--icon-default); position:relative; }
  .strip .sbtn:hover { background:var(--bg-hover); color:var(--icon-active); }
  .strip .sbtn.active { color:var(--accent); }
  .strip .sbtn.active::before { content:""; position:absolute; left:-4px; top:6px; bottom:6px; width:2px;
    border-radius:2px; background:var(--accent); }
  .strip .grow { flex:1; }

  /* docked tool window (left) */
  .panel { width:var(--project-width); flex:0 0 var(--project-width); background:var(--bg-primary); border-right:1px solid var(--border);
    display:flex; flex-direction:column; min-width:176px; }
  .panel.hidden { display:none; }
  .ide-splitter { flex:0 0 4px; background:var(--border); touch-action:none; }
  .ide-splitter-v { cursor:col-resize; }
  .ide-splitter:hover, .ide-splitter.dragging { background:var(--accent); }
  .panel.hidden + .ide-splitter { display:none; }
  .panel:not(.hidden) { flex:0 0 var(--project-width); }
  .tw-head { height:30px; flex:0 0 auto; display:flex; align-items:center; gap:3px; padding:0 5px 0 10px;
    background:var(--bg-secondary); border-bottom:1px solid var(--border); font-size:11px; font-weight:600;
    color:var(--text-secondary); letter-spacing:.1px; }
  .tw-head .title { flex:1; text-transform:none; }
  .tw-head .tbtn { width:22px; height:22px; padding:0; justify-content:center; border:0; background:none; border-radius:4px; }
  .tw-head .tbtn:hover { background:var(--bg-hover); }
  .tw-body { flex:1; overflow:auto; min-height:0; }
  .ptree { padding:4px 0; font-size:12.5px; user-select:none; }
  .tnode { display:flex; min-height:22px; align-items:center; gap:5px; padding:1px 7px; cursor:pointer; border-radius:0; color:var(--text-primary); }
  .tnode:hover { background:var(--bg-hover); }
  .tnode.active { background:var(--bg-active); color:var(--sel-text); }
  .tnode .chev { width:14px; height:14px; flex:0 0 auto; display:flex; align-items:center; justify-content:center; color:var(--text-tertiary); }
  .tnode .ic { color:var(--icon-default); flex:0 0 auto; }
  .tnode .nm { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .tnode.ro .nm { color:var(--text-tertiary); font-style:italic; }
  .pempty { padding:6px 14px; color:var(--text-tertiary); font-size:12px; }
  .todo-list { padding:4px 0; font-size:12px; }
  .todo-row { display:grid; grid-template-columns:52px minmax(0,1fr); gap:2px 6px; padding:5px 9px; cursor:pointer; border-left:2px solid transparent; }
  .todo-row:hover { background:var(--bg-hover); }
  .todo-tag { font:11px var(--mono); color:var(--warning); }
  .todo-fixed { color:var(--error); }
  .todo-note { color:var(--text-secondary); }
  .todo-hack { color:var(--accent); }
  .todo-where { color:var(--text-tertiary); font:11px var(--mono); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .todo-text { grid-column:2; color:var(--text-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .ctxmenu { position:fixed; z-index:90; min-width:220px; background:var(--bg-secondary); border:1px solid var(--border); border-radius:6px; padding:4px; box-shadow:0 6px 20px rgba(0,0,0,.35); display:none; }
  .ctxmenu.open { display:block; }
  .ctxmenu .citem { display:flex; align-items:center; justify-content:space-between; gap:18px; padding:5px 10px; border-radius:4px; cursor:pointer; font-size:12.5px; white-space:nowrap; }
  .ctxmenu .citem:hover, .ctxmenu .citem.sel { background:var(--accent); color:#fff; }
  .ctxmenu .citem:hover .csc { color:#eef; }
  .ctxmenu .citem .csc { color:var(--text-tertiary); font-size:11.5px; }
  .ctxmenu .citem.dis { color:var(--text-tertiary); pointer-events:none; }
  .ctxmenu .csep { height:1px; margin:4px 6px; background:var(--border-soft); }

  /* ---------- command palette (nlg run SCRIPT -- ARGS) ---------- */
  .palette { position:fixed; z-index:200; left:50%; top:14%; transform:translateX(-50%);
    width:min(680px, 92vw); background:var(--bg-secondary); border:1px solid var(--border);
    border-radius:8px; box-shadow:0 10px 36px rgba(0,0,0,.4); display:none; overflow:hidden; }
  .palette.open { display:block; }
  .palette .ph { display:flex; align-items:center; gap:8px; padding:8px 10px; border-bottom:1px solid var(--border); }
  .palette .ph .pfx { font-family:var(--mono); color:var(--accent); font-size:13px; }
  .palette input { flex:1; border:none; background:transparent; font-family:var(--mono); font-size:13px; padding:2px 0; }
  .palette input:focus { outline:none; }
  .palette .hint { font-size:11px; color:var(--text-tertiary); padding:0 10px 6px; }
  .palette .out { max-height:38vh; overflow:auto; padding:8px 10px; font-family:var(--mono); font-size:12px;
    white-space:pre-wrap; background:var(--bg-primary); }
  .palette .out .err { color:var(--err); } .palette .out .ok { color:var(--ok); } .palette .out .dim { color:var(--text-tertiary); }

  /* center column */
  .center { flex:1; display:flex; flex-direction:column; min-width:0; background:var(--bg-primary); }

  /* editor tabs */
  .etabs { height:34px; flex:0 0 auto; display:flex; align-items:stretch; gap:0; padding:0;
    background:var(--bg-secondary); border-bottom:1px solid var(--border); overflow-x:auto; }
  .etab { display:flex; align-items:center; gap:7px; height:34px; padding:0 8px 0 10px; border-radius:0;
    border-right:1px solid var(--border); color:var(--text-secondary); font-size:12px; max-width:200px; position:relative; }
  .etab:hover { background:var(--bg-hover); }
  .etab.active { background:var(--bg-editor); color:var(--text-primary); }
  .etab.active::after { content:""; position:absolute; left:0; right:0; bottom:0; height:2px; background:var(--accent); }
  .etab .nm { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .etab .dirty { display:inline-flex; width:7px; height:7px; flex:0 0 7px; align-items:center; justify-content:center; overflow:hidden; color:transparent; font-size:0; line-height:0; }
  .etab .dirty::before { content:""; width:6px; height:6px; border-radius:50%; background:var(--accent); }
  .etab .pin { display:inline-flex; width:12px; height:12px; flex:0 0 12px; align-items:center; justify-content:center; color:var(--text-tertiary); }
  .etab.pinned .nm { font-style:italic; }
  .etab .x { width:16px; height:16px; border-radius:2px; display:none; align-items:center; justify-content:center; color:var(--icon-default); }
  .etab:hover .x, .etab.active .x { display:flex; }
  .etab .x:hover { background:var(--bg-tertiary); color:var(--icon-active); }
  .etabs .more { margin-left:auto; align-self:center; width:24px; height:24px; border-radius:2px; display:flex; align-items:center; justify-content:center; color:var(--icon-default); }
  .etabs .more:hover { background:var(--bg-hover); }

  /* editor: gutter + code overlay */
  .edwrap { flex:1; display:flex; min-height:0; background:var(--bg-editor); position:relative; }
  .gutter { width:56px; flex:0 0 auto; overflow:hidden; background:var(--bg-gutter); position:relative;
    border-right:1px solid var(--border-soft); }
  .gutter .glines { position:absolute; left:0; right:0; top:0; padding:10px 0; will-change:transform; }
  .gline { position:relative; height:20px; display:flex; align-items:center; justify-content:flex-end;
    padding-right:10px; font:12px/20px var(--mono); color:var(--gutter-number); }
  .gline.cur { color:var(--text-primary); }
  .gline .bp { position:absolute; left:7px; top:5px; width:10px; height:10px; border-radius:50%;
    background:var(--error); border:1px solid rgba(0,0,0,.25); cursor:pointer; }
  .gline .bm { position:absolute; left:20px; top:4px; width:0; height:0;
    border-left:6px solid var(--warning); border-top:6px solid transparent; border-bottom:6px solid transparent;
    cursor:pointer; }
  .gline.hasbm .num { color:var(--warning); }
  .gline .fold { position:absolute; left:26px; top:3px; width:14px; height:14px; border-radius:3px;
    display:flex; align-items:center; justify-content:center; color:var(--text-tertiary); opacity:0; cursor:pointer; }
  .gline.foldable:hover .fold { opacity:1; }
  .gline .fold:hover { background:var(--bg-hover); color:var(--icon-active); }
  /* Markdown preview (#40): a right split inside the editor row. edwrap is
     already a flex row, so this is a sibling of codewrap, not a new layout.
     No backticks in this file either: it is one template literal. */
  .mdprev { flex:0 0 var(--mdprev-basis, 42%); min-width:260px; max-width:64%; display:flex; flex-direction:column;
    min-height:0; border-left:1px solid var(--border); background:var(--bg-primary); }
  .mdsplit { display:none; flex:0 0 8px; align-items:center; justify-content:center; cursor:col-resize;
    touch-action:none; outline:none; }
  .mdsplit:not(.hidden) { display:flex; }
  .mdsplit::after { content:''; width:2px; height:28px; border-radius:2px; background:var(--border); }
  .mdsplit:hover::after, .mdsplit:focus-visible::after, .mdsplit.dragging::after { background:var(--accent); height:40px; }
  .mdsplit:focus-visible { box-shadow:inset 0 0 0 1px var(--accent); }
  .edwrap.md-resizing, .edwrap.md-resizing * { cursor:col-resize !important; user-select:none !important; }
  .mdprev.hidden { display:none; }
  .mdprev-head { flex:0 0 auto; height:32px; display:flex; align-items:center; gap:6px;
    padding:0 6px 0 10px; border-bottom:1px solid var(--border); font-size:12px; color:var(--text-secondary); }
  .mdprev-head .title { color:var(--text-primary); font-weight:600; }
  .mdprev-meta { color:var(--text-tertiary); font-size:11px; white-space:nowrap; overflow:hidden;
    text-overflow:ellipsis; }
  .mdprev-head .grow { flex:1; }
  .mdprev-body { flex:1; display:flex; min-height:0; }
  .mdoutline { display:none; flex:0 0 190px; overflow:auto; padding:6px 0;
    border-right:1px solid var(--border-soft); font-size:12px; }
  .mdprev.outline .mdoutline { display:block; }
  .mdoh { padding:3px 10px; cursor:pointer; color:var(--text-secondary); white-space:nowrap;
    overflow:hidden; text-overflow:ellipsis; }
  .mdoh:hover { background:var(--bg-hover); color:var(--text-primary); }
  .mdoh.lv1 { color:var(--text-primary); font-weight:600; }
  .mdoh.lv2 { padding-left:20px; }
  .mdoh.lv3 { padding-left:30px; }
  .mdoh.lv4 { padding-left:40px; }
  .mdoh.lv5 { padding-left:50px; }
  .mdoh.lv6 { padding-left:60px; }
  .mdhtml { flex:1; min-width:0; overflow:auto; padding:12px 18px; color:var(--text-primary);
    font:13px/1.65 var(--sans); }
  .mdhtml .empty, .mdoutline .empty { color:var(--text-tertiary); font-size:12px; padding:8px 10px; }
  .mdhtml h1, .mdhtml h2, .mdhtml h3, .mdhtml h4, .mdhtml h5, .mdhtml h6 { margin:1.1em 0 .5em; line-height:1.3; }
  .mdhtml h1 { font-size:1.7em; border-bottom:1px solid var(--border-soft); padding-bottom:.25em; }
  .mdhtml h2 { font-size:1.4em; border-bottom:1px solid var(--border-soft); padding-bottom:.2em; }
  .mdhtml h3 { font-size:1.18em; }
  .mdhtml p { margin:.6em 0; }
  .mdhtml code { font-family:var(--mono); font-size:.92em; background:var(--bg-tertiary);
    padding:1px 4px; border-radius:3px; }
  .mdhtml pre { background:var(--bg-secondary); border:1px solid var(--border-soft);
    border-radius:5px; padding:10px 12px; overflow:auto; }
  .mdhtml pre code { background:none; padding:0; }
  .mdhtml blockquote { margin:.6em 0; padding:.2em 12px; border-left:3px solid var(--border); color:var(--text-secondary); }
  .mdhtml table { border-collapse:collapse; margin:.7em 0; }
  .mdhtml th, .mdhtml td { border:1px solid var(--border); padding:4px 8px; }
  .mdhtml img { max-width:100%; }
  .mdhtml a { color:var(--accent); }
  .mdhtml ul, .mdhtml ol { margin:.5em 0; padding-left:1.6em; }
  .codewrap { position:relative; flex:1; min-width:0; overflow:hidden; }
  .codewrap pre, .codewrap textarea {
    position:absolute; inset:0; margin:0; padding:10px 14px; border:0;
    font:13px/20px var(--mono); white-space:pre; word-wrap:normal; tab-size:4; }
  .codewrap pre { z-index:1; overflow:auto; color:var(--text-primary); pointer-events:none; }
  .codewrap pre code { font:inherit; }
  .codewrap textarea { z-index:2; overflow:auto; background:transparent; color:transparent;
    caret-color:var(--accent); resize:none; outline:none; }
  .tok-c { color:var(--syn-comment); font-style:italic; }
  .tok-s { color:var(--syn-string); }
  .tok-d { color:var(--syn-deco); }
  .tok-k { color:var(--syn-keyword); }
  .tok-n { color:var(--syn-number); }
  .tok-b { color:var(--syn-const); }
  .tok-f { color:var(--syn-func); }
  .tok-cl { color:var(--syn-class); }
  .curline { position:absolute; left:0; right:0; height:20px; background:var(--current-line); pointer-events:none; display:none; }
  .cmp { position:absolute; z-index:12; min-width:220px; max-width:460px; max-height:220px; overflow:auto;
    background:var(--bg-secondary); border:1px solid var(--border); border-radius:6px;
    box-shadow:0 8px 24px rgba(0,0,0,.4); display:none; padding:3px; }
  .cmp.open { display:block; }
  .cmp .row { display:flex; align-items:center; gap:8px; padding:3px 8px; border-radius:4px; cursor:pointer;
    font:12.5px/18px var(--mono); white-space:nowrap; }
  .cmp .row.sel { background:var(--accent); color:#fff; }
  .cmp .row .k { color:var(--syn-keyword); flex:0 0 auto; width:16px; text-align:center; }
  .cmp .row.sel .k { color:#eef; }
  .cmp .row .d { color:var(--text-tertiary); overflow:hidden; text-overflow:ellipsis; }
  .cmp .row.sel .d { color:#dde; }
  .hover-tip { position:absolute; z-index:13; max-width:520px; max-height:300px; overflow:auto; display:none;
    background:var(--bg-secondary); border:1px solid var(--border); border-radius:6px;
    box-shadow:0 8px 24px rgba(0,0,0,.4); padding:8px 10px; font:12px/1.5 var(--mono);
    color:var(--text-primary); white-space:pre-wrap; }
  .hover-tip.open { display:block; }
  .ritem { display:block; width:100%; text-align:left; padding:7px 10px; border-radius:5px; cursor:pointer;
    background:transparent; border:0; color:var(--text-primary); font:12.5px/1.6 var(--mono); }
  .ritem:hover { background:var(--bg-hover); }

  /* bottom dock */
  .dock { order:2; height:var(--dock-height); flex:0 0 var(--dock-height); background:var(--bg-primary); border-top:1px solid var(--border);
    display:flex; flex-direction:column; min-height:0; }
  .dock.hidden { display:none; }
  .dock-resizer { order:1; flex:0 0 4px; background:var(--border); cursor:row-resize; touch-action:none; }
  .dock-resizer:hover, .dock-resizer.dragging { background:var(--accent); }
  #dock.hidden ~ .dock-resizer { display:none; }
  .edwrap { order:0; }
  .dock-tabs { height:30px; flex:0 0 auto; display:flex; align-items:stretch; gap:0; padding:0 6px;
    background:var(--bg-secondary); border-bottom:1px solid var(--border); }
  .dtab { position:relative; display:flex; align-items:center; gap:6px; height:30px; padding:0 9px; border-radius:0;
    color:var(--text-secondary); font-size:11.5px; }
  .dtab:hover { background:var(--bg-hover); color:var(--text-primary); }
  .dtab.active { color:var(--text-primary); background:transparent; }
  .dtab.active::after { content:""; position:absolute; right:0; bottom:-1px; left:0; height:2px; background:var(--accent); }
  .dtab .ic { color:var(--icon-default); }
  .dtab.active .ic { color:var(--accent); }
  .dock-tabs .spacer { flex:1; }
  .dock-body { flex:1; overflow:auto; min-height:0; padding:8px 12px; }
  .dock-pane { display:none; height:100%; }
  .dock-pane.active { display:block; }

  /* console (run / terminal) */
  .console { font:12px/1.55 var(--mono); white-space:pre-wrap; word-break:break-word; }
  .console .cmd { color:var(--syn-func); }
  .console .err { color:var(--error); }
  .console .ok { color:var(--success); }
  .console .dim { color:var(--text-tertiary); }

  /* interactive terminal */
  .term { display:flex; flex-direction:column; height:100%; font:12px/1.5 var(--mono); }
  .term-out { flex:1; overflow:auto; white-space:pre-wrap; word-break:break-word; padding-bottom:4px; }
  .term-out .err { color:var(--error); }
  .term-out .dim { color:var(--text-tertiary); }
  .term-out .ok { color:var(--success); }
  .term-out .acc { color:var(--accent); }
  .term-line { display:flex; align-items:center; gap:8px; border-top:1px solid var(--border-soft); padding-top:5px; flex:0 0 auto; }
  .term-line .prompt { color:var(--success); flex:0 0 auto; white-space:nowrap; }
  .term-in { flex:1; min-width:0; background:transparent; border:0; outline:none; color:var(--text-primary); font:inherit; caret-color:var(--accent); }

  /* Find in Files (bottom dock) */
  .find-bar { display:flex; align-items:center; gap:6px; margin-bottom:8px; }
  .find-bar input { flex:1; max-width:420px; background:var(--bg-primary); border:1px solid var(--border); border-radius:6px;
    padding:5px 9px; color:var(--text-primary); font:12.5px var(--mono); outline:none; }
  .find-bar input:focus { border-color:var(--accent); }
  .find-out { font-size:12px; }
  .find-out .empty { color:var(--text-tertiary); }
  .fgroup { margin-bottom:10px; }
  .fhead { font-weight:600; color:var(--text-secondary); padding:2px 0; position:sticky; top:0; background:var(--bg-secondary); }
  .fhit { display:flex; gap:8px; padding:2px 6px; border-radius:4px; cursor:default; align-items:baseline; }
  .fhit:hover { background:var(--bg-hover); }
  .fhit .fl { color:var(--text-tertiary); flex:0 0 auto; font:11px var(--mono); }
  .fhit .dim { color:var(--text-tertiary); }

  /* tests (bottom dock) */
  .tests-bar { display:flex; align-items:center; gap:6px; margin-bottom:8px; }
  .tests-bar input { flex:1; max-width:320px; background:var(--bg-primary); border:1px solid var(--border); border-radius:6px;
    padding:5px 9px; color:var(--text-primary); font:12px var(--mono); outline:none; }
  .tests-bar input:focus { border-color:var(--accent); }
  .test-tree { max-height:46%; overflow:auto; border-bottom:1px solid var(--border-soft); padding-bottom:6px; margin-bottom:6px; }
  .test-row { display:flex; align-items:center; gap:6px; padding:3px 4px; border-radius:4px; cursor:pointer; font-size:12.5px; }
  .test-row:hover { background:var(--bg-hover); }
  .test-row .tg { width:14px; flex:0 0 auto; text-align:center; font-weight:600; }
  .test-row.st-pass .tg { color:var(--success); }
  .test-row.st-fail .tg { color:var(--error); }
  .test-row.st-skip .tg { color:var(--text-tertiary); }
  .test-row.st-run .tg { color:var(--accent); }
  .test-row .tn { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .test-row .tm { color:var(--text-tertiary); font:11px var(--mono); flex:0 0 auto; }
  .test-msg { color:var(--text-secondary); font:11.5px var(--mono); padding:1px 6px 1px 24px; cursor:pointer;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .test-msg:hover { background:var(--bg-hover); }
  .test-out { font:12px/1.5 var(--mono); white-space:pre-wrap; word-break:break-word; max-height:60%; overflow:auto; color:var(--text-secondary); }

  /* inlay hints: decoration only, so no pointer events and no layout weight */
  .cm-inlay { pointer-events:none; font:11px var(--mono); color:var(--text-tertiary); opacity:.85;
    user-select:none; -webkit-user-select:none; }
  .cm-inlay-type { font-style:italic; }
  .cm-inlay-param { color:var(--text-secondary); }
  .cm-inlay.pad-l { margin-left:4px; }
  .cm-inlay.pad-r { margin-right:4px; }

  /* problems */
  .prob { display:flex; gap:8px; align-items:flex-start; padding:5px 4px; border-bottom:1px solid var(--border-soft); font-size:12.5px; }
  .prob .ic { margin-top:1px; }
  .prob.error .ic { color:var(--error); }
  .prob.warn .ic { color:var(--warning); }
  .prob .loc { color:var(--text-tertiary); font-family:var(--mono); font-size:11.5px; }
  .prob .msg { flex:1; }
  .empty { color:var(--text-tertiary); font-size:12px; padding:8px 2px; }

  /* performance cards */
  .perf-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:10px; }
  .pcard { border:1px solid var(--border); border-radius:8px; padding:9px 11px; background:var(--bg-secondary); }
  .pcard .nm { font-size:11px; color:var(--text-secondary); text-transform:uppercase; letter-spacing:.4px;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .pcard .big { font:600 19px/1.2 var(--mono); margin:3px 0 5px; }
  .pcard .row { display:flex; justify-content:space-between; font-size:11px; color:var(--text-tertiary); font-family:var(--mono); }
  .spark { display:block; width:100%; height:34px; margin-top:6px; }

  /* logs */
  .logs-toolbar { display:flex; align-items:center; gap:8px; margin-bottom:6px; position:sticky; top:-8px;
    background:var(--bg-primary); padding:4px 0; z-index:2; }
  .logs-toolbar select { background:var(--bg-tertiary); color:var(--text-primary); border:1px solid var(--border);
    border-radius:5px; padding:2px 6px; font-size:12px; }
  .logline { font:12px/1.5 var(--mono); padding:2px 4px; border-radius:4px; display:flex; gap:8px; }
  .logline:hover { background:var(--bg-hover); }
  .logline .t { color:var(--text-tertiary); flex:0 0 auto; }
  .logline .lv { flex:0 0 52px; font-weight:600; }
  .logline .cp { flex:0 0 150px; color:var(--syn-class); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .logline .ms { flex:1; word-break:break-word; }
  .lv-TRACE,.lv-DEBUG { color:var(--text-tertiary); }
  .lv-INFO { color:var(--success); }
  .lv-WARN { color:var(--warning); }
  .lv-ERROR,.lv-FATAL { color:var(--error); }
  .lv-AUDIT,.lv-METRIC { color:var(--accent); }

  /* status bar */
  .status { display:flex; align-items:center; gap:0; background:var(--bg-secondary); border-top:1px solid var(--border);
    font-size:11.5px; color:var(--text-secondary); padding:0 4px; }
  .status .cell { display:flex; align-items:center; gap:5px; padding:0 9px; height:100%; border-radius:4px; white-space:nowrap; }
  .status .cell:hover { background:var(--bg-hover); color:var(--text-primary); }
  /* Only the language-mode cell is a control; the rest are read-only readouts. */
  .status .cell.act { cursor:pointer; }
  .status .cell .ic { color:var(--icon-default); }
  .status .grow { flex:1; }
  .status .mem.ok { color:var(--success); }
  .status .mem.warn { color:var(--warning); }

  /* modal (search everywhere / extensions / about) */
  .scrim { position:fixed; inset:0; background:rgba(0,0,0,.35); display:none; z-index:80; }
  .scrim.open { display:block; }
  .modal { position:fixed; z-index:90; left:50%; top:12%; transform:translateX(-50%); width:min(680px,92vw);
    background:var(--bg-tertiary); border:1px solid var(--border); border-radius:12px; box-shadow:var(--shadow);
    display:none; overflow:hidden; }
  .modal.open { display:block; }
  .modal .mtop { display:flex; align-items:center; gap:10px; padding:12px 14px; border-bottom:1px solid var(--border); }
  .modal .mtop input { flex:1; background:transparent; border:0; outline:none; color:var(--text-primary); font:14px var(--sans); }
  .modal .chips { display:flex; gap:6px; padding:8px 14px; border-bottom:1px solid var(--border); }
  .modal .chip { font-size:11.5px; padding:2px 9px; border-radius:9px; border:1px solid var(--border); color:var(--text-secondary); }
  .modal .chip.on { color:#fff; background:var(--accent); border-color:var(--accent); }
  .modal .mbody { max-height:52vh; overflow:auto; padding:6px; }
  .mres { display:flex; align-items:center; gap:10px; padding:7px 10px; border-radius:6px; cursor:pointer; }
  .mres:hover, .mres.sel { background:var(--accent); color:#fff; }
  .mres .nm { flex:1; }
  .mres .path { color:var(--text-tertiary); font-size:11.5px; font-family:var(--mono); }
  .mres:hover .path, .mres.sel .path { color:rgba(255,255,255,.8); }
  .mres .ic { color:var(--icon-default); }
  .mres:hover .ic, .mres.sel .ic { color:#fff; }
  .mgrp { padding:8px 12px 3px; font-size:10.5px; text-transform:uppercase; letter-spacing:.6px; color:var(--text-tertiary); }

  /* extensions modal list */
  .xrow { border:1px solid var(--border); border-radius:8px; padding:10px 12px; margin-bottom:8px; }
  .xrow .top { display:flex; align-items:center; gap:8px; }
  .xrow .nm { font-weight:600; }
  .xrow .state { margin-left:auto; font-size:11px; padding:1px 8px; border-radius:8px; border:1px solid var(--border); color:var(--text-secondary); }
  .xrow .state.ready { color:var(--success); border-color:var(--success); }
  .xrow .state.crashed { color:var(--error); border-color:var(--error); }
  .xrow .meta { color:var(--text-tertiary); font-size:11.5px; font-family:var(--mono); margin-top:2px; }
  .xrow .cmds { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
  .xrow .cmds button { font-size:11.5px; padding:3px 9px; border:1px solid var(--border); border-radius:5px; }
  .xrow .cmds button:hover { border-color:var(--accent); color:var(--accent); }

  .toast { position:fixed; left:50%; bottom:36px; transform:translateX(-50%); background:var(--bg-tertiary);
    border:1px solid var(--border); border-radius:8px; padding:8px 14px; font-size:12.5px; box-shadow:var(--shadow);
    opacity:0; transition:opacity .18s; pointer-events:none; z-index:120; }
  .toast.show { opacity:1; }

  /* PyCharm-style dialog (one component behind every modal in the shell) */
  .dlg-scrim { position:fixed; inset:0; background:rgba(0,0,0,.42); z-index:130; display:flex;
    align-items:center; justify-content:center; padding:24px; }
  .dlg { width:min(460px,94vw); background:var(--bg-secondary); border:1px solid var(--border);
    border-radius:10px; box-shadow:0 12px 40px rgba(0,0,0,.5); overflow:hidden; }
  .dlg-title { display:flex; align-items:center; gap:8px; padding:10px 14px; font-size:13px; font-weight:600;
    border-bottom:1px solid var(--border-soft); }
  .dlg-body { padding:14px; display:flex; flex-direction:column; gap:10px; max-height:56vh; overflow:auto; }
  .dlg-msg { font-size:12.5px; line-height:1.6; color:var(--text-primary); }
  .dlg-msg .sub { color:var(--text-secondary); }
  .dlg-list { border:1px solid var(--border-soft); border-radius:6px; max-height:180px; overflow:auto; }
  .dlg-list .row { display:flex; align-items:center; gap:8px; padding:5px 10px; font-size:12px; }
  .dlg-list .row + .row { border-top:1px solid var(--border-soft); }
  .dlg-list .row .nm { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .dlg-field { display:flex; flex-direction:column; gap:4px; }
  .dlg-field label { font-size:11.5px; color:var(--text-secondary); }
  .dlg-field input { background:var(--bg-primary); border:1px solid var(--border); border-radius:6px;
    padding:6px 9px; color:var(--text-primary); font:12.5px var(--mono); outline:none; }
  .dlg-field input:focus { border-color:var(--accent); }
  .dlg-field .err { font-size:11px; color:var(--error); min-height:13px; }
  .dlg-check { display:flex; align-items:center; gap:7px; font-size:12px; color:var(--text-secondary); }
  .dlg-radios { display:flex; flex-direction:column; gap:4px; margin:2px 0 4px; max-height:240px; overflow:auto; }
  .dlg-radios .dlg-check { font-family:var(--mono); font-size:11.5px; }
  .dlg-detail { background:var(--bg-primary); border:1px solid var(--border-soft); border-radius:6px;
    padding:8px 10px; font:11.5px/1.5 var(--mono); white-space:pre-wrap; max-height:180px; overflow:auto; }
  .dlg-foot { display:flex; justify-content:flex-end; gap:8px; padding:10px 14px; border-top:1px solid var(--border-soft); }
  .dlg-btn { height:26px; padding:0 14px; border-radius:6px; border:1px solid var(--border);
    background:var(--bg-tertiary); color:var(--text-primary); font-size:12px; cursor:default; }
  .dlg-btn:hover { border-color:var(--accent); }
  .dlg-btn.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  .dlg-btn.danger { background:var(--error); border-color:var(--error); color:#fff; }
  .dlg-btn:disabled { opacity:.45; }

  /* PyCharm-style Settings: category tree + one page of real preferences */
  .dlg.settings-dlg { width:min(880px,96vw); }
  .dlg.settings-dlg .dlg-body { display:block; padding:0; max-height:none; overflow:hidden; }
  .set-body { display:flex; height:min(560px,68vh); min-height:360px; }
  .set-side { width:218px; flex:none; background:var(--bg-primary); border-right:1px solid var(--border-soft);
    padding:10px 8px; overflow:auto; display:flex; flex-direction:column; gap:8px; }
  .set-search { width:100%; background:var(--bg-secondary); border:1px solid var(--border); border-radius:5px;
    color:var(--text-primary); padding:6px 8px; font:12px var(--sans); outline:none; }
  .set-search:focus { border-color:var(--accent); }
  .set-tree { display:flex; flex-direction:column; gap:2px; }
  .set-cat { display:flex; align-items:center; gap:8px; width:100%; height:28px; padding:0 9px; border:0;
    border-radius:4px; background:transparent; color:var(--text-secondary); font:12px var(--sans);
    text-align:left; cursor:default; }
  .set-cat:hover { background:var(--bg-tertiary); }
  .set-cat.active { background:var(--bg-tertiary); color:var(--text-primary); font-weight:600; }
  .set-empty { padding:10px 8px; font-size:11.5px; color:var(--text-tertiary); }
  .set-main { flex:1; overflow:auto; padding:14px 18px; }
  .set-page h3 { margin:0 0 2px; font-size:14px; font-weight:600; }
  .set-note { margin:0 0 10px; font-size:11.5px; line-height:1.5; color:var(--text-secondary); }
  .set-row { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:8px 0;
    border-bottom:1px solid var(--border-soft); font-size:12px; }
  .set-label { display:flex; flex-direction:column; gap:2px; color:var(--text-primary); }
  .set-label small { color:var(--text-tertiary); font-size:11px; }
  .set-row input[type=checkbox] { accent-color:var(--accent); width:14px; height:14px; }
  .set-row select, .set-row input[type=number] { width:168px; background:var(--bg-primary);
    border:1px solid var(--border); border-radius:5px; color:var(--text-primary); padding:5px 7px;
    font:12px var(--sans); outline:none; }
  .set-row select:focus, .set-row input[type=number]:focus { border-color:var(--accent); }
  .set-action { display:flex; gap:8px; margin-top:12px; }
  .set-action button { height:26px; padding:0 12px; border:1px solid var(--border); border-radius:5px;
    background:var(--bg-tertiary); color:var(--text-primary); font:12px var(--sans); cursor:default; }
  .set-action button:hover { border-color:var(--accent); }

  /* PyCharm balloon (bottom-right, never a page toast) */
  #balloons { position:fixed; right:14px; bottom:30px; z-index:140; display:flex; flex-direction:column-reverse;
    gap:8px; pointer-events:none; }
  .balloon { pointer-events:auto; display:flex; gap:9px; align-items:flex-start; min-width:260px; max-width:380px;
    background:var(--bg-secondary); border:1px solid var(--border); border-left:3px solid var(--accent);
    border-radius:8px; padding:9px 11px; box-shadow:0 6px 20px rgba(0,0,0,.35); }
  .balloon.warning { border-left-color:var(--warn, #e2b93d); }
  .balloon.error { border-left-color:var(--error); }
  .balloon.success { border-left-color:#4ec9b0; }
  .balloon .bt { font-size:12.5px; font-weight:600; }
  .balloon .bm { font-size:11.5px; color:var(--text-secondary); line-height:1.5; }
  .balloon .ba { display:flex; gap:10px; margin-top:4px; }
  .balloon .ba a { font-size:11.5px; color:var(--accent); cursor:pointer; }
  .balloon .bx { margin-left:auto; color:var(--text-tertiary); cursor:pointer; font-size:13px; line-height:1; }

  /* inline rename (project tree / tabs) — PyCharm renames in place */
  .inline-rename { background:var(--bg-primary); border:1px solid var(--accent); border-radius:4px;
    color:var(--text-primary); font:12.5px var(--mono); padding:1px 4px; outline:none; width:100%; min-width:60px; }
  /* self-drawn dropdown (replaces <select>) */
  .dd { display:inline-flex; align-items:center; gap:5px; height:22px; padding:0 7px; border-radius:5px;
    border:1px solid var(--border); background:var(--bg-primary); color:var(--text-primary); font-size:11.5px; }
  .dd:hover { border-color:var(--accent); }
  .dd .ic { color:var(--text-tertiary); }
  /* self-drawn title bar (Tauri only — OS chrome is off) */
  .titlebar { display:none; height:32px; flex:0 0 auto; align-items:center; gap:6px; padding:0 2px 0 10px;
    background:var(--bg-secondary); border-bottom:1px solid var(--border); -webkit-app-region:drag; user-select:none; }
  html[data-tauri="1"] .titlebar { display:flex; }
  .titlebar .tb-title { display:flex; align-items:center; gap:6px; font-size:12px; color:var(--text-secondary); }
  .titlebar .tb-spacer { flex:1; -webkit-app-region:drag; }
  .titlebar .tb-btn { -webkit-app-region:no-drag; width:38px; height:26px; border:none; background:transparent;
    color:var(--text-secondary); display:flex; align-items:center; justify-content:center; cursor:default; }
  .titlebar .tb-btn:hover { background:var(--bg-hover); }
  .titlebar .tb-close:hover { background:var(--error); color:#fff; }
  /* transient status-bar hint (save feedback) */
  .status .cell.hint { color:var(--text-tertiary); opacity:0; transition:opacity .15s; }
  .status .cell.hint.on { opacity:1; color:var(--accent); }
  /* crash-recovery copy: only present while a draft actually exists, so the row
     never shows an empty cell that suggests something is being written */
  .status .cell.draft { display:none; color:var(--warning); }
  .status .cell.draft.on { display:flex; }

  /* ---------- MCP tool window ---------- */
  .mcp { display:flex; flex-direction:column; gap:8px; padding:10px; font-size:12.5px; }
  .mcp-head { display:flex; align-items:center; gap:6px; }
  .mcp-title { flex:1; font-size:11px; font-weight:600; letter-spacing:.04em; text-transform:uppercase; color:var(--text-secondary); }
  .mcp-cfg { font:11px var(--mono); color:var(--text-tertiary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:copy; }
  .mcp-cfg:hover { color:var(--text-secondary); }
  .mcp-card { display:flex; flex-direction:column; gap:5px; padding:8px; border:1px solid var(--border);
    border-radius:8px; background:var(--bg-secondary); }
  .mcp-row { display:flex; align-items:center; gap:6px; }
  .mcp-state { margin-right:auto; font-size:11px; color:var(--text-tertiary); }
  .mcp-dot { flex:0 0 auto; width:8px; height:8px; border-radius:50%; background:var(--text-tertiary); }
  .mcp-dot.ok { background:var(--success); }
  .mcp-dot.warn { background:var(--warning); }
  .mcp-dot.err { background:var(--error); }
  .mcp-dot.off { background:var(--border); }
  .mcp-cmd { font:11px var(--mono); color:var(--text-tertiary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .mcp-desc { font-size:11px; color:var(--text-tertiary); }
  .mcp-err { font-size:11px; color:var(--error); }
  .mcp-tools { display:flex; flex-wrap:wrap; gap:4px; }
  .mcp-tool { font:11px var(--mono); padding:2px 8px; border:1px solid var(--border); border-radius:999px;
    background:var(--bg-primary); color:var(--text-secondary); cursor:pointer; }
  .mcp-tool:hover { background:var(--bg-hover); color:var(--text-primary); }
  .mcp-out { margin:2px 0 0; padding:8px; max-height:220px; overflow:auto; white-space:pre-wrap;
    border:1px solid var(--border); border-radius:8px; background:var(--bg-primary);
    font:11px var(--mono); color:var(--text-secondary); }

  /* ---------- Packages tool window ---------- */
  .pkgs { display:flex; flex-direction:column; gap:8px; padding:10px; font-size:12.5px; min-height:0; }
  .pkgs-head { display:flex; align-items:center; gap:6px; }
  .pkgs-title { flex:1; font-size:11px; font-weight:600; letter-spacing:.04em; text-transform:uppercase; color:var(--text-secondary); }
  .pkgs-file { font:11px var(--mono); color:var(--text-tertiary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .pkgs-install { display:flex; align-items:center; gap:6px; }
  .pkgs-install input { flex:1; min-width:0; padding:4px 8px; border:1px solid var(--border); border-radius:6px;
    background:var(--bg-primary); color:var(--text-primary); font:12px var(--mono); }
  .pkgs-install input:focus { outline:none; border-color:var(--accent); }
  .pkgs-note { font-size:11px; color:var(--text-tertiary); }
  .pkgs-note.warn { color:var(--warning); }
  .pkgs-list { display:flex; flex-direction:column; gap:2px; max-height:200px; overflow:auto; }
  .pkgs-row { display:flex; align-items:baseline; gap:6px; padding:2px 4px; border-radius:4px; font:12px var(--mono); }
  .pkgs-row:hover { background:var(--bg-hover); }
  .pkgs-row b { font-weight:500; color:var(--text-primary); }
  .pkgs-ver { color:var(--text-tertiary); font-size:11px; }
  .pkgs-tag { margin-left:auto; font-size:10px; text-transform:uppercase; letter-spacing:.04em; color:var(--warning); }
  .pkgs-out { margin:0; padding:8px; flex:1; min-height:60px; overflow:auto; white-space:pre-wrap;
    border:1px solid var(--border); border-radius:8px; background:var(--bg-primary);
    font:11px var(--mono); color:var(--text-secondary); }

  /* ---------- commit / VCS ---------- */
  .commit-pane { display:flex; flex-direction:column; gap:8px; padding:10px; height:100%; }
  .commit-pane textarea { flex:1; min-height:90px; resize:none; background:var(--bg-secondary);
    color:var(--text-primary); border:1px solid var(--border); border-radius:8px; padding:8px;
    font:12px var(--sans); outline:none; }
  .commit-pane textarea:focus { border-color:var(--accent); }
  .commit-actions { display:flex; gap:8px; }
  .commit-actions .tbtn { flex:1; justify-content:center; }
  .commit-branch { font-size:11.5px; color:var(--text-secondary); }
  .git-list { flex:1; min-height:40px; overflow:auto; display:flex; flex-direction:column; gap:1px; }
  .git-row { display:flex; gap:6px; align-items:baseline; font:11px var(--mono); padding:1px 2px; }
  .git-row:hover { background:var(--bg-hover); }
  .git-st { flex:0 0 auto; color:var(--text-tertiary); letter-spacing:.06em; }
  .git-st.new { color:var(--success); }
  .git-st.del { color:var(--error); }
  .git-st.mod { color:var(--warning); }
  .git-path { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text-secondary); }
  .git-err { color:var(--error); font-size:11.5px; line-height:1.5; }

  /* ---------- debug toolbar (Run dock) ---------- */
  .dbg-bar { display:none; align-items:center; gap:6px; padding:4px 8px;
    border-bottom:1px solid var(--border); background:var(--bg-secondary); }
  .dbg-bar .dbg-state { font:11px var(--mono); color:var(--accent); margin-right:4px; }
  .dbg-bar .tbtn { padding:1px 8px; font-size:11.5px; }

  /* ---------- coverage marks ---------- */
  .gline.covmiss .num { color:var(--error); font-weight:600; }
  .gline.covhit .num { color:var(--success); }
  .CodeMirror .covmiss { background:rgba(224,90,90,.15); }
  .CodeMirror .covhit { background:rgba(78,201,176,.10); }

  /* ---------- breakpoints in the CodeMirror gutter ----------
     While CodeMirror is active the app's own #gutter is hidden, so breakpoint
     dots and the toggle live in a dedicated CM gutter column instead. The dot
     element is a plain .bp span handed to setGutterMarker. */
  .CodeMirror-gutter.bp-gutter { width:16px; text-align:center; cursor:pointer; }
  .CodeMirror-gutter-elt .bp { display:inline-block; width:9px; height:9px; border-radius:50%;
    background:var(--error); border:1px solid rgba(0,0,0,.25); vertical-align:middle; cursor:pointer; }
  .CodeMirror-gutter.bm-gutter { width:16px; text-align:center; cursor:pointer; }
  .CodeMirror-gutter-elt .bm { display:inline-block; width:0; height:0;
    border-left:6px solid var(--warning); border-top:6px solid transparent; border-bottom:6px solid transparent;
    vertical-align:middle; cursor:pointer; }
  .CodeMirror-linenumber { cursor:pointer; }

  /* ---------- diagnostics: squiggly underline + gutter tint ---------- */
  .CodeMirror .diag-sq { text-decoration: underline wavy; text-underline-position: under;
    text-decoration-skip-ink: none; text-decoration-thickness: 1px; }
  .CodeMirror .diag-s1 { text-decoration-color: var(--error); }
  .CodeMirror .diag-s2 { text-decoration-color: var(--warning); }
  .CodeMirror .diag-s3 { text-decoration-color: var(--text-tertiary); }
  .CodeMirror .diag-g1 { background: rgba(219,92,92,.20); }
  .CodeMirror .diag-g2 { background: rgba(214,165,69,.18); }
  .CodeMirror .diag-g3 { background: rgba(255,255,255,.05); }
  /* textarea fallback (no CodeMirror): colour the line number + tint the gutter */
  .gline.haserr { background: rgba(219,92,92,.10); }
  .gline.haswarn { background: rgba(214,165,69,.10); }
  .gline.haserr .num { color: var(--error); font-weight:600; }
  .gline.haswarn .num { color: var(--warning); font-weight:600; }
  .gline.hasinfo .num { color: var(--text-tertiary); }

  /* ---------- Highlight Usages in File ---------- */
  .CodeMirror .usage-mark { background: rgba(152,118,170,.24); border-radius:2px; }
  .gline.hasusage { background: rgba(152,118,170,.12); }
  .gline.hasusage .num { color: var(--accent); }
  .prob { cursor:pointer; }
  .prob:hover { background: var(--bg-hover); }

  /* ---------- Debug window: frames / variables / watches ---------- */
  .dbg-wrap { display:flex; flex:1; min-height:0; gap:1px; background:var(--border-soft); }
  .dbg-col { flex:1 1 0; min-width:0; display:flex; flex-direction:column; background:var(--bg-secondary); }
  .dbg-h { padding:5px 8px; font-size:11px; font-weight:600; color:var(--text-secondary);
    border-bottom:1px solid var(--border-soft); background:var(--bg-tertiary); }
  .dbg-list { flex:1; overflow:auto; font:12px/1.6 var(--mono); }
  .dbg-row { display:flex; gap:8px; align-items:baseline; padding:2px 8px; white-space:nowrap; }
  .dbg-row:hover { background:var(--bg-hover); }
  .dbg-row .vn { color:var(--syn-func, var(--text-primary)); flex:0 0 auto; }
  .dbg-row .vv { color:var(--text-secondary); flex:1 1 auto; overflow:hidden; text-overflow:ellipsis; }
  .dbg-frame { cursor:pointer; }
  .dbg-frame.cur { background:rgba(53,116,240,.16); }
  .dbg-frame .fn { color:var(--text-primary); }
  .dbg-frame .fl { color:var(--text-tertiary); }
  .dbg-scope { padding:3px 8px; font-size:11px; font-weight:600; color:var(--text-tertiary); }
  .dbg-var.expandable { cursor:pointer; }
  .dbg-var .vt { flex:0 0 12px; color:var(--text-tertiary); }
  .dbg-watch .vx { flex:0 0 auto; color:var(--text-tertiary); cursor:pointer; }
  .dbg-watch .vx:hover { color:var(--error); }
  .dbg-eval { display:flex; gap:4px; padding:5px 6px; border-bottom:1px solid var(--border-soft); }
  .dbg-eval input { flex:1; min-width:0; background:var(--bg-tertiary); color:var(--text-primary);
    border:1px solid var(--border); border-radius:4px; padding:2px 6px; font:12px var(--mono); }
  .dbg-console { flex:0 0 38%; border-top:1px solid var(--border-soft); overflow:auto; }
  .dbg-evalrow .vn { color:var(--text-tertiary); }

  /* ---------- the line the program is stopped on ---------- */
  .CodeMirror .dbgcur { background:rgba(53,116,240,.22); }
  .CodeMirror .CodeMirror-gutter.dbgcur { background:rgba(53,116,240,.35); }
  .gline.dbgcur { background:rgba(53,116,240,.22); }
  .gline.dbgcur .num { color:#fff; font-weight:700; }

  /* ---------- kernel flame graph window ---------- */
  .flame-win { position:fixed; z-index:95; left:50%; top:10%; transform:translateX(-50%);
    width:min(980px,94vw); height:min(760px,88vh); display:none; flex-direction:column;
    background:var(--bg-primary); border:1px solid var(--border); border-radius:10px;
    box-shadow:0 18px 48px rgba(0,0,0,.45); overflow:hidden; }
  .flame-win.open { display:flex; }
  .flame-head { display:flex; align-items:center; gap:8px; padding:7px 10px;
    border-bottom:1px solid var(--border); background:var(--bg-secondary); cursor:move; user-select:none; }
  .flame-head b { font-size:12.5px; font-weight:600; }
  .flame-meta { font:11px var(--mono); color:var(--text-tertiary); }
  /* Chart on top, hotspots underneath. A right-hand column looked fine at
     980px but was clipped as soon as the window (or a narrow display) shrank,
     so the two regions stack instead of competing for width. */
  .flame-body { flex:1; display:flex; flex-direction:column; min-height:0; }
  .flame-chart { flex:1 1 auto; min-height:0; position:relative; overflow:auto; padding:8px;
    background:var(--bg-primary); font:11px var(--mono); }
  /* memory trend between the flame and the hotspots */
  .flame-mem { flex:0 0 auto; height:150px; border-top:1px solid var(--border);
    display:flex; flex-direction:column; min-height:0; background:var(--bg-primary); }
  .flame-mem-head { display:flex; justify-content:space-between; align-items:baseline;
    font-size:10.5px; text-transform:uppercase; letter-spacing:.05em;
    color:var(--text-secondary); padding:5px 10px 2px; }
  .flame-mem-top { text-transform:none; letter-spacing:0; font:10.5px var(--mono);
    color:var(--accent); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .flame-mem-chart { flex:1; min-height:0; overflow:hidden; }
  .flame-mem-chart svg { display:block; width:100%; height:100%; }
  .flame-mem-chart .empty { padding:12px; }
  .flame-mem-legend { display:flex; flex-wrap:wrap; gap:1px 12px; padding:2px 10px 5px;
    font:10px var(--mono); color:var(--text-tertiary); max-height:32px; overflow:hidden; }
  .flame-mem-legend i { display:inline-block; width:9px; height:2px; margin-right:4px;
    vertical-align:middle; }
  .flame-side { flex:0 0 auto; max-height:180px; border-top:1px solid var(--border);
    display:flex; flex-direction:column; min-height:0; background:var(--bg-secondary); }
  .flame-side-title { font-size:10.5px; text-transform:uppercase; letter-spacing:.05em;
    color:var(--text-secondary); padding:6px 10px 3px; }
  .flame-hot { flex:1; overflow:auto; padding:0 8px 6px; display:grid;
    grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:1px 10px; align-content:start; }
  .flame-hot-row { display:flex; flex-direction:column; gap:0; padding:2px 4px; border-radius:5px; cursor:default; }
  .flame-hot-row:hover { background:var(--bg-hover); }
  .flame-hot-name { font:11px var(--mono); color:var(--text-primary); overflow:hidden;
    text-overflow:ellipsis; white-space:nowrap; }
  .flame-hot-meta { font:10px var(--mono); color:var(--text-tertiary); overflow:hidden;
    text-overflow:ellipsis; white-space:nowrap; }
  .flame-note { font-size:10.5px; color:var(--text-tertiary); line-height:1.45;
    padding:3px 10px 6px; border-top:1px solid var(--border); }
  .fnode { position:absolute; height:16px; line-height:16px; font:10.5px var(--mono);
    padding:0 3px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis;
    border-radius:2px; border:1px solid rgba(0,0,0,.18); cursor:default; }
  .fnode.k-js { background:#3a6ea5; color:#eaf2fb; }
  .fnode.k-native { background:#5b4a8a; color:#efeafb; }
  .fnode.k-idle { background:#3b3f45; color:#9aa0a6; }
  .fnode.k-gc { background:#8a5a2b; color:#fbeee2; }
  .fnode.k-kernel { background:#2f7d6b; color:#e6fbf5; }
  .fnode:hover { outline:1px solid #fff; }
  /* In-editor find & replace (Ctrl+F / Ctrl+H). Floats over the editor so the
     caret and the match stay visible, the way PyCharm's bar does. */
  .findbar { position:fixed; right:26px; top:86px; z-index:70; display:none;
    align-items:center; gap:4px; padding:5px 6px; border-radius:6px;
    background:var(--bg-secondary); border:1px solid var(--border);
    box-shadow:0 6px 22px rgba(0,0,0,.28); }
  .findbar.open { display:flex; }
  .findbar input { height:22px; padding:0 6px; font:12px var(--mono); color:var(--text-primary);
    background:var(--bg-primary); border:1px solid var(--border); border-radius:4px; outline:none; }
  .findbar input:focus { border-color:var(--accent); }
  .findbar .fb-in { width:150px; }
  .findbar .fb-rep { width:130px; display:none; }
  .findbar.replace .fb-rep { display:block; }
  .findbar .fb-count { font:11px var(--mono); color:var(--text-tertiary); min-width:52px; text-align:center; }
  .findbar .fb-opt { display:flex; align-items:center; gap:2px; font:11px var(--ui); color:var(--text-secondary); cursor:pointer; }
  .findbar .fb-opt input { width:13px; height:13px; margin:0; accent-color:var(--accent); }
  .findbar .fb-btn { height:22px; min-width:22px; padding:0 6px; font:11px var(--ui);
    color:var(--text-secondary); background:transparent; border:1px solid transparent;
    border-radius:4px; cursor:pointer; }
  .findbar .fb-btn:hover { background:var(--bg-hover); color:var(--text-primary); }
  .findbar .fb-btn[data-a="all"], .findbar .fb-btn[data-a="rep"] { display:none; }
  .findbar.replace .fb-btn[data-a="all"], .findbar.replace .fb-btn[data-a="rep"] { display:inline-block; }

  /* ---------- compact Darcula reference fit ---------- */
  button, .menu, .tnode, .etab, .dtab, .status .cell { transition:var(--ui-transition); }
  .toolbar .tbtn, .toolbar .widget, .tw-head .tbtn, .etab .x, .dock-tabs .tbtn { border-radius:2px; }
  .menu .pop, .ctxmenu, .cmp, .hover-tip, .palette, .modal, .dlg, .findbar,
  .pcard, .xrow, .dd, .mcp-card, .pkgs-out, .mcp-out { border-radius:3px; }
  .pop .item, .ctxmenu .citem, .mres, .ritem, .dtab, .tnode { border-radius:2px; }
  .chip { border-radius:2px !important; }
  .modal .chip.on { color:var(--text-primary); background:var(--bg-active); border-color:var(--accent); }
  .mres:hover, .mres.sel, .ctxmenu .citem:hover { background:#4B6EAF; color:#fff; }
  .etab.active::after { left:0; right:0; bottom:0; top:auto; border-radius:0; }
  .etab.active .dirty::before { background:var(--accent); }
  .curline { background:var(--current-line); }
  .theme-glyph { display:none; }
  html[data-theme="darcula"] .theme-glyph-sun,
  html[data-theme="light"] .theme-glyph-moon { display:inline-block; }
  .ide-splitter-v:focus-visible, .dock-resizer:focus-visible { outline:1px solid var(--accent); outline-offset:-1px; }
  .resize-col, .resize-col * { cursor:col-resize !important; user-select:none !important; }
  .resize-row, .resize-row * { cursor:row-resize !important; user-select:none !important; }
  .search-keys { color:var(--text-tertiary); font:10px var(--mono); }

  /* ---------- reference layout: search box, project tabs, breadcrumbs, badges ---------- */
  .toolbar__search { gap:7px; }
  .toolbar__search .lbl { color:var(--text-secondary); font-size:11.5px; }
  .toolbar__search .kbd { margin-left:10px; padding:1px 5px; border:1px solid var(--border);
    border-radius:2px; font:10px var(--mono); color:var(--text-tertiary); }
  .toolbar__search:hover .lbl, .toolbar__search:hover .ic { color:var(--text-primary); }
  .assistant-mark { display:inline-flex; align-items:center; justify-content:center;
    min-width:20px; height:18px; padding:0 3px; border-radius:2px; font:600 10px var(--sans);
    letter-spacing:.4px; color:var(--accent); background:var(--bg-tertiary); }
  .tw-head .tw-tab { height:30px; padding:0 9px; color:var(--text-secondary); font-size:11.5px;
    border-bottom:2px solid transparent; border-radius:0; }
  .tw-head .tw-tab:hover { color:var(--text-primary); }
  .tw-head .tw-tab.is-active { color:var(--text-primary); border-bottom-color:var(--accent); }
  .tw-head .tw-tab.is-active + .tw-tab { border-bottom-color:transparent; }

  .breadcrumbs { height:24px; flex:0 0 24px; display:flex; align-items:center; gap:1px; padding:0 10px;
    background:var(--bg-editor); border-bottom:1px solid var(--border-soft); color:var(--text-tertiary);
    font-size:11.5px; white-space:nowrap; overflow:hidden; }
  .breadcrumbs:empty { display:none; }
  .breadcrumbs .crumb { background:none; border:0; padding:1px 3px; font:inherit; color:var(--text-secondary);
    border-radius:2px; cursor:pointer; max-width:220px; overflow:hidden; text-overflow:ellipsis; }
  .breadcrumbs .crumb:hover, .breadcrumbs .crumb:focus-visible { background:var(--sel-bg); color:var(--text-primary); outline:none; }
  .breadcrumbs .crumb:last-of-type { color:var(--text-primary); }
  .breadcrumbs .crumb--symbol { color:var(--accent); }
  .breadcrumbs .crumb-sep { display:inline-flex; color:var(--text-tertiary); opacity:.75; margin:0 1px; }
  .breadcrumbs .crumb-sep svg { width:12px; height:12px; }

  .file-badge { display:inline-flex; align-items:center; justify-content:center; flex:0 0 auto;
    width:16px; height:16px; border-radius:2px; font:600 8px var(--mono); letter-spacing:-.3px; color:#fff; }
  .file-badge--py { background:#2B6C8F; } .file-badge--java { background:#B23A3A; }
  .file-badge--yaml { background:#8B5FA8; } .file-badge--xml { background:#B07A2A; }
  .file-badge--md { background:#6E7378; } .file-badge--js { background:#B79A2A; color:#2B2B2B; }
  .file-badge--go { background:#2C8C99; } .file-badge--rs { background:#9C6B4F; }
  .file-badge--c, .file-badge--cpp { background:#4563A8; }
  .file-badge--generic { background:#5A6066; }

  .minimap { width:58px; flex:0 0 58px; height:100%; overflow:hidden; position:relative;
    background:var(--bg-editor); border-left:1px solid var(--border-soft); cursor:pointer; padding:8px 5px; }
  .minimap__lines { display:flex; flex-direction:column; gap:1px; opacity:.62; }
  .minimap__line { display:block; height:2px; border-radius:1px; background:var(--text-tertiary); }
  .minimap__line--kw { background:var(--syn-keyword); }
  .minimap__line--str { background:var(--syn-string); }
  .minimap__line--fn { background:var(--syn-func); }
  .minimap__line--comment { background:var(--syn-comment); }
  .minimap:hover .minimap__lines { opacity:.9; }
  .minimap__viewport { position:absolute; left:0; right:0; top:0; height:14%;
    background:rgba(255,255,255,.05); border:1px solid var(--border); pointer-events:none; }

  /* ---------- AI assistant panel (Alt+A) ---------- */
  /* The panel streams plain text into a <div>: no markup is ever interpreted. */
  .ai-wrap { padding:10px; display:flex; flex-direction:column; gap:8px; min-height:0; flex:1; }
  .ai-head { display:flex; align-items:center; gap:6px; font-size:11.5px; }
  .ai-head #aiState { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .ai-cfg { display:flex; flex-direction:column; gap:6px; padding:8px; border:1px solid var(--border);
    border-radius:4px; background:var(--bg-secondary); }
  .ai-cfg.hidden { display:none; }
  .ai-cfg input { background:var(--bg-primary); border:1px solid var(--border); border-radius:4px;
    padding:4px 6px; color:var(--text-primary); font:12px var(--mono); }
  .ai-cfg-row { display:flex; align-items:center; gap:8px; }
  .ai-cfg-row .dim { font-size:10.5px; }
  .ai-row { display:flex; gap:6px; }
  .ai-row input { flex:1; min-width:0; background:var(--bg-secondary); border:1px solid var(--border);
    border-radius:6px; padding:6px 8px; color:var(--text-primary); }
  #aiOut { flex:1; min-height:80px; overflow:auto; white-space:pre-wrap; word-break:break-word;
    border:1px solid var(--border); border-radius:4px; padding:6px; font-size:12px; }
  #aiOut.ai-answer { color:var(--text-primary); }
  /* ---------- reference layout: right AI Assistant drawer ---------- */
  .assistant-drawer { width:var(--right-width,220px); flex:0 0 var(--right-width,220px);
    display:flex; flex-direction:column; min-width:0; background:var(--bg-primary);
    border-left:1px solid var(--border); }
  .assistant-drawer.hidden { display:none; }
  .assistant-head { height:30px; flex:0 0 30px; display:flex; align-items:center; gap:7px; padding:0 6px 0 10px;
    background:var(--bg-secondary); border-bottom:1px solid var(--border); font-size:11.5px; font-weight:600; }
  .assistant-head .grow { flex:1; }
  .assistant-title { color:var(--text-primary); }
  .assistant-messages { flex:1; overflow:auto; padding:10px; display:flex; flex-direction:column; gap:9px; }
  .amsg { max-width:92%; padding:6px 8px; border-radius:3px; font-size:12px; line-height:1.45;
    color:var(--text-primary); white-space:pre-wrap; word-break:break-word; }
  .amsg--user { align-self:flex-end; background:var(--bg-tertiary); }
  .amsg--ai { align-self:flex-start; background:var(--bg-secondary); border:1px solid var(--border); }
  .amsg__role { display:block; margin-bottom:3px; font-size:10px; font-weight:600; text-transform:uppercase;
    letter-spacing:.4px; color:var(--accent); }
  .amsg code { font:11px var(--mono); color:var(--syn-string); }
  .assistant-compose { flex:0 0 auto; display:flex; align-items:center; gap:5px; padding:7px;
    border-top:1px solid var(--border); background:var(--bg-secondary); }
  .assistant-input { flex:1; min-width:0; height:26px; padding:0 7px; border:1px solid var(--border);
    border-radius:2px; background:var(--bg-editor); color:var(--text-primary); font:12px var(--sans); user-select:text; }
  .assistant-input::placeholder { color:var(--text-tertiary); }
  .assistant-send { width:26px; height:26px; flex:0 0 26px; display:flex; align-items:center; justify-content:center;
    border:1px solid var(--border); border-radius:2px; color:var(--accent); background:var(--bg-tertiary); }
  .assistant-send:hover { color:var(--text-primary); background:var(--bg-hover); }

  /* menu submenus (Refactor, Debug, Navigate children) */
  .pop .item.sub { position:relative; }
  .pop .item.sub::after { content:""; position:absolute; right:8px; width:5px; height:5px;
    border-top:1px solid var(--text-tertiary); border-right:1px solid var(--text-tertiary); transform:rotate(45deg); }
  .pop .item.sub > .pop { top:-5px; left:calc(100% - 2px); display:none; }
  .pop .item.sub:hover > .pop, .pop .item.open > .pop { display:block; }

  /* project-wide Find in Files controls */
  .find-bar .find-mask { width:110px; font-size:12px; padding:3px 6px; color:var(--text-primary);
    background:var(--input-bg); border:1px solid var(--border); border-radius:4px; outline:none; }
  .find-bar .find-mask:focus { border-color:var(--accent); }
  .find-replace-bar { padding-top:4px; }
  .find-bar .find-rep { width:170px; font-size:12px; padding:3px 6px; color:var(--text-primary);
    background:var(--input-bg); border:1px solid var(--border); border-radius:4px; outline:none; }
  .find-bar .find-rep:focus { border-color:var(--accent); }
  .find-repl-bar { display:flex; align-items:center; gap:8px; padding:5px 6px; margin-bottom:6px;
    border-bottom:1px solid var(--border); color:var(--text-secondary); font-size:11.5px; }
  .find-repl-bar span { margin-right:auto; }
  .fhit .frepl-pick { flex:0 0 auto; accent-color:var(--accent); }

  /* Go to Symbol / Structure: language-server results with a local fallback */
  .gosym { width:min(680px,88vw); display:flex; flex-direction:column; gap:6px; }
  .gosym-input { width:100%; box-sizing:border-box; padding:6px 8px; font:12px var(--mono);
    color:var(--text); background:var(--input-bg); border:1px solid var(--border); border-radius:5px; outline:none; }
  .gosym-input:focus { border-color:var(--accent); }
  .gosym-hint { font-size:11.5px; color:var(--text-tertiary); }
  .gosym-rows { max-height:52vh; overflow:auto; border:1px solid var(--border); border-radius:6px; background:var(--bg-primary); }
  .gosym-row { display:grid; grid-template-columns:92px minmax(0,1fr) auto; gap:10px; align-items:center;
    padding:6px 9px; cursor:pointer; font:12.5px var(--mono); border-bottom:1px solid var(--border); outline:none; }
  .gosym-row:last-child { border-bottom:0; }
  .gosym-row:hover, .gosym-row:focus { background:var(--bg-hover); }
  .gosym-kind { color:var(--accent); }
  .gosym-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text); }
  .gosym-loc { color:var(--text-tertiary); font-size:11.5px; }
  .gosym-empty { padding:12px; font-size:12px; color:var(--text-tertiary); }
  .struct-src { padding:5px 8px; margin-bottom:4px; border-bottom:1px solid var(--border);
    font-size:11px; color:var(--text-tertiary); }
  .tnode.struct-node { cursor:pointer; }
  .tnode.struct-node:hover, .tnode.struct-node:focus { background:var(--bg-hover); outline:none; }

  /* lightweight diff viewer shared by Compare with Clipboard and Local History */
  .diffcard { width:min(1080px,94vw); max-height:86vh; display:flex; flex-direction:column;
    background:var(--panel); color:var(--text); border:1px solid var(--border); border-radius:8px;
    box-shadow:0 18px 48px rgba(0,0,0,.45); overflow:hidden; }
  .diff-head { display:grid; grid-template-columns:1fr 1fr; gap:1px; padding:8px 10px;
    border-bottom:1px solid var(--border); font-size:12px; font-weight:600; color:var(--text-secondary); }
  .diff-body { flex:1; min-height:0; overflow:auto; font-family:var(--mono); font-size:11.5px; }
  .diff-row { display:grid; grid-template-columns:38px 1fr 38px 1fr; gap:0; min-height:17px; }
  .diff-row .dn { padding:0 5px; text-align:right; color:var(--text-tertiary); background:var(--bg-hover);
    border-right:1px solid var(--border); user-select:none; }
  .diff-row .dt { padding:0 6px; white-space:pre; overflow:hidden; text-overflow:ellipsis; }
  .diff-row.same .dt { color:var(--text-secondary); }
  .diff-row.add .dt:nth-child(4) { background:rgba(76,175,120,.16); color:var(--success); }
  .diff-row.del .dt:nth-child(2) { background:rgba(198,91,91,.16); color:var(--error); }
  .diff-cap { padding:6px 10px; font-size:11px; color:var(--warning); border-top:1px solid var(--border); }

  @media (max-width:1099px) {
    .assistant-drawer:not(.force-open), #rightResize:not(.force-open) { display:none; }
  }
  @media (max-width:960px) {
    :root { --project-width:210px; }
    .strip { width:30px; flex-basis:30px; }
    .toolbar { gap:4px; padding:0 6px; }
    .toolbar .widget { padding:0 5px; }
    .toolbar .run-group { gap:2px; }
  }
  @media (max-width:720px) {
    .panel { min-width:160px; }
    .toolbar .widget .lbl { display:none; }
    .toolbar .widget { max-width:150px; }
    .status .cell { padding:0 4px; }
    .status #stProblems, .status #stEol { display:none; }
  }
`;
