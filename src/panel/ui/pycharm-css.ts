/**
 * The PyCharm New UI stylesheet, verbatim.
 *
 * Split out of `pycharm-ui.ts` so the assembly file stays readable; the CSS
 * is still served inline in one `<style>` block (no build step, no CDN).
 * Both themes are a `data-theme` flip on <html>; every colour is a variable.
 */
export const PYCHARM_CSS = `
  :root, :root[data-theme="darcula"] {
    --bg-primary:#1E1F22; --bg-secondary:#2B2D30; --bg-tertiary:#393B40;
    --bg-editor:#1E1F22; --bg-gutter:#1E1F22; --bg-toolbar:#2B2D30;
    --bg-hover:#26282E; --bg-active:#2E3136; --border:#393B40; --border-soft:#2B2D30;
    --text-primary:#DFE1E5; --text-secondary:#9DA0A8; --text-tertiary:#6F737A;
    --accent:#3574F0; --success:#499C54; --warning:#D6A545; --error:#DB5C5C;
    --icon-default:#9DA0A8; --icon-active:#DFE1E5;
    --sel:#214283; --sel-text:#FFFFFF;
    --syn-keyword:#CF8E6D; --syn-string:#6AAB73; --syn-number:#2AACB8; --syn-comment:#7A7E85;
    --syn-func:#56A8F5; --syn-class:#B5B6E3; --syn-var:#BCBEC4; --syn-const:#6A8759; --syn-deco:#B99CCF;
    --shadow: 0 8px 28px rgba(0,0,0,.5);
    --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --sans: -apple-system, "Segoe UI", Inter, "PingFang SC", system-ui, sans-serif;
  }
  :root[data-theme="light"] {
    --bg-primary:#FFFFFF; --bg-secondary:#F7F8FA; --bg-tertiary:#FFFFFF;
    --bg-editor:#FFFFFF; --bg-gutter:#F7F8FA; --bg-toolbar:#FFFFFF;
    --bg-hover:#EAECF0; --bg-active:#E3E5E8; --border:#E1E2E6; --border-soft:#EBECF0;
    --text-primary:#1E1F22; --text-secondary:#6C707E; --text-tertiary:#9DA0A8;
    --accent:#3574F0; --success:#5B9E56; --warning:#C8872B; --error:#DB5C5C;
    --icon-default:#6C707E; --icon-active:#1E1F22;
    --sel:#CFE2FF; --sel-text:#1E1F22;
    --syn-keyword:#0033B3; --syn-string:#067D17; --syn-number:#1750EB; --syn-comment:#8C8C8C;
    --syn-func:#00627A; --syn-class:#1E1F22; --syn-var:#1E1F22; --syn-const:#1750EB; --syn-deco:#9C2BB8;
    --shadow: 0 8px 28px rgba(0,0,0,.18);
  }
  * { box-sizing:border-box; }
  html, body { height:100%; margin:0; }
  body {
    background:var(--bg-primary); color:var(--text-primary);
    font:13px/1.45 var(--sans); overflow:hidden; -webkit-font-smoothing:antialiased;
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
  .ide { display:grid; grid-template-rows:28px 40px 1fr 24px; height:100vh; }
  html[data-tauri="1"] .ide { grid-template-rows:32px 28px 40px 1fr 24px; }

  /* menu bar */
  .menubar { display:flex; align-items:center; gap:2px; padding:0 8px; background:var(--bg-primary);
    border-bottom:1px solid var(--border-soft); font-size:12.5px; position:relative; z-index:40; }
  .menubar .brand { font-weight:600; color:var(--accent); margin-right:10px; letter-spacing:.3px; }
  .menu { padding:3px 9px; border-radius:5px; color:var(--text-secondary); position:relative; }
  .menu:hover, .menu.open { background:var(--bg-hover); color:var(--text-primary); }
  .menubar .spacer { flex:1; }

  /* dropdown popover shared by menus */
  .pop { position:absolute; top:26px; left:0; min-width:230px; background:var(--bg-tertiary);
    border:1px solid var(--border); border-radius:8px; box-shadow:var(--shadow); padding:5px; display:none; z-index:60; }
  .menu.open .pop { display:block; }
  .pop .item { display:flex; align-items:center; gap:10px; width:100%; text-align:left;
    padding:6px 9px; border-radius:5px; color:var(--text-primary); font-size:12.5px; }
  .pop .item:hover { background:var(--accent); color:#fff; }
  .pop .item .sc { margin-left:auto; color:var(--text-tertiary); font-size:11.5px; }
  .pop .item:hover .sc { color:rgba(255,255,255,.8); }
  .pop .sep { height:1px; background:var(--border); margin:5px 6px; }
  .pop .grp { padding:5px 9px 3px; font-size:10.5px; text-transform:uppercase; letter-spacing:.6px; color:var(--text-tertiary); }

  /* main toolbar */
  .toolbar { display:flex; align-items:center; gap:10px; padding:0 10px; background:var(--bg-toolbar);
    border-bottom:1px solid var(--border); }
  .widget { display:flex; align-items:center; gap:6px; height:26px; padding:0 9px; border-radius:6px;
    border:1px solid var(--border); background:var(--bg-secondary); color:var(--text-primary); font-size:12px; max-width:280px; }
  .widget:hover { background:var(--bg-hover); }
  .widget .lbl { color:var(--text-tertiary); }
  .widget .val { font-weight:500; }
  .widget .ic { color:var(--icon-default); }
  .run-group { display:flex; align-items:center; gap:4px; }
  .tbtn { display:flex; align-items:center; gap:6px; height:26px; padding:0 9px; border-radius:6px;
    border:1px solid var(--border); background:var(--bg-secondary); color:var(--text-primary); font-size:12px; }
  .tbtn:hover { background:var(--bg-hover); border-color:var(--accent); }
  .tbtn.iconly { padding:0 7px; }
  .tbtn .ic { color:var(--icon-default); }
  .tbtn:hover .ic { color:var(--icon-active); }
  .tbtn.primary { background:var(--success); border-color:var(--success); color:#fff; }
  .tbtn.primary .ic { color:#fff; }
  .toolbar .spacer { flex:1; }

  /* work area */
  .work { display:flex; min-height:0; }

  /* left tool strip */
  .strip { width:40px; flex:0 0 auto; background:var(--bg-secondary); border-right:1px solid var(--border);
    display:flex; flex-direction:column; align-items:center; padding:4px 0; gap:2px; }
  .strip .sbtn { width:32px; height:32px; border-radius:6px; display:flex; align-items:center; justify-content:center;
    color:var(--icon-default); position:relative; }
  .strip .sbtn:hover { background:var(--bg-hover); color:var(--icon-active); }
  .strip .sbtn.active { color:var(--accent); }
  .strip .sbtn.active::before { content:""; position:absolute; left:-4px; top:6px; bottom:6px; width:2px;
    border-radius:2px; background:var(--accent); }
  .strip .grow { flex:1; }

  /* docked tool window (left) */
  .panel { width:300px; flex:0 0 auto; background:var(--bg-primary); border-right:1px solid var(--border);
    display:flex; flex-direction:column; min-width:0; }
  .panel.hidden { display:none; }
  .tw-head { height:30px; flex:0 0 auto; display:flex; align-items:center; gap:4px; padding:0 6px 0 12px;
    background:var(--bg-secondary); border-bottom:1px solid var(--border); font-size:11.5px; font-weight:600;
    color:var(--text-secondary); letter-spacing:.3px; }
  .tw-head .title { flex:1; text-transform:uppercase; }
  .tw-head .tbtn { width:22px; height:22px; padding:0; justify-content:center; border:0; background:none; border-radius:4px; }
  .tw-head .tbtn:hover { background:var(--bg-hover); }
  .tw-body { flex:1; overflow:auto; min-height:0; }
  .ptree { padding:4px 0; font-size:12.5px; user-select:none; }
  .tnode { display:flex; align-items:center; gap:5px; padding:2px 8px; cursor:pointer; border-radius:4px; color:var(--text-primary); }
  .tnode:hover { background:var(--bg-hover); }
  .tnode.active { background:var(--bg-active); }
  .tnode .chev { width:14px; height:14px; flex:0 0 auto; display:flex; align-items:center; justify-content:center; color:var(--text-tertiary); }
  .tnode .ic { color:var(--icon-default); flex:0 0 auto; }
  .tnode .nm { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .tnode.ro .nm { color:var(--text-tertiary); font-style:italic; }
  .pempty { padding:6px 14px; color:var(--text-tertiary); font-size:12px; }
  .ctxmenu { position:fixed; z-index:90; min-width:220px; background:var(--bg-secondary); border:1px solid var(--border); border-radius:6px; padding:4px; box-shadow:0 6px 20px rgba(0,0,0,.35); display:none; }
  .ctxmenu.open { display:block; }
  .ctxmenu .citem { display:flex; align-items:center; justify-content:space-between; gap:18px; padding:5px 10px; border-radius:4px; cursor:pointer; font-size:12.5px; white-space:nowrap; }
  .ctxmenu .citem:hover { background:var(--accent); color:#fff; }
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
  .etabs { height:36px; flex:0 0 auto; display:flex; align-items:flex-end; gap:1px; padding:0 8px;
    background:var(--bg-secondary); border-bottom:1px solid var(--border); overflow-x:auto; }
  .etab { display:flex; align-items:center; gap:7px; height:30px; padding:0 8px 0 10px; border-radius:6px 6px 0 0;
    color:var(--text-secondary); font-size:12.5px; max-width:200px; position:relative; }
  .etab:hover { background:var(--bg-hover); }
  .etab.active { background:var(--bg-editor); color:var(--text-primary); }
  .etab.active::after { content:""; position:absolute; left:8px; right:8px; top:0; height:2px; background:var(--accent); border-radius:2px; }
  .etab .nm { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .etab .dirty { color:var(--accent); font-size:14px; line-height:0; }
  .etab .x { width:16px; height:16px; border-radius:4px; display:none; align-items:center; justify-content:center; color:var(--icon-default); }
  .etab:hover .x, .etab.active .x { display:flex; }
  .etab .x:hover { background:var(--bg-tertiary); color:var(--icon-active); }
  .etabs .more { margin-left:auto; align-self:center; width:24px; height:24px; border-radius:5px; display:flex; align-items:center; justify-content:center; color:var(--icon-default); }
  .etabs .more:hover { background:var(--bg-hover); }

  /* editor: gutter + code overlay */
  .edwrap { flex:1; display:flex; min-height:0; background:var(--bg-editor); position:relative; }
  .gutter { width:56px; flex:0 0 auto; overflow:hidden; background:var(--bg-gutter); position:relative;
    border-right:1px solid var(--border-soft); }
  .gutter .glines { position:absolute; left:0; right:0; top:0; padding:10px 0; will-change:transform; }
  .gline { position:relative; height:20px; display:flex; align-items:center; justify-content:flex-end;
    padding-right:10px; font:12px/20px var(--mono); color:var(--text-tertiary); }
  .gline.cur { color:var(--text-primary); }
  .gline .bp { position:absolute; left:7px; top:5px; width:10px; height:10px; border-radius:50%;
    background:var(--error); border:1px solid rgba(0,0,0,.25); cursor:pointer; }
  .gline .fold { position:absolute; left:26px; top:3px; width:14px; height:14px; border-radius:3px;
    display:flex; align-items:center; justify-content:center; color:var(--text-tertiary); opacity:0; cursor:pointer; }
  .gline.foldable:hover .fold { opacity:1; }
  .gline .fold:hover { background:var(--bg-hover); color:var(--icon-active); }
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
  .curline { position:absolute; left:0; right:0; height:20px; background:var(--bg-active); pointer-events:none; display:none; }
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
  .dock { height:240px; flex:0 0 auto; background:var(--bg-primary); border-top:1px solid var(--border);
    display:flex; flex-direction:column; min-height:0; }
  .dock.hidden { display:none; }
  .dock-tabs { height:30px; flex:0 0 auto; display:flex; align-items:center; gap:2px; padding:0 8px;
    background:var(--bg-secondary); border-bottom:1px solid var(--border); }
  .dtab { display:flex; align-items:center; gap:6px; height:24px; padding:0 9px; border-radius:5px;
    color:var(--text-secondary); font-size:12px; }
  .dtab:hover { background:var(--bg-hover); color:var(--text-primary); }
  .dtab.active { color:var(--text-primary); background:var(--bg-active); }
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
  .dlg-detail { background:var(--bg-primary); border:1px solid var(--border-soft); border-radius:6px;
    padding:8px 10px; font:11.5px/1.5 var(--mono); white-space:pre-wrap; max-height:180px; overflow:auto; }
  .dlg-foot { display:flex; justify-content:flex-end; gap:8px; padding:10px 14px; border-top:1px solid var(--border-soft); }
  .dlg-btn { height:26px; padding:0 14px; border-radius:6px; border:1px solid var(--border);
    background:var(--bg-tertiary); color:var(--text-primary); font-size:12px; cursor:default; }
  .dlg-btn:hover { border-color:var(--accent); }
  .dlg-btn.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  .dlg-btn.danger { background:var(--error); border-color:var(--error); color:#fff; }
  .dlg-btn:disabled { opacity:.45; }

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
  .prob { cursor:pointer; }
  .prob:hover { background: var(--bg-hover); }

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
`;
