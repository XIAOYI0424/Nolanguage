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

  // ------------------------------------------------------- import a project
  //
  // The files already exist, so this is not a wizard: pick a directory, see what
  // markers it contains, and switch the explorer to it. One level deep — a deep
  // scan of a home directory is slow and the answer is almost always a sibling.

  var IMP = { dir: '', items: [], pick: null, busy: false };

  function impOpen() {
    wizStyle();
    IMP.items = [];
    IMP.pick = null;
    IMP.dir = '';
    impPaint();
    BRIDGE.send({ kind: 'projectsDetect' });
  }

  function impClose() {
    var mask = $('nlImp');
    if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
  }

  function impPaint() {
    var mask = $('nlImp');
    if (!mask) {
      mask = document.createElement('div');
      mask.id = 'nlImp';
      mask.className = 'wiz-mask';
      document.body.appendChild(mask);
    }
    var rows = '';
    if (!IMP.items.length) {
      rows = '<div class="wiz-muted">' + (IMP.busy ? '正在扫描…' : '这个目录下没有找到项目标记（Cargo.toml / package.json / pyproject.toml / go.mod / pom.xml / CMakeLists.txt）。') + '</div>';
    } else {
      for (var i = 0; i < IMP.items.length; i++) {
        var it = IMP.items[i];
        var sel = IMP.pick === it.dir;
        rows += '<div class="wiz-card' + (sel ? ' sel' : '') + '" data-dir="' + esc(it.dir) + '">'
          + '<div style="display:flex;align-items:center;gap:6px"><b>' + esc(it.name) + '</b>'
          + '<span class="wiz-badge">' + esc(it.language) + '</span>'
          + '<span class="wiz-badge">' + esc(it.marker) + '</span></div>'
          + '<div class="wiz-muted">' + esc(it.dir) + (it.hints && it.hints.length ? ' · ' + esc(it.hints.join(' ')) : '') + '</div>'
          + '</div>';
      }
    }
    mask.innerHTML = '<div class="wiz-box" style="height:min(520px,80vh)">'
      + '<div class="wiz-head"><span class="wiz-title">打开项目</span><span class="wiz-muted">Ctrl+Alt+O</span></div>'
      + '<div class="wiz-body" style="grid-template-columns:1fr">'
      + '<div class="wiz-col">'
      + '<div class="wiz-sec">目录</div>'
      + '<input type="text" id="impDir" placeholder="留空 = 当前工作区" value="' + esc(IMP.dir) + '" style="width:100%;box-sizing:border-box;background:var(--input-bg,#1e1f22);color:inherit;border:1px solid var(--border);border-radius:4px;padding:4px 6px">'
      + '<div class="wiz-sec">找到 ' + IMP.items.length + ' 个项目</div>'
      + rows
      + '</div></div>'
      + '<div class="wiz-foot">'
      + '<button class="wiz-btn" id="impCancel">取消</button>'
      + '<button class="wiz-btn primary" id="impOpenBtn"' + (IMP.pick ? '' : ' disabled') + '>打开</button>'
      + '</div></div>';

    var dirInput = mask.querySelector('#impDir');
    if (dirInput) {
      dirInput.addEventListener('input', function () { IMP.dir = dirInput.value; });
      dirInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { IMP.busy = true; impPaint(); BRIDGE.send({ kind: 'projectsDetect', dir: IMP.dir }); }
      });
    }
    mask.querySelectorAll('.wiz-card').forEach(function (card) {
      card.addEventListener('click', function () {
        IMP.pick = card.getAttribute('data-dir');
        impPaint();
      });
      card.addEventListener('dblclick', function () { impOpenProject(card.getAttribute('data-dir')); });
    });
    var cancel = mask.querySelector('#impCancel');
    if (cancel) cancel.addEventListener('click', impClose);
    var openBtn = mask.querySelector('#impOpenBtn');
    if (openBtn) openBtn.addEventListener('click', function () { if (IMP.pick) impOpenProject(IMP.pick); });
  }

  function impOpenProject(dir) {
    if (!dir) return;
    BRIDGE.send({ kind: 'openFolder', path: dir });
    toast('已切换到 ' + dir);
    impClose();
  }

  function impOnCandidates(m) {
    IMP.busy = false;
    IMP.items = Array.isArray(m.items) ? m.items : [];
    if (typeof m.dir === 'string' && m.dir) IMP.dir = m.dir;
    if (IMP.items.length === 1) IMP.pick = IMP.items[0].dir;
    impPaint();
  }

  // ------------------------------------------------------ add a dependency
  //
  // The panel runs the ecosystem's own command and shows its output. It does not
  // resolve versions or edit lock files: the toolchain owns that, and a failed
  // add leaves the project untouched.

  var DEP = { dir: '', label: '', spec: '', output: '', error: '', busy: false };

  function depOpen() {
    wizStyle();
    DEP.dir = '';
    DEP.label = '';
    DEP.spec = '';
    DEP.output = '';
    DEP.error = '';
    DEP.busy = false;
    depPaint();
    BRIDGE.send({ kind: 'depsAdd', dryRun: true });
  }

  function depClose() {
    var mask = $('nlDep');
    if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
  }

  function depPaint() {
    var mask = $('nlDep');
    if (!mask) {
      mask = document.createElement('div');
      mask.id = 'nlDep';
      mask.className = 'wiz-mask';
      document.body.appendChild(mask);
    }
    var eco = DEP.label ? '<span class="wiz-badge">' + esc(DEP.label) + '</span>' : '<span class="wiz-muted">未识别到项目</span>';
    mask.innerHTML = '<div class="wiz-box" style="width:min(720px,92vw);height:auto;max-height:80vh">'
      + '<div class="wiz-head"><span class="wiz-title">添加依赖</span>' + eco + '<span class="wiz-muted">Ctrl+Alt+D</span></div>'
      + '<div class="wiz-col" style="padding:12px 14px">'
      + '<div class="wiz-field"><label>目录</label><input type="text" id="depDir" value="' + esc(DEP.dir) + '" placeholder="留空 = 当前项目"></div>'
      + '<div class="wiz-field"><label>依赖</label><input type="text" id="depSpec" value="' + esc(DEP.spec) + '" placeholder="lodash · @scope/pkg@1.2 · serde@1 · github.com/x/y@v1"></div>'
      + (DEP.error ? '<div class="wiz-hint">' + esc(DEP.error) + '</div>' : '')
      + (DEP.output ? '<div class="wiz-sec">输出</div><pre style="max-height:220px;overflow:auto;font-size:11px;white-space:pre-wrap;margin:0">' + esc(DEP.output) + '</pre>' : '')
      + '</div>'
      + '<div class="wiz-foot">'
      + '<button class="wiz-btn" id="depCancel">关闭</button>'
      + '<button class="wiz-btn primary" id="depAdd"' + (DEP.busy ? ' disabled' : '') + '>' + (DEP.busy ? '执行中…' : '添加') + '</button>'
      + '</div></div>';

    var dir = mask.querySelector('#depDir');
    if (dir) {
      dir.addEventListener('input', function () { DEP.dir = dir.value; });
      dir.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { DEP.dir = dir.value; BRIDGE.send({ kind: 'depsAdd', dir: DEP.dir, dryRun: true }); }
      });
    }
    var spec = mask.querySelector('#depSpec');
    if (spec) {
      spec.addEventListener('input', function () { DEP.spec = spec.value; });
      spec.addEventListener('keydown', function (e) { if (e.key === 'Enter') depAdd(); });
    }
    var cancel = mask.querySelector('#depCancel');
    if (cancel) cancel.addEventListener('click', depClose);
    var add = mask.querySelector('#depAdd');
    if (add) add.addEventListener('click', depAdd);
  }

  function depAdd() {
    if (DEP.busy) return;
    if (!DEP.spec.trim()) { DEP.error = '请填写要添加的依赖'; depPaint(); return; }
    DEP.busy = true;
    DEP.error = '';
    DEP.output = '';
    depPaint();
    BRIDGE.send({ kind: 'depsAdd', dir: DEP.dir, spec: DEP.spec });
  }

  function depOnResult(m) {
    DEP.busy = false;
    if (m && m.plan) DEP.label = m.plan.label || m.plan.ecosystem || '';
    if (m && m.ok === false && m.message) {
      DEP.error = m.message;
      depPaint();
      return;
    }
    DEP.output = String((m && m.output) || '').trim() || '(没有输出)';
    DEP.error = '';
    depPaint();
    if (m && m.ok) {
      toast('已添加 ' + DEP.spec.trim());
      // The manifest just changed on disk; the tree should show it.
      BRIDGE.send({ kind: 'fsList', path: '.' });
    }
  }

  // -------------------------------------------------- run configurations
  //
  // Four fields, because they are the four that change what runs: name, program
  // arguments, working directory, environment. Everything else already comes from
  // the language manifest, and a second source for it would go stale.

  var RC = { items: [], pick: null, name: '', args: '', cwd: '', env: '', error: '' };

  function rcOpen() {
    wizStyle();
    RC.pick = null;
    RC.name = '';
    RC.args = '';
    RC.cwd = '';
    RC.env = '';
    RC.error = '';
    rcPaint();
    BRIDGE.send({ kind: 'runConfigsList' });
  }

  function rcClose() {
    var mask = $('nlRc');
    if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
  }

  function rcMode() {
    return RUN_MODE[currentLang] || 'runtime';
  }

  function rcMine() {
    return RC.items.filter(function (c) { return c.language === currentLang; });
  }

  function rcPaint() {
    var mask = $('nlRc');
    if (!mask) {
      mask = document.createElement('div');
      mask.id = 'nlRc';
      mask.className = 'wiz-mask';
      document.body.appendChild(mask);
    }
    var mine = rcMine();
    // A language whose runtime has no argv cannot honour this field. Disabling it
    // is honest; accepting it and dropping it silently is what the flag prevents.
    var argsOk = ARGS_OK[currentLang] !== false;
    var rows = '';
    if (!mine.length) {
      rows = '<div class="wiz-muted">' + esc(currentLang) + ' 还没有配置。填右边，点「保存」。</div>';
    } else {
      for (var i = 0; i < mine.length; i++) {
        var c = mine[i];
        var sel = RC.pick && RC.pick.id === c.id;
        rows += '<div class="wiz-card' + (sel ? ' sel' : '') + '" data-rc="' + esc(c.id) + '">'
          + '<b>' + esc(c.name) + '</b>'
          + '<div class="wiz-muted">' + esc(c.args || '(无参数)') + (c.cwd ? ' · ' + esc(c.cwd) : '') + '</div>'
          + '</div>';
      }
    }
    mask.innerHTML = '<div class="wiz-box" style="width:min(860px,94vw);height:min(560px,86vh)">'
      + '<div class="wiz-head"><span class="wiz-title">运行配置</span><span class="wiz-badge">' + esc(currentLang) + '</span><span class="wiz-muted">Ctrl+Alt+R</span></div>'
      + '<div class="wiz-body" style="grid-template-columns:1fr 1.4fr">'
      + '<div class="wiz-col"><div class="wiz-sec">已保存</div>' + rows + '</div>'
      + '<div class="wiz-col">'
      + '<div class="wiz-field"><label>名称</label><input type="text" id="rcName" value="' + esc(RC.name) + '" placeholder="例如 带参数运行"></div>'
      + (argsOk
        ? '<div class="wiz-field"><label>程序参数</label><input type="text" id="rcArgs" value="' + esc(RC.args) + '" placeholder="--port 8080 &quot;two words&quot;"></div>'
        : '<div class="wiz-field"><label>程序参数</label><input type="text" id="rcArgs" value="" disabled placeholder="该语言的运行时没有 argv"><div class="wiz-muted">' + esc(currentLang) + ' 的运行时（' + esc(rcMode()) + '）不把参数交给程序，所以这一栏停用——存了也不会生效。</div></div>')
      + '<div class="wiz-field"><label>工作目录</label><input type="text" id="rcCwd" value="' + esc(RC.cwd) + '" placeholder="留空 = 语言默认"></div>'
      + '<div class="wiz-field"><label>环境变量（每行 KEY=VALUE）</label><textarea id="rcEnv" rows="4" style="width:100%;box-sizing:border-box;background:var(--input-bg,#1e1f22);color:inherit;border:1px solid var(--border);border-radius:4px;padding:4px 6px">' + esc(RC.env) + '</textarea></div>'
      + (RC.error ? '<div class="wiz-hint">' + esc(RC.error) + '</div>' : '')
      + '</div></div>'
      + '<div class="wiz-foot">'
      + '<button class="wiz-btn" id="rcCancel">关闭</button>'
      + '<button class="wiz-btn" id="rcDelete"' + (RC.pick ? '' : ' disabled') + '>删除</button>'
      + '<button class="wiz-btn" id="rcSave">保存</button>'
      + '<button class="wiz-btn primary" id="rcRun">保存并运行</button>'
      + '</div></div>';

    mask.querySelectorAll('.wiz-card').forEach(function (card) {
      card.addEventListener('click', function () {
        var id = card.getAttribute('data-rc');
        var cfg = RC.items.filter(function (c) { return c.id === id; })[0];
        if (!cfg) return;
        RC.pick = cfg;
        RC.name = cfg.name;
        RC.args = cfg.args || '';
        RC.cwd = cfg.cwd || '';
        RC.env = cfg.env || '';
        rcPaint();
      });
    });
    ['rcName', 'rcArgs', 'rcCwd', 'rcEnv'].forEach(function (id) {
      var el = mask.querySelector('#' + id);
      if (!el) return;
      el.addEventListener('input', function () {
        if (id === 'rcName') RC.name = el.value;
        if (id === 'rcArgs') RC.args = el.value;
        if (id === 'rcCwd') RC.cwd = el.value;
        if (id === 'rcEnv') RC.env = el.value;
      });
    });
    var cancel = mask.querySelector('#rcCancel');
    if (cancel) cancel.addEventListener('click', rcClose);
    var save = mask.querySelector('#rcSave');
    if (save) save.addEventListener('click', function () { rcSave(false); });
    var run = mask.querySelector('#rcRun');
    if (run) run.addEventListener('click', function () { rcSave(true); });
    var del = mask.querySelector('#rcDelete');
    if (del) del.addEventListener('click', function () {
      if (!RC.pick) return;
      BRIDGE.send({ kind: 'runConfigsDelete', id: RC.pick.id });
      RC.pick = null;
    });
  }

  function rcSave(andRun) {
    RC.error = '';
    if (!RC.name.trim()) { RC.error = '配置需要一个名字'; rcPaint(); return; }
    BRIDGE.send({
      kind: 'runConfigsSave',
      config: { id: RC.pick ? RC.pick.id : '', name: RC.name, language: currentLang, args: RC.args, cwd: RC.cwd, env: RC.env },
    });
    if (andRun) {
      BRIDGE.send({
        kind: 'run',
        code: ta.value,
        language: currentLang,
        sessionId: 'pycharm',
        args: RC.args,
        env: RC.env,
        cwd: RC.cwd,
      });
      toast('运行 ' + RC.name.trim());
      rcClose();
    }
  }

  function rcOnList(m) {
    RC.items = Array.isArray(m.items) ? m.items : [];
    if (m && m.message) RC.error = m.message;
    rcPaint();
  }
