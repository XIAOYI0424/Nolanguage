/**
 * Debug Observatory page — Vue 3 application (in-DOM template).
 *
 * The page is a *thin* client on purpose: the engine already aggregates the
 * samples (hot stacks, stalls, watch history) and pushes one `view` message at
 * 4 Hz. That keeps the wire small, keeps the rendering deterministic, and means
 * a slow browser tab can never make the engine drop agent events.
 *
 * Commands go the other way: add/remove a watch, ask for a snapshot. Nothing
 * else — the page never evaluates anything.
 */
(function () {
  'use strict';

  var Vue = window.Vue;
  var reactive = Vue.reactive;
  var computed = Vue.computed;
  var ref = Vue.ref;
  var h = Vue.h;
  var createApp = Vue.createApp;

  var WS_URL = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/';
  var PING_MS = 20000;
  var RETRY_MS = 1000;

  var app = createApp({
    setup: function () {
      var st = reactive({
        conn: 'connecting',
        view: {
          state: 'listening',
          target: '',
          lang: '',
          pid: 0,
          agentVersion: '',
          hz: 10,
          actualHz: 0,
          samples: 0,
          hot: [],
          stalls: [],
          watches: [],
          snapshots: [],
          exceptions: [],
          dropped: 0,
          badLines: 0,
          oversized: 0,
          baselines: [],
          replay: null,
        },
        draft: '',
        /** Freeze the view: sampling keeps running, the panel stops moving. */
        paused: false,
        selected: '',
        /** Snapshot id the user pinned by pressing "snapshot now". */
        pin: '',
        /** The last diff, or null while the tree is shown. */
        diff: null,
      });

      var socket = null;
      var retryTimer = null;
      var pingTimer = null;

      function send(msg) {
        if (socket && socket.readyState === 1) socket.send(JSON.stringify(msg));
      }

      function connect() {
        try {
          socket = new WebSocket(WS_URL);
        } catch (err) {
          scheduleRetry();
          return;
        }
        socket.onopen = function () {
          st.conn = 'connected';
        };
        socket.onclose = function () {
          st.conn = 'reconnecting';
          scheduleRetry();
        };
        socket.onerror = function () {
          st.conn = 'error';
        };
        socket.onmessage = function (event) {
          var msg;
          try {
            msg = JSON.parse(event.data);
          } catch (err) {
            return;
          }
          if (msg.kind === 'view') {
            // Pausing is a *view* concern only: the engine keeps sampling and the
            // agent keeps sending, so resuming shows the present, not a backlog.
            if (st.paused) return;
            st.view = msg.view;
            return;
          }
          if (msg.kind === 'diff') {
            // A diff is a captured comparison, not a live stream: it keeps the
            // moment it was asked for so the numbers cannot drift under the
            // reader while they are looking at them.
            st.diff = msg.diff;
            return;
          }
          if (msg.kind === 'snapshot') {
            // An explicit snapshot is pinned so the panel stops following the
            // 2 Hz live locals the moment the user asks for something specific.
            if (String(msg.snapshot.id).indexOf('snap-') === 0) st.pin = msg.snapshot.id;
            var list = (st.view.snapshots || []).slice();
            var at = -1;
            for (var i = 0; i < list.length; i++) if (list[i].id === msg.snapshot.id) at = i;
            if (at >= 0) list[at] = msg.snapshot;
            else list.push(msg.snapshot);
            st.view = Object.assign({}, st.view, { snapshots: list });
            return;
          }
        };
      }

      function scheduleRetry() {
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(connect, RETRY_MS);
      }

      connect();
      pingTimer = setInterval(function () {
        send({ kind: 'ping' });
      }, PING_MS);

      if (Vue.onUnmounted) {
        Vue.onUnmounted(function () {
          if (retryTimer) clearTimeout(retryTimer);
          if (pingTimer) clearInterval(pingTimer);
          if (socket) socket.close();
        });
      }

      // ------------------------------------------------------------ derived

      var current = computed(function () {
        var list = st.view.snapshots || [];
        function byId(id) {
          for (var i = list.length - 1; i >= 0; i--) if (list[i].id === id) return list[i];
          return null;
        }
        if (st.pin) {
          var pinned = byId(st.pin);
          if (pinned) return pinned;
        }
        return byId('live-locals');
      });

      var stateText = computed(function () {
        if (st.conn !== 'connected') return st.conn;
        var s = st.view.state;
        if (s === 'attached') return 'attached';
        if (s === 'detached') return 'agent exited';
        if (s === 'rejected') return 'rejected';
        if (s === 'closed') return 'closed';
        return 'waiting for agent';
      });

      var stateClass = computed(function () {
        if (st.conn !== 'connected') return 'bad';
        if (st.view.state === 'attached') return 'on';
        if (st.view.state === 'rejected') return 'bad';
        return 'warn';
      });

      /** Does this agent provide live locals? JS does not — say so, not nothing. */
      var hasLocals = computed(function () {
        var caps = st.view.caps || [];
        return caps.indexOf('locals') >= 0;
      });

      /** Diffing needs a baseline captured for the snapshot currently shown. */
      var canDiff = computed(function () {
        var snap = current.value;
        if (!snap) return false;
        var list = st.view.baselines || [];
        return list.indexOf(snap.id) >= 0;
      });

      var replayPct = computed(function () {
        var r = st.view.replay;
        if (!r || !r.total) return '0%';
        return Math.round((r.position / r.total) * 100) + '%';
      });

      var hzText = computed(function () {
        var hz = st.view.actualHz || 0;
        return hz > 0 ? hz.toFixed(1) + ' Hz' : st.view.hz + ' Hz (requested)';
      });

      // ------------------------------------------------------------ actions

      function addWatch() {
        var expr = String(st.draft || '').trim();
        if (!expr) return;
        send({ kind: 'watch-add', expr: expr });
        st.draft = '';
      }

      function removeWatch(expr) {
        send({ kind: 'watch-remove', expr: expr });
      }

      function select(stack) {
        st.selected = st.selected === stack ? '' : stack;
        // Clicking a stack means "show me where this is": unpin and follow the
        // live locals again.
        st.pin = '';
      }

      function takeSnapshot() {
        st.pin = '';
        send({ kind: 'snapshot', path: 'locals' });
      }

      function refresh() {
        st.pin = '';
        send({ kind: 'snapshot', path: 'locals' });
      }

      function togglePause() {
        st.paused = !st.paused;
      }

      function markBaseline() {
        var snap = current.value;
        if (!snap) return;
        send({ kind: 'baseline', id: snap.id });
      }

      function showDiff() {
        var snap = current.value;
        if (!snap) return;
        st.diff = null;
        send({ kind: 'diff', id: snap.id });
      }

      function closeDiff() {
        st.diff = null;
      }

      function pct(share) {
        var v = Math.round((share || 0) * 100);
        return (v < 1 ? '<1' : String(v)) + '%';
      }

      /** One-line value for the watch list. */
      function summary(node) {
        if (!node) return '—';
        if (node.k === 'prim') return node.v;
        if (node.k === 'trunc') return '[' + node.why + (node.t ? ' ' + node.t : '') + ']';
        if (node.k === 'seq') return (node.t || 'seq') + '[' + node.n + ']';
        if (node.k === 'map') return (node.t || 'map') + '{' + node.n + '}';
        if (node.k === 'obj') return (node.t || 'object') + '{' + node.fields.length + '}';
        return '?';
      }

      return {
        st: st,
        current: current,
        stateText: stateText,
        stateClass: stateClass,
        hzText: hzText,
        hasLocals: hasLocals,
        canDiff: canDiff,
        replayPct: replayPct,
        markBaseline: markBaseline,
        showDiff: showDiff,
        closeDiff: closeDiff,
        addWatch: addWatch,
        removeWatch: removeWatch,
        select: select,
        takeSnapshot: takeSnapshot,
        refresh: refresh,
        pct: pct,
        summary: summary,
      };
    },
  });

  /**
   * Recursive value tree.
   *
   * Rendered with `h()` rather than an in-DOM template because it refers to
   * itself; a browser-parsed `<snode>` inside `<snode>` would work but the
   * expansion state has to live somewhere, and a component instance is the
   * right place. Depth is bounded by the serializer, so recursion terminates.
   */
  app.component('snode', {
    props: {
      node: { type: Object, default: function () { return { k: 'trunc', why: 'unsupported' }; } },
      name: { type: String, default: '' },
      path: { type: String, default: '$' },
      depth: { type: Number, default: 0 },
    },
    setup: function (props) {
      var open = ref(props.depth < 2);

      function toggle() {
        open.value = !open.value;
      }

      function label() {
        if (!props.name) return [];
        return [h('span', { class: 'k' }, props.name), h('span', { class: 'k' }, ': ')];
      }

      function primClass(t) {
        if (t === 'str') return 's';
        if (t === 'bool') return 'b';
        if (t === 'none') return 'none';
        return 'n';
      }

      return function () {
        var n = props.node || { k: 'trunc', why: 'unsupported' };

        if (n.k === 'prim') {
          return h('div', { class: 'line' }, label().concat([h('span', { class: primClass(n.t) }, n.v)]));
        }
        if (n.k === 'trunc') {
          return h('div', { class: 'line' }, label().concat([
            h('span', { class: 'tr' }, '[' + n.why + (n.t ? ' ' + n.t : '') + ']'),
          ]));
        }

        var kind = n.k;
        var count = kind === 'seq' ? n.n : kind === 'map' ? n.n : (n.fields || []).length;
        var unit = kind === 'obj' ? ' fields' : ' items';

        var head = h('div', { class: 'line' }, [
          h('span', { class: 'tw', onClick: toggle }, open.value ? '▾' : '▸'),
        ].concat(label()).concat([
          h('span', { class: 'ty' }, n.t || kind),
          h('span', { class: 'more' }, ' ' + count + unit),
        ]).concat(n.cycle ? [h('span', { class: 'k cycle' }, ' ↺ ' + n.cycle)] : []));

        if (!open.value) return h('div', { class: 'tn' }, [head]);

        var kids = [];
        if (kind === 'obj') {
          (n.fields || []).forEach(function (pair) {
            kids.push(h('snode', { node: pair[1], name: pair[0], path: props.path + '.' + pair[0], depth: props.depth + 1 }));
          });
        } else if (kind === 'seq') {
          (n.items || []).forEach(function (item, i) {
            kids.push(h('snode', { node: item, name: '[' + i + ']', path: props.path + '[' + i + ']', depth: props.depth + 1 }));
          });
        } else if (kind === 'map') {
          (n.entries || []).forEach(function (pair, i) {
            var key = pair[0] && pair[0].k === 'prim' ? pair[0].v : '#' + i;
            kids.push(h('snode', { node: pair[1], name: '[' + key + ']', path: props.path + '[' + i + ']', depth: props.depth + 1 }));
          });
        }
        if (n.more) kids.push(h('div', { class: 'more', style: 'padding-left:13px' }, '… ' + n.more + ' more'));

        return h('div', { class: 'tn' }, [head].concat(kids));
      };
    },
  });

  app.mount('#app');
})();
