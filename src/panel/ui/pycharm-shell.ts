/**
 * The body markup of the PyCharm shell: title bar, tool windows, editor panes,
 * docks, dialogs and balloon roots.
 *
 * Pure markup — every interactive element is wired by `pycharm-client.ts`
 * through ids/classes, so this file can be read as the page structure.
 */
export const PYCHARM_SHELL = `
<body>
<div class="ide">
  <!-- self-drawn title bar (Tauri only: the OS chrome is off, so the shell owns
       dragging and the window controls). Hidden in the web preview. -->
  <div class="titlebar" data-tauri-only>
    <span class="tb-title"><span class="ic" data-ic="project" data-size="14"></span>Nolanguage</span>
    <span class="tb-spacer"></span>
    <button class="tb-btn" id="tbMin" title="Minimize" aria-label="Minimize"><span class="ic" data-ic="min" data-size="14"></span></button>
    <button class="tb-btn" id="tbMax" title="Maximize" aria-label="Maximize"><span class="ic" data-ic="max" data-size="14"></span></button>
    <button class="tb-btn tb-close" id="tbClose" title="Close" aria-label="Close"><span class="ic" data-ic="close" data-size="14"></span></button>
  </div>
  <!-- menu bar -->
  <div class="menubar" id="menubar">
    <span class="brand">Nolanguage</span>
    <!-- menus injected -->
    <span class="spacer"></span>
  </div>

  <!-- main toolbar -->
  <div class="toolbar">
    <button class="widget" id="projWidget" title="Project"><span class="ic" data-ic="project" data-size="16"></span><span class="lbl">Project:</span><span class="val">Nolanguage</span><span class="ic" data-ic="chevD" data-size="14"></span></button>
    <button class="widget" id="vcsWidget" title="Version Control"><span class="ic" data-ic="vcs" data-size="16"></span><span class="lbl">Git:</span><span class="val" id="branchVal">main</span><span class="ic" data-ic="chevD" data-size="14"></span></button>
    <div class="widget" style="gap:4px">
      <button class="tbtn iconly" id="cfgBtn" title="Run configurations"><span class="val" style="padding:0 2px">main</span><span class="ic" data-ic="chevD" data-size="14"></span></button>
    </div>
    <div class="run-group">
      <button class="tbtn primary" id="runBtn" title="Run 'main'  (Shift+F10)"><span class="ic" data-ic="run" data-size="16"></span>Run</button>
      <button class="tbtn" id="debugBtn" title="Debug 'main'  (Shift+F9)"><span class="ic" data-ic="debug" data-size="16"></span>Debug</button>
      <button class="tbtn iconly" id="covBtn" title="Run with coverage"><span class="ic" data-ic="coverage" data-size="16"></span></button>
      <button class="tbtn iconly" id="stopBtn" title="Stop"><span class="ic" data-ic="stop" data-size="16"></span></button>
    </div>
    <span class="spacer"></span>
    <button class="tbtn iconly" id="searchBtn" title="Search Everywhere  (double Shift)"><span class="ic" data-ic="search" data-size="16"></span></button>
    <button class="tbtn iconly" id="themeBtn" title="Toggle theme"><span class="ic" data-ic="ai" data-size="16"></span></button>
    <button class="tbtn iconly" id="settingsBtn" title="Settings  (Ctrl+Alt+S)"><span class="ic" data-ic="settings" data-size="16"></span></button>
  </div>

  <!-- work area -->
  <div class="work">
    <div class="strip" id="strip"></div>
    <div class="panel hidden" id="leftPanel">
      <div class="tw-head">
        <span class="title" id="panelTitle">Project</span>
        <button class="tbtn" id="collapseBtn" title="Collapse all"><span class="ic" data-ic="collapse" data-size="16"></span></button>
        <button class="tbtn" id="newBtn" title="New file in project root">+</button>
        <button class="tbtn" title="View options"><span class="ic" data-ic="settings" data-size="16"></span></button>
        <button class="tbtn" title="More"><span class="ic" data-ic="more" data-size="16"></span></button>
        <button class="tbtn" id="pinBtn" title="Pin / unpin"><span class="ic" data-ic="pin" data-size="16"></span></button>
        <button class="tbtn" id="panelCloseBtn" title="Hide"><span class="ic" data-ic="close" data-size="16"></span></button>
      </div>
      <div class="tw-body" id="panelBody" data-ctx="panel"></div>
    </div>
    <div class="center">
      <div class="etabs" id="etabs" data-ctx="tab"></div>
      <div class="edwrap" data-ctx="editor">
        <div class="gutter" id="gutter"><div class="glines" id="glines"></div></div>
        <div class="codewrap">
          <div class="curline" id="curline"></div>
          <pre id="hl" aria-hidden="true"><code id="hlCode"></code></pre>
          <textarea id="ta" spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off"></textarea>
        </div>
        <div class="cmp" id="cmp"></div>
        <div class="hover-tip" id="hoverTip"></div>
      </div>
      <div class="dock" id="dock" data-ctx="dock">
        <div class="dock-tabs" id="dockTabs">
          <span class="spacer"></span>
          <button class="tbtn iconly" id="dockHide" title="Hide"><span class="ic" data-ic="close" data-size="14"></span></button>
        </div>
        <div class="dock-body" id="dockBody"></div>
      </div>
    </div>
  </div>

  <!-- status bar -->
  <div class="status">
    <span class="cell" id="stFile">main.py</span>
    <span class="cell" id="stLang"><span class="ic" data-ic="file" data-size="14"></span>Python 3.11</span>
    <span class="cell hint" id="stHint"></span>
    <span class="cell" id="stPos">Ln 1, Col 1</span>
    <span class="cell" id="stEnc">UTF-8</span>
    <span class="cell" id="stEol">LF</span>
    <span class="cell" id="stProblems" title="Problems">0 problems</span>
    <span class="grow"></span>
    <span class="cell mem ok" id="stPerf" title="Performance"><span class="ic" data-ic="perf" data-size="14"></span><span id="stPerfVal">P95 —</span></span>
    <span class="cell" id="stGit"><span class="ic" data-ic="vcs" data-size="14"></span>Git: main</span>
  </div>
</div>

<!-- search everywhere -->
<div class="scrim" id="scrim"></div>
<div class="ctxmenu" id="ctxMenu"></div>

<!-- command palette: runs nlg run SCRIPT -- ARGS server-side -->
<div class="palette" id="palette">
  <div class="ph"><span class="pfx">&gt;</span><input id="palInput" type="text" placeholder="nlg run lang-install -- install examples/cpp@1.0.0" spellcheck="false" autocomplete="off" /></div>
  <div class="hint">Enter runs it · Esc closes · e.g. <code>nlg run verify-plugins</code> or <code>nlg run lang-install -- install examples/cpp@1.0.0</code></div>
  <div class="out" id="palOut"></div>
</div>
<div class="modal" id="searchModal">
  <div class="mtop"><span class="ic" data-ic="search" data-size="18"></span><input id="searchInput" placeholder="Search Everything (files, symbols, actions)…" /><button class="tbtn iconly" id="searchClose"><span class="ic" data-ic="close" data-size="16"></span></button></div>
  <div class="chips" id="searchChips">
    <button class="chip on" data-tab="all">All</button>
    <button class="chip" data-tab="files">Files</button>
    <button class="chip" data-tab="symbols">Symbols</button>
    <button class="chip" data-tab="actions">Actions</button>
  </div>
  <div class="mbody" id="searchBody"></div>
</div>

<!-- extensions -->
<div class="modal" id="extModal" style="top:16%; width:min(560px,92vw)">
  <div class="mtop"><span class="ic" data-ic="database" data-size="18"></span><b>Extensions</b><span class="grow" style="flex:1"></span><button class="tbtn iconly" id="extClose"><span class="ic" data-ic="close" data-size="16"></span></button></div>
  <div class="mbody" id="extBody"></div>
</div>

<!-- about -->
<div class="modal" id="aboutModal" style="top:20%; width:min(440px,92vw)">
  <div class="mtop"><span class="ic" data-ic="ai" data-size="18"></span><b>About</b><span style="flex:1"></span><button class="tbtn iconly" id="aboutClose"><span class="ic" data-ic="close" data-size="16"></span></button></div>
  <div class="mbody" id="aboutBody" style="padding:16px; font-size:13px"></div>
</div>

<!-- recent files -->
<div class="modal" id="recentModal" style="top:18%; width:min(520px,92vw)">
  <div class="mtop"><span class="ic" data-ic="file" data-size="18"></span><b>Recent Files</b><span style="flex:1"></span><button class="tbtn iconly" id="recentClose"><span class="ic" data-ic="close" data-size="16"></span></button></div>
  <div class="mbody" id="recentBody"></div>
</div>

<!-- language mode: the default is the file type, this is the explicit override -->
<div class="modal" id="langModal" style="top:16%; width:min(460px,92vw)">
  <div class="mtop"><span class="ic" data-ic="file" data-size="18"></span><input id="langInput" placeholder="Change language mode (default: file type)…" /><button class="tbtn iconly" id="langClose"><span class="ic" data-ic="close" data-size="16"></span></button></div>
  <div class="mbody" id="langBody"></div>
</div>

<div class="toast" id="toast"></div>

<!-- PyCharm-style dialogs and balloons are built here at runtime -->
<div id="dlgRoot"></div>
<div id="balloons"></div>
`;
