  // ===================================================================== wizard
  //
  // The project wizard: left filters (language / source), middle template cards,
  // right a form rendered from each template's own params schema. Nothing here
  // knows what a "Spring Boot" or a "cargo crate" is — add a template to a
  // manifest and it appears, with its own fields.
  //
  // Deliberate choices, all of them borrowed from how IDEA's generator behaves:
  //  - unavailable templates stay visible, greyed, with the reason. Hiding them
  //    turns "jdtls is not installed" into "this editor has no Java templates";
  //  - the form is schema-driven, so a provider in another language (Initializr,
  //    cookiecutter) needs no UI code;
  //  - the target directory is a decision shown *outside* the form, because it is
  //    about the workspace, not about the template.

  var WIZ = { open: false, items: [], root: '', lang: 'all', mode: 'all', sources: null, search: '', pick: null, values: {}, error: '', busy: false };

  function wizStyle() {
    if ($('nlWizStyle')) return;
    var css = ''
      + '.wiz-mask{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:60;display:flex;align-items:center;justify-content:center}'
      + '.wiz-box{width:min(1040px,94vw);height:min(640px,88vh);background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:8px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 18px 48px rgba(0,0,0,.45)}'
      + '.wiz-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border)}'
      + '.wiz-title{font-weight:600;flex:1}'
      + '.wiz-body{flex:1;display:grid;grid-template-columns:180px 1fr 340px;min-height:0}'
      + '.wiz-col{overflow:auto;padding:10px 12px}'
      + '.wiz-col+.wiz-col{border-left:1px solid var(--border)}'
      + '.wiz-sec{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-secondary);margin:10px 0 6px}'
      + '.wiz-opt{display:flex;align-items:center;gap:6px;padding:4px 2px;cursor:pointer;border-radius:4px}'
      + '.wiz-opt:hover{background:var(--hover)}'
      + '.wiz-card{border:1px solid var(--border);border-radius:6px;padding:8px 10px;margin-bottom:8px;cursor:pointer}'
      + '.wiz-card:hover{background:var(--hover)}'
      + '.wiz-card.sel{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}'
      + '.wiz-card.off{opacity:.5;cursor:not-allowed}'
      + '.wiz-badge{font-size:10px;padding:1px 6px;border-radius:9px;background:var(--hover);color:var(--text-secondary)}'
      + '.wiz-muted{color:var(--text-secondary);font-size:11px}'
      + '.wiz-field{margin-bottom:10px}'
      + '.wiz-field label{display:block;font-size:12px;margin-bottom:3px}'
      + '.wiz-field input[type=text],.wiz-field select{width:100%;box-sizing:border-box;background:var(--input-bg,#1e1f22);color:inherit;border:1px solid var(--border);border-radius:4px;padding:4px 6px}'
      + '.wiz-field.bad input[type=text],.wiz-field.bad select{border-color:var(--error)}'
      + '.wiz-hint{font-size:11px;color:var(--error);margin-top:2px}'
      + '.wiz-foot{display:flex;align-items:center;gap:8px;padding:10px 14px;border-top:1px solid var(--border)}'
      + '.wiz-foot input[type=text]{flex:1;background:var(--input-bg,#1e1f22);color:inherit;border:1px solid var(--border);border-radius:4px;padding:4px 6px}'
      + '.wiz-btn{padding:5px 14px;border-radius:4px;border:1px solid var(--border);background:var(--hover);cursor:pointer}'
      + '.wiz-btn.primary{background:var(--accent);color:#fff;border-color:var(--accent)}'
      + '.wiz-btn[disabled]{opacity:.5;cursor:default}';
    var st = document.createElement('style');
    st.id = 'nlWizStyle';
    st.textContent = css;
    document.head.appendChild(st);
  }

  function wizOpen() {
    wizStyle();
    WIZ.open = true;
    WIZ.pick = null;
    WIZ.values = {};
    WIZ.error = '';
    WIZ.search = '';
    WIZ.lang = 'all';
    WIZ.mode = 'all';
    WIZ.sources = null;
    WIZ.items = [];
    if (!WIZ.root) WIZ.root = (typeof STATE !== 'undefined' && STATE && STATE.projectDir) || '';
    wizPaint();
    BRIDGE.send({ kind: 'templatesList' });
  }

  function wizClose() {
    WIZ.open = false;
    var mask = $('nlWiz');
    if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
    var ed = document.querySelector('.CodeMirror');
    if (ed && ed.CodeMirror) ed.CodeMirror.focus();
  }

  function wizLangs() {
    var seen = {};
    var out = [];
    for (var i = 0; i < WIZ.items.length; i++) {
      var l = WIZ.items[i].language;
      if (!seen[l]) { seen[l] = 1; out.push(l); }
    }
    return out.sort();
  }

  function wizSources() {
    var seen = {};
    var out = [];
    for (var i = 0; i < WIZ.items.length; i++) {
      var s = WIZ.items[i].source || 'builtin';
      if (!seen[s]) { seen[s] = 1; out.push(s); }
    }
    return out.sort();
  }

  function wizVisible() {
    var q = WIZ.search.toLowerCase();
    return WIZ.items.filter(function (t) {
      if (WIZ.lang !== 'all' && t.language !== WIZ.lang) return false;
      if (WIZ.mode !== 'all' && (t.kind || 'project') !== WIZ.mode) return false;
      if (WIZ.sources && !WIZ.sources[t.source || 'builtin']) return false;
      if (q && (t.name + ' ' + (t.description || '') + ' ' + t.language).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }

  /** The right column: one group per param.group, controls per param.kind. */
  function wizForm(t) {
    if (!t) return '<div class="wiz-muted">从中间选一个模板。</div>';
    var params = t.params || [];
    if (!params.length) return '<div class="wiz-muted">这个模板没有参数。</div>';
    var groups = [];
    var byGroup = {};
    for (var i = 0; i < params.length; i++) {
      var g = params[i].group || '参数';
      if (!byGroup[g]) { byGroup[g] = []; groups.push(g); }
      byGroup[g].push(params[i]);
    }
    var html = '';
    for (var gi = 0; gi < groups.length; gi++) {
      html += '<div class="wiz-sec">' + esc(groups[gi]) + '</div>';
      var list = byGroup[groups[gi]];
      for (var pi = 0; pi < list.length; pi++) html += wizField(t, list[pi]);
    }
    return html;
  }

  function wizValue(t, p) {
    var key = t.language + ':' + t.id + ':' + p.key;
    if (Object.prototype.hasOwnProperty.call(WIZ.values, key)) return WIZ.values[key];
    if (p.kind === 'boolean') return p.default === true;
    if (p.kind === 'multiselect') return Array.isArray(p.default) ? p.default : [];
    return typeof p.default === 'string' ? p.default : '';
  }

  function wizSetValue(t, p, v) {
    WIZ.values[t.language + ':' + t.id + ':' + p.key] = v;
  }

  function wizField(t, p) {
    var v = wizValue(t, p);
    var name = 'wiz-' + p.key;
    var html = '<div class="wiz-field" data-field="' + esc(p.key) + '">';
    if (p.kind === 'boolean') {
      html += '<label style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-p="' + esc(p.key) + '"' + (v ? ' checked' : '') + '> ' + esc(p.label) + '</label>';
    } else {
      html += '<label>' + esc(p.label) + (p.required ? ' *' : '') + '</label>';
      if (p.kind === 'select') {
        html += '<select data-p="' + esc(p.key) + '">';
        var opts = p.options || [];
        for (var i = 0; i < opts.length; i++) {
          html += '<option value="' + esc(opts[i].value) + '"' + (opts[i].value === v ? ' selected' : '') + '>' + esc(opts[i].label) + '</option>';
        }
        html += '</select>';
      } else if (p.kind === 'multiselect') {
        var list = p.options || [];
        html += '<div style="max-height:140px;overflow:auto;border:1px solid var(--border);border-radius:4px;padding:4px">';
        for (var j = 0; j < list.length; j++) {
          var on = v.indexOf(list[j].value) >= 0;
          html += '<label class="wiz-opt"><input type="checkbox" data-mp="' + esc(p.key) + '" value="' + esc(list[j].value) + '"' + (on ? ' checked' : '') + '> ' + esc(list[j].label) + '</label>';
        }
        html += '</div>';
      } else {
        html += '<input type="text" data-p="' + esc(p.key) + '" value="' + esc(String(v)) + '" id="' + name + '">';
      }
      if (p.hint) html += '<div class="wiz-muted" style="font-size:11px">' + esc(p.hint) + '</div>';
    }
    html += '<div class="wiz-hint" style="display:none"></div></div>';
    return html;
  }

  function wizPaint() {
    var mask = $('nlWiz');
    if (!mask) {
      mask = document.createElement('div');
      mask.id = 'nlWiz';
      mask.className = 'wiz-mask';
      document.body.appendChild(mask);
    }
    var t = WIZ.pick ? wizFind(WIZ.pick) : null;
    var langs = wizLangs();
    var srcs = wizSources();
    var visible = wizVisible();

    var left = '<div class="wiz-sec">类型</div>';
    left += '<label class="wiz-opt"><input type="radio" name="wizMode" value="all"' + (WIZ.mode === 'all' ? ' checked' : '') + '> 全部</label>';
    left += '<label class="wiz-opt"><input type="radio" name="wizMode" value="project"' + (WIZ.mode === 'project' ? ' checked' : '') + '> 新项目</label>';
    left += '<label class="wiz-opt"><input type="radio" name="wizMode" value="file"' + (WIZ.mode === 'file' ? ' checked' : '') + '> 新文件</label>';
    left += '<div class="wiz-sec">语言</div>';
    left += '<label class="wiz-opt"><input type="radio" name="wizLang" value="all"' + (WIZ.lang === 'all' ? ' checked' : '') + '> 全部</label>';
    for (var i = 0; i < langs.length; i++) {
      left += '<label class="wiz-opt"><input type="radio" name="wizLang" value="' + esc(langs[i]) + '"' + (WIZ.lang === langs[i] ? ' checked' : '') + '> ' + esc(langs[i]) + '</label>';
    }
    left += '<div class="wiz-sec">来源</div>';
    for (var j = 0; j < srcs.length; j++) {
      var on = !WIZ.sources || WIZ.sources[srcs[j]];
      left += '<label class="wiz-opt"><input type="checkbox" data-src="' + esc(srcs[j]) + '"' + (on ? ' checked' : '') + '> ' + esc(srcs[j]) + '</label>';
    }

    var mid = '<input type="text" id="wizSearch" placeholder="搜索模板…" value="' + esc(WIZ.search) + '" style="width:100%;box-sizing:border-box;margin-bottom:8px;background:var(--input-bg,#1e1f22);color:inherit;border:1px solid var(--border);border-radius:4px;padding:4px 6px">';
    if (!WIZ.items.length) {
      mid += '<div class="wiz-muted">正在读取模板…</div>';
    } else if (!visible.length) {
      mid += '<div class="wiz-muted">这个筛选下没有模板。换一个语言或来源试试。</div>';
    } else {
      for (var k = 0; k < visible.length; k++) {
        var it = visible[k];
        var sel = WIZ.pick && WIZ.pick.language === it.language && WIZ.pick.id === it.id;
        mid += '<div class="wiz-card' + (sel ? ' sel' : '') + (it.available ? '' : ' off') + '" data-lang="' + esc(it.language) + '" data-id="' + esc(it.id) + '">'
          + '<div style="display:flex;align-items:center;gap:6px"><b>' + esc(it.name) + '</b>'
          + '<span class="wiz-badge">' + esc(it.source) + '</span>'
          + '<span class="wiz-badge">' + esc(it.language) + '</span></div>'
          + (it.description ? '<div class="wiz-muted">' + esc(it.description) + '</div>' : '')
          + ((it.kind || 'project') === 'file' ? '<div class="wiz-muted">生成一个文件</div>' : '')
          + (it.available ? '' : '<div class="wiz-muted" style="color:var(--error)">不可用：' + esc(it.reason || '缺少依赖') + '</div>')
          + '</div>';
      }
    }

    var right = '<div class="wiz-sec">' + (t ? esc(t.name) : '参数') + '</div>' + wizForm(t);

    var dir = wizTargetDir(t);
    var foot = '<span class="wiz-muted">位置</span>'
      + '<input type="text" id="wizDir" value="' + esc(dir) + '">'
      + '<label class="wiz-muted" style="display:flex;gap:4px;align-items:center"><input type="checkbox" id="wizNonEmpty"> 允许非空</label>'
      + '<button class="wiz-btn" id="wizCancel">取消</button>'
      + '<button class="wiz-btn primary" id="wizCreate"' + (t && t.available && !WIZ.busy ? '' : ' disabled') + '>' + (WIZ.busy ? '生成中…' : (t && t.kind === 'file' ? '创建文件' : '创建')) + '</button>';

    mask.innerHTML = '<div class="wiz-box">'
      + '<div class="wiz-head"><span class="wiz-title">新建项目</span><span class="wiz-muted">Ctrl+Alt+N</span></div>'
      + '<div class="wiz-body">'
      + '<div class="wiz-col">' + left + '</div>'
      + '<div class="wiz-col">' + mid + '</div>'
      + '<div class="wiz-col">' + right + (WIZ.error ? '<div class="wiz-hint">' + esc(WIZ.error) + '</div>' : '') + '</div>'
      + '</div>'
      + '<div class="wiz-foot">' + foot + '</div>'
      + '</div>';

    wizBind(t);
  }

  /** Target = workspace root + the template's suggested subdirectory. */
  function wizTargetDir(t) {
    if (!WIZ.dir) {
      var base = String(WIZ.root || '').replace(/[\\/]+$/, '');
      var sub = '';
      if (t && t.suggestedDir) {
        sub = String(t.suggestedDir).replace(/\{\{(\w+)\}\}/g, function (_, key) {
          var p = (t.params || []).filter(function (x) { return x.key === key; })[0];
          var v = p ? wizValue(t, p) : '';
          return typeof v === 'string' ? v : '';
        });
      }
      WIZ.dir = base + (sub ? '/' + sub : '');
    }
    return WIZ.dir;
  }

  function wizBind(t) {
    var mask = $('nlWiz');
    if (!mask) return;
    mask.querySelectorAll('input[name=wizLang]').forEach(function (r) {
      r.addEventListener('change', function () { WIZ.lang = r.value; wizPaint(); });
    });
    mask.querySelectorAll('input[name=wizMode]').forEach(function (r) {
      r.addEventListener('change', function () { WIZ.mode = r.value; WIZ.pick = null; WIZ.dir = ''; wizPaint(); });
    });
    mask.querySelectorAll('input[data-src]').forEach(function (c) {
      c.addEventListener('change', function () {
        WIZ.sources = WIZ.sources || {};
        WIZ.sources[c.getAttribute('data-src')] = c.checked;
        wizPaint();
      });
    });
    var search = mask.querySelector('#wizSearch');
    if (search) search.addEventListener('input', function () { WIZ.search = search.value; wizPaint(); });

    mask.querySelectorAll('.wiz-card').forEach(function (card) {
      card.addEventListener('click', function () {
        if (card.className.indexOf('off') >= 0) return;
        WIZ.pick = { language: card.getAttribute('data-lang'), id: card.getAttribute('data-id') };
        WIZ.dir = '';
        WIZ.error = '';
        wizPaint();
      });
    });

    if (t) {
      mask.querySelectorAll('input[data-p],select[data-p]').forEach(function (el) {
        el.addEventListener('input', function () { wizSaveField(t, el); });
        el.addEventListener('change', function () { wizSaveField(t, el); });
      });
      mask.querySelectorAll('input[data-mp]').forEach(function (el) {
        el.addEventListener('change', function () {
          var key = el.getAttribute('data-mp');
          var p = (t.params || []).filter(function (x) { return x.key === key; })[0];
          var cur = (wizValue(t, p) || []).slice();
          var at = cur.indexOf(el.value);
          if (el.checked && at < 0) cur.push(el.value);
          if (!el.checked && at >= 0) cur.splice(at, 1);
          wizSetValue(t, p, cur);
        });
      });
    }

    var dirInput = mask.querySelector('#wizDir');
    if (dirInput) dirInput.addEventListener('input', function () { WIZ.dir = dirInput.value; });
    var cancel = mask.querySelector('#wizCancel');
    if (cancel) cancel.addEventListener('click', wizClose);
    var create = mask.querySelector('#wizCreate');
    if (create) create.addEventListener('click', function () { wizCreate(t); });
  }

  /** Keep the form state while re-rendering, and refresh the suggested directory. */
  function wizSaveField(t, el) {
    var key = el.getAttribute('data-p');
    var p = (t.params || []).filter(function (x) { return x.key === key; })[0];
    if (!p) return;
    wizSetValue(t, p, p.kind === 'boolean' ? el.checked : el.value);
    if (!WIZ.dir || WIZ.dir === wizTargetDir(t)) {
      WIZ.dir = '';
      var dirInput = $('nlWiz') && $('nlWiz').querySelector('#wizDir');
      if (dirInput) dirInput.value = wizTargetDir(t);
    }
  }

  function wizFind(pick) {
    for (var i = 0; i < WIZ.items.length; i++) {
      if (WIZ.items[i].language === pick.language && WIZ.items[i].id === pick.id) return WIZ.items[i];
    }
    return null;
  }

  /**
   * Check the form before the round trip.
   *
   * The server validates again — this exists so the user sees which field is wrong
   * without waiting for a network hop, not as the only line of defence.
   */
  function wizValidate(t) {
    var params = t.params || [];
    for (var i = 0; i < params.length; i++) {
      var p = params[i];
      var v = wizValue(t, p);
      var bad = '';
      if (p.kind !== 'boolean' && p.kind !== 'multiselect') {
        if (p.required && !v) bad = p.label + ' 不能为空';
        else if (p.pattern && v && !new RegExp(p.pattern).test(String(v))) bad = p.hint || (p.label + ' 格式不正确');
      }
      var field = $('nlWiz').querySelector('[data-field="' + p.key + '"]');
      if (!field) continue;
      var hint = field.querySelector('.wiz-hint');
      if (bad) {
        field.className = 'wiz-field bad';
        if (hint) { hint.textContent = bad; hint.style.display = ''; }
        return false;
      }
      field.className = 'wiz-field';
      if (hint) hint.style.display = 'none';
    }
    return true;
  }

  function wizCreate(t) {
    if (!t || WIZ.busy) return;
    if (!t.available) { WIZ.error = t.reason || '这个模板不可用'; wizPaint(); return; }
    if (!wizValidate(t)) return;
    var dir = String(WIZ.dir || '').trim();
    if (!dir) { WIZ.error = '请填写目标目录'; wizPaint(); return; }
    var params = {};
    var list = t.params || [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var v = wizValue(t, p);
      if (p.kind === 'multiselect') params[p.key] = v;
      else if (p.kind === 'boolean') params[p.key] = v === true;
      else params[p.key] = String(v);
    }
    var allow = $('nlWiz') && $('nlWiz').querySelector('#wizNonEmpty');
    WIZ.busy = true;
    WIZ.error = '';
    wizPaint();
    BRIDGE.send({
      kind: 'templatesGenerate',
      language: t.language,
      templateId: t.id,
      dir: dir,
      params: params,
      allowNonEmpty: !!(allow && allow.checked),
    });
  }

  function wizOnTemplates(m) {
    if (typeof m.root === 'string' && m.root) WIZ.root = m.root;
    WIZ.items = Array.isArray(m.items) ? m.items : [];
    if (WIZ.pick && !wizFind(WIZ.pick)) WIZ.pick = null;
    if (!WIZ.pick && WIZ.items.length) {
      var first = WIZ.items.filter(function (x) { return x.available; })[0];
      if (first) WIZ.pick = { language: first.language, id: first.id };
    }
    wizPaint();
  }

  function wizOnGenerated(m) {
    WIZ.busy = false;
    if (m && m.ok) {
      var count = (m.files || []).length;
      toast('已生成 ' + count + ' 个文件 · ' + (m.dir || ''));
      // A single generated file is what the user wants to see: a project is not.
      var first = (m.files || [])[0];
      if (count === 1 && first && first.path && WIZ.root && String(m.dir || '') === String(WIZ.root).replace(/[\\/]+$/, '')) {
        openFile(first.path);
      }
      WIZ.dir = '';
      wizClose();
      BRIDGE.send({ kind: 'fsList', path: '.' });
      return;
    }
    WIZ.error = (m && m.message) || '生成失败';
    wizPaint();
  }
