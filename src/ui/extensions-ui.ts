/**
 * Extensions panel page (Stage 2 · 面板接入).
 *
 * A dependency-free HTML page that talks to the same WebSocket the monitor uses.
 * It lists every discovered extension with its host status and contributed
 * commands, and lets you run a command in the (isolated) extension host process
 * and watch the result + lifecycle events stream back.
 */
export function renderExtensionsHtml(port: number): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Nolanguage · Extensions</title>
<style>
  :root { --bg:#FFFFFF; --bg2:#F7F8FA; --border:#EBECF0; --txt:#1E1F22; --sub:#6C707E; --accent:#3574F0; --ok:#499C54; --warn:#D6A545; --err:#DB5C5C; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--txt); font:13px/1.5 -apple-system,"Segoe UI","PingFang SC",system-ui,sans-serif; }
  header { display:flex; align-items:center; gap:12px; padding:10px 16px; background:var(--bg2); border-bottom:1px solid var(--border); }
  header .logo { font-weight:600; }
  header .badge { font-size:11px; padding:1px 8px; border:1px solid var(--border); border-radius:9px; color:var(--sub); }
  header .spacer { flex:1; }
  .conn { font-size:12px; color:var(--sub); display:flex; gap:6px; align-items:center; }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--warn); }
  .dot.on { background:var(--ok); }
  main { display:grid; grid-template-columns: 1.1fr 1fr; gap:0; height:calc(100vh - 53px); }
  section { display:flex; flex-direction:column; min-height:0; }
  #left { border-right:1px solid var(--border); }
  .head { padding:8px 14px; background:var(--bg2); border-bottom:1px solid var(--border); font-weight:600; }
  .scroll { overflow:auto; flex:1; padding:10px 14px; }
  .ext { border:1px solid var(--border); border-radius:8px; padding:10px 12px; margin-bottom:10px; }
  .ext.incompatible { opacity:.6; }
  .ext .name { font-weight:600; }
  .ext .meta { color:var(--sub); font-size:11.5px; font-family:ui-monospace,Menlo,Consolas,monospace; }
  .ext .state { float:right; font-size:11px; padding:1px 7px; border-radius:8px; border:1px solid var(--border); color:var(--sub); }
  .ext .state.ready { color:var(--ok); border-color:var(--ok); }
  .ext .state.crashed { color:var(--err); border-color:var(--err); }
  .cmds { margin-top:8px; display:flex; flex-wrap:wrap; gap:6px; }
  .cmd { display:flex; gap:6px; align-items:center; }
  .cmd button { background:var(--bg); border:1px solid var(--border); border-radius:5px; padding:3px 9px; cursor:pointer; }
  .cmd button:hover { border-color:var(--accent); color:var(--accent); }
  .cmd input { width:120px; border:1px solid var(--border); border-radius:5px; padding:3px 6px; }
  #events { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:11.5px; }
  #events .row { padding:3px 0; border-bottom:1px solid rgba(0,0,0,.04); }
  #events .ok { color:var(--ok); }
  #events .err { color:var(--err); }
  #events .ev { color:var(--accent); }
  code { background:var(--bg2); padding:1px 4px; border-radius:4px; }
</style>
</head>
<body>
<header>
  <span class="logo">Nolanguage</span>
  <span class="badge">Dev Panel · extensions</span>
  <span class="spacer"></span>
  <div class="conn"><span class="dot" id="dot"></span><span id="connTxt">connecting…</span></div>
</header>
<main>
  <section id="left">
    <div class="head">Extensions</div>
    <div class="scroll" id="exts"><div class="meta">loading…</div></div>
  </section>
  <section>
    <div class="head">Live events</div>
    <div class="scroll" id="events"></div>
  </section>
</main>
<script>
(function () {
  var ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/');
  var dot = document.getElementById('dot'), connTxt = document.getElementById('connTxt');
  var exts = document.getElementById('exts'), events = document.getElementById('events');
  var reqId = 0;
  function esc(v) {
    var map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return map[c]; });
  }
  function setConn(on){ dot.className = 'dot' + (on ? ' on' : ''); connTxt.textContent = on ? 'connected' : 'disconnected'; }
  ws.onopen = function () { setConn(true); ws.send(JSON.stringify({ kind: 'listExtensions' })); };
  ws.onclose = function () { setConn(false); };
  function log(kind, msg) {
    var d = document.createElement('div'); d.className = 'row ' + kind;
    d.textContent = new Date().toLocaleTimeString() + '  ' + msg; events.prepend(d);
  }
  function renderExts(list) {
    exts.innerHTML = '';
    if (!list.length) { exts.innerHTML = '<div class="meta">no extensions found</div>'; return; }
    list.forEach(function (e) {
      var div = document.createElement('div');
      div.className = 'ext' + (e.compatible ? '' : ' incompatible');
      var st = e.state || (e.compatible ? 'idle' : 'incompatible');
      var html = '<span class="state ' + esc(st) + '">' + esc(st) + '</span>';
      html += '<div class="name">' + esc(e.name) + ' <span class="meta">' + esc(e.id) + '</span></div>';
      html += '<div class="meta">v' + esc(e.version) + ' · engine ^' + esc(e.engine) + ' · host ' + esc(e.host) + '</div>';
      html += '<div class="meta">events: ' + esc((e.activationEvents || []).join(', ') || '(none)') + '</div>';
      if (e.pid != null) html += '<div class="meta">pid ' + esc(e.pid) + ' · crashes ' + esc(e.crashes) + ' · rss ' + esc(e.rssBytes||0) + 'B</div>';
      if (e.note) html += '<div class="meta" style="color:var(--err)">note: ' + esc(e.note) + '</div>';
      var cmds = e.commands || [];
      if (cmds.length) {
        html += '<div class="cmds"></div>';
      }
      div.innerHTML = html;
      var cmdWrap = div.querySelector('.cmds');
      cmds.forEach(function (c) {
        var wrap = document.createElement('div'); wrap.className = 'cmd';
        var arg = document.createElement('input'); arg.placeholder = 'arg'; arg.value = c.id === 'demo.hello.greet' ? 'panel' : '';
        var btn = document.createElement('button'); btn.textContent = c.title || c.id;
        btn.onclick = function () {
          var id = ++reqId;
          ws.send(JSON.stringify({ kind: 'runExtensionCommand', id: c.id, args: arg.value ? [arg.value] : [], reqId: id }));
          log('ev', 'run ' + c.id + ' …');
        };
        wrap.appendChild(arg); wrap.appendChild(btn); cmdWrap.appendChild(wrap);
      });
      exts.appendChild(div);
    });
  }
  ws.onmessage = function (ev) {
    var m = JSON.parse(ev.data);
    if (m.kind === 'extensions') { renderExts(m.extensions); }
    else if (m.kind === 'extension') { log('ev', '[' + m.event + '] ' + m.extensionId + (m.hostId ? ' host=' + m.hostId : '')); }
    else if (m.kind === 'extensionResult') { log(m.ok ? 'ok' : 'err', 'result(' + m.reqId + '): ' + (m.ok ? JSON.stringify(m.result) : m.error)); }
  };
})();
</script>
</body>
</html>`;
}
