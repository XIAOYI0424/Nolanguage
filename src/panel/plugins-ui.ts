/**
 * Plugins panel page (Phase 3 · 安装 / 卸载 / 启用 / 禁用).
 *
 * The backend API has existed since the registry landed; this is the UI that
 * makes it reachable without a text editor and a restart. It talks the same
 * WebSocket as the monitor and the IDE, and follows the same house rules as the
 * other pages: one self-contained HTML document, CSS variables for theming,
 * light by default, no external script, no emoji.
 *
 * The page shows three things side by side on purpose:
 *
 *   - what is installed (and what is only *declared*, i.e. a disabled plugin),
 *   - what it costs (the Phase 4 budget),
 *   - what happened (the event log, so a failed install explains itself).
 *
 * Since the layer/override work landed, each card also answers two questions the
 * manifest on disk cannot: which tier supplied the body (`project` / `builtin` /
 * `user` / `cli` / `system`), and whether `overrides/<id>.json` rewrote any of
 * its fields. Shadowed copies — the same id found in a losing tier — get their
 * own list on the right, because "the newer copy I just dropped in" is the most
 * common reason a plugin seems to ignore an edit.
 */
export function renderPluginsHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Nolanguage · Plugins</title>
<style>
  :root { --bg:#FFFFFF; --bg2:#F7F8FA; --border:#EBECF0; --txt:#1E1F22; --sub:#6C707E; --accent:#3574F0; --ok:#499C54; --warn:#D6A545; --err:#DB5C5C; --bar:#E3E8F7; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--txt); font:13px/1.5 -apple-system,"Segoe UI","PingFang SC",system-ui,sans-serif; }
  header { display:flex; align-items:center; gap:12px; padding:10px 16px; background:var(--bg2); border-bottom:1px solid var(--border); }
  header .logo { font-weight:600; }
  header .badge { font-size:11px; padding:1px 8px; border:1px solid var(--border); border-radius:9px; color:var(--sub); }
  header .spacer { flex:1; }
  .conn { font-size:12px; color:var(--sub); display:flex; gap:6px; align-items:center; }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--warn); }
  .dot.on { background:var(--ok); }
  main { display:grid; grid-template-columns: 1.2fr 1fr; gap:0; height:calc(100vh - 53px); }
  section { display:flex; flex-direction:column; min-height:0; }
  #left { border-right:1px solid var(--border); }
  .head { padding:8px 14px; background:var(--bg2); border-bottom:1px solid var(--border); font-weight:600; display:flex; gap:8px; align-items:center; }
  .scroll { overflow:auto; flex:1; padding:10px 14px; }
  .card { border:1px solid var(--border); border-radius:8px; padding:10px 12px; margin-bottom:10px; }
  .card.off { opacity:.62; }
  .card .name { font-weight:600; }
  .card .meta { color:var(--sub); font-size:11.5px; font-family:ui-monospace,Menlo,Consolas,monospace; }
  .pill { display:inline-block; font-size:11px; padding:1px 7px; border:1px solid var(--border); border-radius:8px; color:var(--sub); margin-right:4px; }
  .pill.ok { color:var(--ok); border-color:var(--ok); }
  .pill.warn { color:var(--warn); border-color:var(--warn); }
  .pill.err { color:var(--err); border-color:var(--err); }
  .pill.acc { color:var(--accent); border-color:var(--accent); }
  .actions { margin-top:8px; display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
  button { background:var(--bg); border:1px solid var(--border); border-radius:5px; padding:4px 10px; cursor:pointer; font:inherit; }
  button:hover { border-color:var(--accent); color:var(--accent); }
  button.danger:hover { border-color:var(--err); color:var(--err); }
  button:disabled { opacity:.5; cursor:default; }
  .budget { display:grid; gap:6px; }
  .bar { height:8px; border-radius:4px; background:var(--bar); overflow:hidden; }
  .bar > span { display:block; height:100%; background:var(--accent); }
  .row { display:flex; justify-content:space-between; gap:10px; font-size:12px; }
  .row .k { color:var(--sub); }
  input[type=text] { border:1px solid var(--border); border-radius:5px; padding:4px 8px; font:inherit; width:100%; }
  label { font-size:12px; color:var(--sub); display:flex; gap:6px; align-items:center; }
  #events { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:11.5px; }
  #events .l { padding:3px 0; border-bottom:1px solid rgba(0,0,0,.04); }
  #events .ok { color:var(--ok); }
  #events .err { color:var(--err); }
  #events .ev { color:var(--accent); }
  .issues { color:var(--err); font-size:11.5px; margin-top:6px; }
  /* Override details sit under the card, monospace: they are file paths and
     field names, not prose. The accent bar says "this came from your override
     file", not from the plugin body. */
  .ovr { margin-top:6px; padding:4px 0 4px 8px; border-left:2px solid var(--accent); font-family:ui-monospace,Menlo,Consolas,monospace; font-size:11.5px; color:var(--sub); }
  .ovr .k { color:var(--accent); }
  .ovr .stale { color:var(--warn); }
</style>
</head>
<body>
<header>
  <span class="logo">Nolanguage</span>
  <span class="badge">Plugins</span>
  <span class="spacer"></span>
  <div class="conn"><span class="dot" id="dot"></span><span id="connTxt">connecting…</span></div>
</header>
<main>
  <section id="left">
    <div class="head">Installed
      <input type="text" id="installDir" placeholder="install from directory…" style="max-width:220px" />
      <button id="installBtn">Install</button>
    </div>
    <div class="scroll" id="list"><div class="meta">loading…</div></div>
  </section>
  <section>
    <div class="head">Resources <button id="reclaim" style="margin-left:auto">Reclaim now</button></div>
    <div class="scroll">
      <div id="budget" class="budget"></div>
      <div class="head" style="margin:14px -14px 0; border-top:1px solid var(--border)">Runtimes</div>
      <div class="scroll" id="runtimes" style="max-height:180px"></div>
      <div class="head" style="margin:14px -14px 0; border-top:1px solid var(--border)">Shadowed copies</div>
      <div class="scroll" id="shadowed" style="max-height:150px"></div>
      <div class="head" style="margin:14px -14px 0; border-top:1px solid var(--border)">Events</div>
      <div class="scroll" id="events" style="max-height:240px"></div>
    </div>
  </section>
</main>
<script>
(function () {
  var ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/');
  var dot = document.getElementById('dot'), connTxt = document.getElementById('connTxt');
  var list = document.getElementById('list'), events = document.getElementById('events');
  var budget = document.getElementById('budget'), runtimes = document.getElementById('runtimes');
  var shadowed = document.getElementById('shadowed');
  var reqId = 0;
  function setConn(on){ dot.className = 'dot' + (on ? ' on' : ''); connTxt.textContent = on ? 'connected' : 'disconnected'; }
  ws.onopen = function () { setConn(true); send({ kind: 'listPlugins' }); };
  ws.onclose = function () { setConn(false); };

  function send(msg) { ws.send(JSON.stringify(msg)); }
  function log(kind, msg) {
    var d = document.createElement('div'); d.className = 'l ' + kind;
    d.textContent = new Date().toLocaleTimeString() + '  ' + msg; events.prepend(d);
  }
  function mb(bytes) { return (bytes / 1048576).toFixed(1) + ' MB'; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
  }

  function renderBudget(res) {
    if (!res) { budget.innerHTML = '<div class="meta">no resource data</div>'; return; }
    var total = Math.max(1, res.budgetBytes), used = Math.min(res.totalBytes, total);
    var pct = ((used / total) * 100).toFixed(1);
    var html = '';
    html += '<div class="bar"><span style="width:' + pct + '%"></span></div>';
    html += '<div class="row"><span class="k">total · ' + (res.running || 0) + ' server(s) running</span><span>' +
      mb(res.totalBytes) + ' / ' + mb(res.budgetBytes) + '</span></div>';
    if (res.overBudget) html += '<div><span class="pill err">over budget</span></div>';
    html += '<div class="row"><span class="k">language servers</span><span>' + mb(res.lspBytes) + ' / ' + mb(res.lspBudgetBytes) + '</span></div>';
    html += '<div class="row"><span class="k">idle reclamation</span><span>' + (res.idleMs ? Math.round(res.idleMs / 60000) + ' min' : 'off') + '</span></div>';
    budget.innerHTML = html;
  }

  function renderRuntimes(list) {
    runtimes.innerHTML = '';
    if (!list || !list.length) { runtimes.innerHTML = '<div class="meta">no runtimes</div>'; return; }
    list.forEach(function (r) {
      var d = document.createElement('div');
      d.className = 'card';
      d.innerHTML = '<div class="name">' + esc(r.id) + ' <span class="meta">v' + esc(r.version) + '</span></div>';
      runtimes.appendChild(d);
    });
  }

  function render(plugins, res, runtimesList, conflicts, home) {
    list.innerHTML = '';
    if (home) {
      var line = document.createElement('div');
      line.className = 'meta';
      line.style.marginBottom = '8px';
      line.textContent = 'home ' + home;
      list.appendChild(line);
    }
    if (!plugins || !plugins.length) {
      var empty = document.createElement('div');
      empty.className = 'meta';
      empty.textContent = 'no plugins found';
      list.appendChild(empty);
      renderBudget(res);
      renderRuntimes(runtimesList);
      renderShadowed(conflicts);
      return;
    }
    plugins.forEach(function (p) {
      var div = document.createElement('div');
      div.className = 'card' + (p.enabled ? '' : ' off');
      var html = '';
      html += '<span class="pill ' + (p.enabled ? 'ok' : 'warn') + '">' + (p.enabled ? 'enabled' : 'disabled') + '</span>';
      // The tier is the answer to "why is this here?" — project plugins are
      // local to the workspace, builtin ones ship with the app.
      html += '<span class="pill' + (p.layer === 'project' ? ' acc' : '') + '">' + esc(p.layer) + '</span>';
      html += '<span class="pill">' + esc(p.kind) + '</span>';
      if (!p.validationOk) html += '<span class="pill err">invalid</span>';
      if (p.needsRunner && !p.runnerError) html += '<span class="pill acc">run: ' + esc(p.runMode || '-') + '</span>';
      if (p.runnerError) html += '<span class="pill warn">runner: ' + esc(p.runnerError) + '</span>';
      if (p.lspServerName) html += '<span class="pill">lsp: ' + esc(p.lspServerName) + '</span>';
      if (p.debugAdapter) html += '<span class="pill">debug: ' + esc(p.debugAdapter) + '</span>';
      if (p.profilerAdapter) html += '<span class="pill">profile: ' + esc(p.profilerAdapter) + '</span>';
      if (p.overrides) html += '<span class="pill acc">override</span>';
      html += '<div class="name">' + esc(p.displayName) + ' <span class="meta">' + esc(p.id) + ' v' + esc(p.version) + '</span></div>';
      html += '<div class="meta">' + (p.extensions || []).map(function (e) { return '.' + esc(e); }).join(' ') +
        (p.fileName ? ' · ' + esc(p.fileName) : '') + '</div>';
      if (p.description) html += '<div class="meta" style="font-family:inherit">' + esc(p.description) + '</div>';
      if (p.memoryBytes) html += '<div class="meta">' + mb(p.memoryBytes) + ' attributed' + (p.memoryRunning ? ' (server running)' : '') + '</div>';
      if (p.validation && p.validation.length) {
        html += '<div class="issues">' + p.validation.map(function (i) { return esc(i.field || '?') + ': ' + esc(i.message); }).join('<br />') + '</div>';
      }
      if (p.overrides) {
        // Field paths, not prose: this block exists so a user can see that the
        // manifest on disk is not what the engine is running.
        html += '<div class="ovr"><div class="k">' + esc(p.overrides.file) + '</div>';
        (p.overrides.changed || []).forEach(function (f) { html += '<div>' + esc(f) + '</div>'; });
        (p.overrides.stale || []).forEach(function (f) {
          html += '<div class="stale">! ' + esc(f) + ' (not in manifest)</div>';
        });
        html += '</div>';
      }
      html += '<div class="actions"></div>';
      div.innerHTML = html;
      var actions = div.querySelector('.actions');
      actions.appendChild(btn(p.enabled ? 'Disable' : 'Enable', function () {
        send({ kind: p.enabled ? 'langDisable' : 'langEnable', id: p.id, reqId: ++reqId });
        log('ev', (p.enabled ? 'disable ' : 'enable ') + p.id);
      }));
      // Data under data/<id>/ always survives: sessions and run configs are
      // the user's, not the plugin's. A keepData:false wipe stays available in
      // the API for a host that wants it; the UI never offers it, because
      // throwing away run configs is not something a button should do.
      actions.appendChild(btn('Uninstall (keep data)', function () {
        send({ kind: 'langUninstall', id: p.id, keepData: true, reqId: ++reqId });
        log('ev', 'uninstall ' + p.id + ' (keeping data)');
      }, true, !p.removable));
      list.appendChild(div);
    });
    renderBudget(res);
    renderRuntimes(runtimesList);
    renderShadowed(conflicts);
  }

  /*
    Same id in two tiers: only the winner is installed, but a user who copied a
    newer plugin next to an older one needs to see that the older one lost.
    Ordered by the registry (winners first), one small card per conflict.
  */
  function renderShadowed(conflicts) {
    shadowed.innerHTML = '';
    if (!conflicts || !conflicts.length) {
      shadowed.innerHTML = '<div class="meta">none — every plugin id resolved to one copy</div>';
      return;
    }
    conflicts.forEach(function (c) {
      var d = document.createElement('div');
      d.className = 'card';
      var html = '<div class="name">' + esc(c.id) + ' <span class="meta">winner · ' + esc(c.winner.layer) + ' v' + esc(c.winner.version) + '</span></div>';
      html += '<div class="meta">' + esc(c.winner.dir) + '</div>';
      (c.losers || []).forEach(function (l) {
        html += '<div class="meta">shadowed · ' + esc(l.layer) + ' v' + esc(l.version) + '</div>';
        html += '<div class="meta">' + esc(l.dir) + '</div>';
      });
      d.innerHTML = html;
      shadowed.appendChild(d);
    });
  }

  function btn(label, fn, danger, disabled) {
    var b = document.createElement('button');
    b.textContent = label;
    if (danger) b.className = 'danger';
    if (disabled) b.disabled = true;
    b.onclick = fn;
    return b;
  }

  document.getElementById('installBtn').onclick = function () {
    var dir = document.getElementById('installDir').value.trim();
    if (!dir) return;
    send({ kind: 'langInstall', dir: dir, reqId: ++reqId });
    log('ev', 'installing from ' + dir);
  };
  document.getElementById('reclaim').onclick = function () {
    send({ kind: 'reclaimResources', reqId: ++reqId });
    log('ev', 'reclaim request sent');
  };

  ws.onmessage = function (ev) {
    var m = JSON.parse(ev.data);
    if (m.kind === 'plugins') {
      render(m.plugins, m.resource, m.runtimes, m.conflicts, m.home);
      // A rejected override keeps the plugin working but must not be silent.
      (m.overrideProblems || []).forEach(function (p) { log('err', 'override: ' + p); });
    }
    else if (m.kind === 'pluginOp') {
      log(m.ok ? 'ok' : 'err', (m.op || '') + ' ' + (m.id || '') + (m.ok ? '' : ' — ' + m.error));
      if (m.ok) send({ kind: 'listPlugins' });
    }
    else if (m.kind === 'resources') { renderBudget(m.resource); }
  };
})();
</script>
</body>
</html>`;
}
