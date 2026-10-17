const http = require('http');
function makeEl() {
  const store = { value: '', children: [], style: {}, dataset: {} };
  return new Proxy(store, {
    get(t, prop) {
      if (prop in t) return t[prop];
      switch (prop) {
        case 'classList': return { add() {}, remove() {}, toggle() {}, contains() { return false; } };
        case 'querySelectorAll': return () => []; case 'querySelector': return () => makeEl();
        case 'children': return []; case 'innerHTML': return ''; case 'textContent': return '';
        case 'style': return t.style; case 'selectionStart': return 0; case 'selectionEnd': return 0;
        case 'scrollTop': return 0; case 'scrollHeight': return 0; case 'closest': return () => null;
        case 'getAttribute': return (k) => (k in t.dataset ? t.dataset[k] : null);
        case 'setAttribute': return (k, v) => { t.dataset[k] = v; }; case 'focus': return () => {};
        default: return (...a) => makeEl();
      }
    },
    set(t, prop, val) { t[prop] = val; return true; },
  });
}
const doc = { getElementById: () => makeEl(), createElement: () => makeEl(), querySelectorAll: () => [], querySelector: () => makeEl(), addEventListener: () => {}, execCommand: () => true, documentElement: { getAttribute: () => 'darcula', setAttribute: () => {} } };
const done = (m) => { console.log(m); process.exit(0); };
setTimeout(() => done('TIMEOUT waiting for page'), 12000);
const req = http.get('http://127.0.0.1:7399/pycharm', (res) => {
  let data = ''; res.on('data', (c) => (data += c));
  res.on('end', () => {
    const scripts = [...data.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    const code = scripts.sort((a, b) => b.length - a.length)[0];
    console.log('served bytes      :', data.length);
    console.log('guides layer gone :', !/class="guides"|\.guides/.test(data));
    try { new Function(code); console.log('SYNTAX OK'); } catch (e) { return done('SYNTAX ERROR: ' + e.message); }
    try {
      const fn = new Function('document', 'location', 'WebSocket', 'setTimeout', 'clearTimeout', 'requestAnimationFrame', 'performance', 'navigator', 'window', code);
      fn(doc, { protocol: 'http:', host: '127.0.0.1:7399' }, function WS() { return { send() {} }; }, setTimeout, clearTimeout, (cb) => cb(), { now: () => 0 }, { userAgent: 'x' }, { addEventListener() {}, document: doc });
      done('BOOT SMOKE OK');
    } catch (e) { done('BOOT SMOKE ERROR: ' + (e && e.message)); }
  });
});
req.on('error', (e) => done('FETCH ERROR: ' + e.message));
req.setTimeout(8000, () => done('HTTP TIMEOUT'));
