/**
 * /profile page application (Vue 3, global build).
 *
 * User-code performance: a hotspot table plus an interactive SVG flamegraph
 * built from `ProfileResult.flame`. The IDE "Profile current file" action
 * triggers a `profile` on the engine and stashes the result in localStorage so
 * this page can render it the moment it opens; broadcasts and `profileLast`
 * cover the case where this page is already open.
 *
 * The flamegraph SVG is emitted as a string and mounted via `v-html` — that
 * avoids Vue's in-DOM SVG-namespace pitfalls and keeps the layout math in one
 * place.
 */
(function (global) {
  'use strict';
  var NL = global.NL;
  if (!NL) return;

  var PALETTE = ['#4E79A7', '#F28E2B', '#59A14F', '#E15759', '#76B7B2', '#EDC948', '#B07AA1', '#9C755F', '#FF9DA7'];
  var DEFAULT_CODE = [
    'def fib(n):',
    '    if n < 2:',
    '        return n',
    '    return fib(n - 1) + fib(n - 2)',
    '',
    'def work():',
    '    total = 0',
    '    for i in range(25):',
    '        total += fib(i)',
    '    return total',
    '',
    'if __name__ == "__main__":',
    '    print("fib sum =", work())',
  ].join('\n');

  function colorFor(name) {
    var h = 0;
    for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }

  function findFrame(frames, name) {
    for (var i = 0; i < frames.length; i++) {
      var f = frames[i];
      if (f.name === name) return f;
      if (f.children && f.children.length) {
        var hit = findFrame(f.children, name);
        if (hit) return hit;
      }
    }
    return null;
  }

  global.ProfileApp = {
    data: function () {
      return {
        conn: 'connecting',
        caps: [],
        lang: '',
        code: DEFAULT_CODE,
        topN: 25,
        running: false,
        result: null,
        error: '',
        zoom: null,
      };
    },
    computed: {
      hasFlame: function () {
        return !!(this.result && this.result.flame && this.result.flame.length);
      },
      totalMs: function () {
        if (!this.hasFlame) return 0;
        var roots = this.zoom ? [this.zoom] : this.result.flame;
        return roots.reduce(function (s, f) { return s + f.totalMs; }, 0);
      },
      flameRects: function () {
        if (!this.hasFlame) return [];
        var roots = this.zoom ? [this.zoom] : this.result.flame;
        var rects = [];
        function walk(frames, x0, x1, depth) {
          var parentTotal = frames.reduce(function (s, f) { return s + f.totalMs; }, 0) || 1;
          var x = x0;
          for (var i = 0; i < frames.length; i++) {
            var f = frames[i];
            var w = (f.totalMs / parentTotal) * (x1 - x0);
            rects.push({ x: x, w: w, depth: depth, name: f.name, file: f.file, line: f.line, selfMs: f.selfMs, totalMs: f.totalMs, frame: f });
            if (f.children && f.children.length) walk(f.children, x, x + w, depth + 1);
            x += w;
          }
        }
        walk(roots, 0, 1, 0);
        return rects;
      },
      flameSvg: function () {
        var rects = this.flameRects;
        if (!rects.length) return '';
        var rowH = 22, pad = 2;
        var maxDepth = rects.reduce(function (m, r) { return Math.max(m, r.depth); }, 0);
        var H = (maxDepth + 1) * rowH + 4;
        var W = 1000;
        var parts = ['<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" preserveAspectRatio="none" style="display:block">'];
        for (var i = 0; i < rects.length; i++) {
          var r = rects[i];
          var x = (r.x * W).toFixed(2);
          var w = Math.max(0.5, r.w * W).toFixed(2);
          var y = r.depth * rowH + pad;
          var h = rowH - pad;
          var fill = colorFor(r.name);
          var label = r.name.length > 30 ? r.name.slice(0, 29) + '…' : r.name;
          parts.push(
            '<rect data-i="' + i + '" x="' + x + '" y="' + y + '" width="' + w + '" height="' + h +
            '" rx="1.5" fill="' + fill + '" stroke="#fff" stroke-width="0.5">' +
            '<title>' + NL.esc(r.name) + (r.file ? ' (' + NL.esc(r.file) + ':' + r.line + ')' : '') +
            '  self ' + r.selfMs.toFixed(2) + 'ms / total ' + r.totalMs.toFixed(2) + 'ms</title></rect>',
          );
          if (parseFloat(w) > 42) {
            parts.push('<text data-i="' + i + '" x="' + (parseFloat(x) + 3).toFixed(2) + '" y="' + (y + 14) +
              '" font-size="10" fill="#fff" pointer-events="none">' + NL.esc(label) + '</text>');
          }
        }
        parts.push('</svg>');
        return parts.join('');
      },
    },
    methods: {
      onMessage: function (m) {
        if (!m) return;
        if (m.kind === 'profileCaps') {
          this.caps = m.languages || [];
          if (!this.lang) {
            var avail = this.caps.filter(function (c) { return c.available; })[0];
            this.lang = avail ? avail.id : (this.caps[0] && this.caps[0].id) || 'python';
          }
        } else if (m.kind === 'profileResult') {
          this.applyResult(m);
        }
      },
      applyResult: function (r) {
        this.result = r;
        this.running = false;
        this.zoom = null;
        this.error = r.ok ? '' : (r.error || (r.skipped ? r.skipReason || 'skipped' : 'failed'));
      },
      run: function () {
        if (this.running) return;
        this.running = true;
        this.error = '';
        if (this.ws) this.ws.send({ kind: 'profile', code: this.code, language: this.lang, timeoutMs: 60000, topN: this.topN });
      },
      onFlameClick: function (e) {
        var t = e.target;
        var i = t && t.getAttribute && t.getAttribute('data-i');
        if (i == null) return;
        var r = this.flameRects[+i];
        if (r) this.zoom = r.frame;
      },
      resetZoom: function () { this.zoom = null; },
      focusHotspot: function (name) {
        if (!this.hasFlame) return;
        var f = findFrame(this.result.flame, name);
        if (f) this.zoom = f;
      },
    },
    mounted: function () {
      var self = this;
      this.ws = NL.connectSocket({
        url: 'ws://' + location.host + '/',
        onOpen: function () {
          self.conn = 'on';
          if (self.ws) self.ws.send({ kind: 'profileCaps' });
          if (self.ws) self.ws.send({ kind: 'profileLast' });
          try {
            var lp = localStorage.getItem('nl-profile');
            if (lp) { self.applyResult(JSON.parse(lp)); localStorage.removeItem('nl-profile'); }
          } catch (e) { /* ignore */ }
        },
        onClose: function () { self.conn = 'off'; },
        onMessage: function (m) { self.onMessage(m); },
      });
    },
  };
})(window);
