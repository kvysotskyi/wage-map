// Wage Level Map: static front end. Route lives in the hash: #/<SOC>/<US|ST>/<level 1-4>
// Data comes from /data (built by tools/build_data.py): occupations, areas, county-area, geo/*, wages/<SOC>.json
(function () {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';
  var HOURS = 2080, CAP = 115 * HOURS;
  var LV = ['I', 'II', 'III', 'IV'];
  var SRC = { 1: 'Local survey data for this wage area', 2: 'State-wide data (no local data for this area)',
    3: 'State data for the first principal city of this multi-state area', 4: 'National data (no state data)' };
  var DEFAULT_SOC = '15-1252';

  var $ = function (s) { return document.querySelector(s); };
  var svg = $('#map'), panel = $('#panel'), msg = $('#msg');
  var st = { soc: DEFAULT_SOC, st: 'US', lvl: 0, unit: 'h' };
  var occs = [], occByCode = {}, areas = {}, c2a = {}, byState = {}, geoS = null, geoC = {}, wageCache = {};
  var wages = null, els = {}, pinned = null, hover = null, token = 0;

  function get(url) {
    return fetch(url).then(function (r) { if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); });
  }
  function css(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  function hex(c) { c = c.replace('#', ''); return [0, 2, 4].map(function (i) { return parseInt(c.substr(i, 2), 16); }); }
  function ramp(t) {
    var s = [0, 1, 2, 3, 4].map(function (i) { return hex(css('--r' + i)); });
    t = Math.max(0, Math.min(1, t)) * 4;
    var i = Math.min(3, Math.floor(t)), f = t - i;
    return 'rgb(' + [0, 1, 2].map(function (k) { return Math.round(s[i][k] + (s[i + 1][k] - s[i][k]) * f); }).join(',') + ')';
  }
  function el(tag, attrs, text) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  }

  // ----- wage maths. Everything is held as annual dollars so units can switch freely -----
  function annual(row, lvl) {
    if (!row || row[5] === 3) return null;           // no leveled wage
    if (row[5] === 2) return CAP;                    // OEWS top-coded: OFLC issues $115/h
    var v = row[lvl];
    if (v == null) return null;
    return row[5] === 1 ? v : v * HOURS;             // flag 1: source already annual
  }
  function money(a) {
    return st.unit === 'h' ? '$' + (a / HOURS).toFixed(2) + '/h' : '$' + Math.round(a).toLocaleString('en-US');
  }
  function rowFor(fips) { return wages && wages.areas[c2a[fips]]; }
  function median(a) {
    var s = a.slice().sort(function (x, y) { return x - y; }), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function stateStats(fp) {
    var v = [];
    (byState[fp] || []).forEach(function (f) { var a = annual(rowFor(f), st.lvl); if (a != null) v.push(a); });
    return v.length ? { med: median(v), min: Math.min.apply(0, v), max: Math.max.apply(0, v), n: v.length, of: byState[fp].length } : null;
  }

  // ----- routing -----
  function parseHash() {
    var p = location.hash.replace(/^#\/?/, '').split('/');
    if (p[0] && occByCode[p[0]]) st.soc = p[0];
    st.st = /^[A-Z]{2}$/.test(p[1] || '') ? p[1] : 'US';
    var l = parseInt(p[2], 10);
    st.lvl = l >= 1 && l <= 4 ? l - 1 : 0;
  }
  function setHash() {
    var h = '#/' + st.soc + '/' + st.st + '/' + (st.lvl + 1);
    if (location.hash !== h) history.pushState(null, '', h);
  }
  function go() { setHash(); render(); }

  // ----- controls -----
  function seg(id, items, get_, set) {
    var h = $(id);
    items.forEach(function (it) {
      var b = document.createElement('button');
      b.type = 'button'; b.textContent = it[1]; b.dataset.k = it[0];
      b.addEventListener('click', function () { set(it[0]); });
      h.appendChild(b);
    });
  }
  function syncControls() {
    document.querySelectorAll('#lv button').forEach(function (b) { b.setAttribute('aria-pressed', String(+b.dataset.k === st.lvl)); });
    document.querySelectorAll('#unit button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.k === st.unit)); });
    var o = occByCode[st.soc];
    var inp = $('#occ');
    if (o && document.activeElement !== inp) inp.value = o + ' (' + st.soc + ')';
  }
  function occInput() {
    var v = $('#occ').value.trim(), m = v.match(/(\d{2}-\d{4})\)?$/), code = m && occByCode[m[1]] ? m[1] : null;
    if (!code) { var lv = v.toLowerCase(); for (var i = 0; i < occs.length; i++) if (occs[i][1].toLowerCase() === lv) { code = occs[i][0]; break; } }
    if (code && code !== st.soc) { st.soc = code; pinned = null; go(); }
  }

  // ----- rendering -----
  function showMsg(t) { msg.hidden = !t; msg.textContent = t || ''; }
  function loadWages() {
    if (wageCache[st.soc]) return Promise.resolve(wageCache[st.soc]);
    return get('/data/wages/' + st.soc + '.json').then(function (d) { wageCache[st.soc] = d; return d; });
  }
  function loadCounties(ab) {
    if (geoC[ab]) return Promise.resolve(geoC[ab]);
    return get('/data/geo/counties/' + ab + '.json').then(function (d) { geoC[ab] = d; return d; });
  }

  function render() {
    var my = ++token;
    syncControls();
    showMsg('Loading…');
    var need = [loadWages()];
    if (st.st !== 'US') need.push(loadCounties(st.st));
    Promise.all(need).then(function (r) {
      if (my !== token) return;
      wages = r[0];
      var changedView = svg.dataset.view !== st.st;
      if (changedView) { draw(r[1]); pinned = null; }
      paint();
      showMsg('');
    }).catch(function (e) { showMsg('Could not load data. ' + e.message); });
  }

  function draw(cgeo) {
    svg.textContent = ''; els = {};
    svg.dataset.view = st.st;
    var g;
    if (st.st === 'US') {
      svg.setAttribute('viewBox', '0 0 ' + geoS.w + ' ' + geoS.h);
      g = geoS.states;
      g.forEach(function (s) {
        var p = el('path', { d: s.d, tabindex: 0, role: 'button', 'aria-label': s.name });
        p.addEventListener('mouseenter', function () { hover = s.id; panelFor(); });
        p.addEventListener('mouseleave', function () { hover = null; panelFor(); });
        p.addEventListener('focus', function () { hover = s.id; panelFor(); });
        p.addEventListener('blur', function () { hover = null; panelFor(); });
        p.addEventListener('click', function () { st.st = s.ab; hover = null; go(); });
        p.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.dispatchEvent(new Event('click')); } });
        svg.appendChild(p); els[s.id] = p;
      });
      g.forEach(function (s) {
        if (s.c[2] >= 26 || s.ab === 'HI') svg.appendChild(el('text', { x: s.c[0], y: s.c[1] }, s.ab));
      });
    } else {
      svg.setAttribute('viewBox', '0 0 ' + cgeo.w + ' ' + cgeo.h);
      cgeo.counties.forEach(function (c) {
        var p = el('path', { d: c.d, tabindex: 0, 'aria-label': c.name });
        p.addEventListener('mouseenter', function () { hover = c.id; panelFor(); });
        p.addEventListener('mouseleave', function () { hover = null; panelFor(); });
        p.addEventListener('focus', function () { hover = c.id; panelFor(); });
        p.addEventListener('blur', function () { hover = null; panelFor(); });
        p.addEventListener('click', function () { pinned = c.id; panelFor(); });
        svg.appendChild(p); els[c.id] = p;
      });
    }
  }

  function paint() {
    var ids = Object.keys(els), val = {}, mn = Infinity, mx = -Infinity;
    ids.forEach(function (id) {
      var v = st.st === 'US' ? (stateStats(id) || {}).med : annual(rowFor(id), st.lvl);
      val[id] = v == null ? null : v;
      if (v != null) { mn = Math.min(mn, v); mx = Math.max(mx, v); }
    });
    ids.forEach(function (id) {
      var p = els[id], v = val[id];
      p.classList.toggle('nodata', v == null);
      p.style.fill = v == null ? '' : ramp(mx === mn ? .5 : (v - mn) / (mx - mn));
    });
    var ok = isFinite(mn);
    $('#lmin').textContent = ok ? money(mn) : '';
    $('#lmax').textContent = ok ? money(mx) : '';
    $('#bar').style.background = ok ? 'linear-gradient(90deg,' + [0, .25, .5, .75, 1].map(ramp).join(',') + ')' : 'var(--nodata)';
    $('#legcap').textContent = 'Level ' + LV[st.lvl] + (st.st === 'US'
      ? ', median of each state’s wage areas. Select a state to see its counties.'
      : ', ' + stateName(st.st) + ' counties. Grey means no leveled wage for this occupation.');
    crumbs();
    panelFor();
  }

  function stateName(ab) { var s = geoS.states.filter(function (x) { return x.ab === ab; })[0]; return s ? s.name : ab; }
  function crumbs() {
    var c = $('#crumbs'); c.textContent = '';
    if (st.st === 'US') { var b = document.createElement('b'); b.textContent = 'United States'; c.appendChild(b); return; }
    var back = document.createElement('button'); back.type = 'button'; back.textContent = 'United States';
    back.addEventListener('click', function () { st.st = 'US'; hover = null; pinned = null; go(); });
    var sep = document.createElement('span'); sep.textContent = '›';
    var cur = document.createElement('b'); cur.textContent = stateName(st.st);
    c.appendChild(back); c.appendChild(sep); c.appendChild(cur);
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function occBlock() {
    return '<div><div class="eyebrow">Occupation ' + esc(wages.soc) + '</div><div class="occ-t">' + esc(wages.title) + '</div></div>';
  }

  function panelFor() {
    if (!wages) return;
    var id = hover != null ? hover : pinned, h;
    // highlight counties sharing a wage area
    Object.keys(els).forEach(function (k) { els[k].classList.remove('area'); els[k].classList.toggle('sel', k === pinned); });
    if (st.st === 'US') {
      h = id ? stateHtml(id) : '<div>' + occBlock() + '</div><p class="occ-d">' + esc(wages.desc) + '</p><p class="muted">Hover a state for its numbers, or select one to open its counties.</p>';
    } else if (id) {
      var a = c2a[id];
      (byState[id.slice(0, 2)] || []).forEach(function (f) { if (c2a[f] === a && els[f]) { els[f].classList.add('area'); svg.appendChild(els[f]); } });
      if (pinned && els[pinned]) svg.appendChild(els[pinned]);
      h = countyHtml(id);
    } else {
      h = '<div>' + occBlock() + '</div><p class="occ-d">' + esc(wages.desc) + '</p><p class="muted">Hover or select a county to see its wage area and all four levels.</p>';
    }
    panel.innerHTML = h;
  }

  function stateHtml(fp) {
    var s = geoS.states.filter(function (x) { return x.id === fp; })[0], t = stateStats(fp);
    var h = '<div><div class="eyebrow">State</div><h2>' + esc(s.name) + '</h2></div>';
    if (!t) return h + '<p class="muted">No leveled wage for ' + esc(wages.title) + ' here.</p>' + '<p class="muted">' + esc(wages.soc) + '</p>';
    return h + '<div><div class="eyebrow">Level ' + LV[st.lvl] + ' · median of wage areas</div><div class="big">' + money(t.med) + '</div></div>' +
      '<p class="muted">Range across counties: ' + money(t.min) + ' to ' + money(t.max) + '. ' + t.n + ' of ' + t.of + ' counties have a leveled wage.</p>' +
      '<p class="muted"><b>' + esc(wages.title) + '</b> (' + esc(wages.soc) + '). Select the state to open its counties.</p>';
  }

  function countyHtml(id) {
    var c = geoC[st.st].counties.filter(function (x) { return x.id === id; })[0], a = c2a[id], row = rowFor(id);
    var h = '<div><div class="eyebrow">' + esc(stateName(st.st)) + '</div><h2>' + esc(c.name) + '</h2></div>' +
      '<p class="muted">' + esc(areas[a] || '') + '</p>';
    if (!row || row[5] === 3) {
      return h + '<p class="muted">DOL publishes no leveled wage for ' + esc(wages.title) + ' in this area.</p>';
    }
    var rows = '';
    for (var k = 0; k < 4; k++) {
      var v = annual(row, k);
      rows += '<tr' + (k === st.lvl ? ' class="cur"' : '') + '><td>Level ' + LV[k] + '</td><td>' + (row[5] === 2 ? '≥ ' : '') + '$' + (v / HOURS).toFixed(2) + '</td><td>' + (row[5] === 2 ? '≥ ' : '') + '$' + Math.round(v).toLocaleString('en-US') + '</td></tr>';
    }
    h += '<table><thead><tr><th>Level</th><th>Hourly</th><th>Annual</th></tr></thead><tbody>' + rows + '</tbody></table>';
    var same = (byState[id.slice(0, 2)] || []).filter(function (f) { return c2a[f] === a; }).length;
    h += '<span class="pill">' + esc(SRC[row[4]] || '') + '</span>';
    if (row[5] === 1) h += '<p class="muted">DOL publishes this occupation as an annual wage; hourly figures are annual ÷ 2080.</p>';
    if (row[5] === 2) h += '<p class="muted">Wages here are at or above the OEWS cap, so DOL issues $115.00/h ($239,200) at every level.</p>';
    h += '<p class="muted">' + (same > 1 ? 'This wage area covers ' + same + ' counties in ' + esc(stateName(st.st)) + '.' : 'This wage area covers one county in ' + esc(stateName(st.st)) + '.') + ' Outlined counties share it.</p>';
    return h + '<p class="muted"><b>' + esc(wages.title) + '</b> (' + esc(wages.soc) + ')</p>';
  }

  // ----- boot -----
  seg('#lv', LV.map(function (l, i) { return [i, 'Level ' + l]; }), null, function (v) { st.lvl = +v; go(); });
  seg('#unit', [['h', 'Hourly'], ['a', 'Annual']], null, function (v) { st.unit = v; syncControls(); if (wages) paint(); });
  $('#occ').addEventListener('change', occInput);
  $('#occ').addEventListener('focus', function () { this.select(); });
  window.addEventListener('popstate', function () { parseHash(); pinned = null; render(); });
  try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { if (wages) paint(); }); } catch (e) { }

  Promise.all([get('/data/occupations.json'), get('/data/areas.json'), get('/data/county-area.json'), get('/data/geo/states.json'), get('/data/meta.json')])
    .then(function (r) {
      occs = r[0]; areas = r[1]; c2a = r[2]; geoS = r[3];
      $('#year').textContent = r[4].wageYear + ' wage year';
      occs.forEach(function (o) { occByCode[o[0]] = o[1]; });
      var dl = $('#occlist');
      occs.forEach(function (o) { var op = document.createElement('option'); op.value = o[1] + ' (' + o[0] + ')'; dl.appendChild(op); });
      Object.keys(c2a).forEach(function (f) { (byState[f.slice(0, 2)] = byState[f.slice(0, 2)] || []).push(f); });
      parseHash();
      render();
    })
    .catch(function (e) { showMsg('Could not load data. ' + e.message); });
})();
