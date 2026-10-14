/**
 * Nolanguage panel — shared browser helpers.
 *
 * A plain (non-module) script on purpose: both UI pages inline it verbatim,
 * exactly like they inline the vendored Vue runtime, so each page stays a
 * single self-contained HTML document that works with no network. It defines
 * `window.NL` and is loaded before the page application.
 *
 * Kept framework-free on purpose — only the page applications use Vue.
 */
(function (global) {
  'use strict';

  var LEVEL_NAME = {
    0: 'TRACE', 1: 'DEBUG', 2: 'INFO', 3: 'WARN',
    4: 'ERROR', 5: 'FATAL', 10: 'AUDIT', 11: 'METRIC',
  };
  var LEVEL_VALUE = { TRACE: 0, DEBUG: 1, INFO: 2, WARN: 3, ERROR: 4, FATAL: 5 };
  /** Display order used by the footer level counters. */
  var LEVEL_ORDER = ['ERROR', 'FATAL', 'WARN', 'INFO', 'DEBUG', 'TRACE'];

  /** HTML text escape. */
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
    });
  }

  /** Attribute-value escape (keeps both quote styles safe). */
  function attr(s) {
    return esc(s).replace(/'/g, '&#39;');
  }

  /** `14:03:09.512` from a millisecond timestamp. */
  function clockOf(ts) {
    return new Date(ts).toISOString().slice(11, 23);
  }

  /** First 8 chars of an id — enough to eyeball a trace or commit. */
  function shortId(id) {
    return id ? String(id).slice(0, 8) : '';
  }

  /**
   * Level gate shared by both pages. AUDIT (10) and METRIC (11) are
   * numerically above FATAL but are categories, not severities, so a
   * "WARN and worse" filter must still show them.
   */
  function visibleByLevel(logs, minLevel) {
    var out = [];
    for (var i = 0; i < logs.length; i++) {
      var r = logs[i];
      if (r.level >= minLevel || r.level === 10 || r.level === 11) out.push(r);
    }
    return out;
  }

  /**
   * Sparkline geometry for the last `n` values, normalised into an `h`-pixel
   * tall chart. Returns plain bar descriptors so the caller can render them
   * with whatever mechanism it likes (Vue `h()` here).
   */
  function sparkBars(values, n, w, h) {
    var v = values.slice(-n);
    var max = 1;
    for (var i = 0; i < v.length; i++) if (v[i] > max) max = v[i];
    var slot = w / n;
    var out = [];
    for (var j = 0; j < v.length; j++) {
      var bh = Math.max(1, Math.round((v[j] / max) * (h - 2)));
      out.push({
        x: (j * slot).toFixed(1),
        y: h - bh,
        width: Math.max(1, slot - 0.8).toFixed(1),
        height: bh,
      });
    }
    return out;
  }

  /**
   * WebSocket with backoff reconnect. Returns a handle whose `send` is always
   * safe to call (it no-ops while the socket is not open), so callers never
   * need to guard.
   */
  function connectSocket(options) {
    var url = options.url;
    var ws = null;
    var retry = 0;
    var timer = null;
    var closed = false;

    function open() {
      if (closed) return;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        schedule();
        return;
      }
      ws.onopen = function () {
        retry = 0;
        if (options.onOpen) options.onOpen();
      };
      ws.onclose = function () {
        if (options.onClose) options.onClose();
        schedule();
      };
      ws.onerror = function () {
        if (options.onError) options.onError();
      };
      ws.onmessage = function (ev) {
        var msg;
        try {
          msg = JSON.parse(ev.data);
        } catch (e) {
          return; // a malformed frame must never break the connection
        }
        options.onMessage(msg);
      };
    }

    function schedule() {
      if (closed) return;
      retry = Math.min(retry + 1, 6);
      timer = setTimeout(open, 400 * retry);
    }

    open();
    return {
      send: function (obj) {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
      },
      state: function () {
        return ws ? ws.readyState : 3;
      },
      close: function () {
        closed = true;
        if (timer) clearTimeout(timer);
        if (ws) {
          ws.onclose = null;
          try {
            ws.close();
          } catch (e) {
            /* already gone */
          }
        }
      },
    };
  }

  /** LSP CompletionItemKind -> short label. */
  var KIND_LABEL = {
    1: 'text', 2: 'method', 3: 'func', 4: 'ctor', 5: 'field', 6: 'var',
    7: 'class', 8: 'iface', 9: 'module', 10: 'prop', 13: 'enum',
    14: 'keyword', 15: 'snippet', 21: 'const', 22: 'struct',
  };

  global.NL = {
    LEVEL_NAME: LEVEL_NAME,
    LEVEL_VALUE: LEVEL_VALUE,
    LEVEL_ORDER: LEVEL_ORDER,
    KIND_LABEL: KIND_LABEL,
    esc: esc,
    attr: attr,
    clockOf: clockOf,
    shortId: shortId,
    visibleByLevel: visibleByLevel,
    sparkBars: sparkBars,
    connectSocket: connectSocket,
  };
})(window);
