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
  var st = { soc: DEFAULT_SOC, st: 'US', lvl: 0, salary: null, p1: 0.16 };   // lvl: 0-3, or 'me' (colour by the level my salary reaches)
  var occs = [], occByCode = {}, areas = {}, c2a = {}, byState = {}, geoS = null, geoC = {}, wageCache = {};
  var wages = null, els = {}, pinned = null, hover = null, token = 0;

  function get(url) {
    return fetch(url).then(function (r) { if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); });
  }
  function css(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  function hex(c) { c = c.replace('#', ''); return [0, 2, 4].map(function (i) { return parseInt(c.substr(i, 2), 16); }); }
  // 'me' mode uses the good/bad ramp (--g0 red ... --g4 green); everything else uses the blue-green wage ramp (--r0..--r4)
  function ramp(t, pre) {
    var s = [0, 1, 2, 3, 4].map(function (i) { return hex(css((pre || '--r') + i)); });
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
    return '$' + (a / HOURS).toFixed(2) + '/h · $' + Math.round(a).toLocaleString('en-US') + '/yr';
  }
  // ----- jobs (BLS OEWS): [employment, ...] per wage area, and per state -----
  function nf(n) { return n.toLocaleString('en-US'); }
  function stAb(fp) { var s = geoS.states.filter(function (x) { return x.id === fp; })[0]; return s && s.ab; }
  function stateJobs(fp) { return wages && wages.states && wages.states[stAb(fp)]; }
  function areaJobs(fips) { return wages && wages.emp && wages.emp[c2a[fips]]; }
  function jobsBlock(v, scope) {
    var t = '<div class="jobs"><div class="eyebrow">Jobs · ' + scope + '</div>';
    if (v === undefined) return t + '<p class="muted">BLS publishes no employment figure for this area.</p></div>';
    if (!v || v[0] == null) return t + '<p class="muted">Not published (too few survey responses).</p></div>';
    return t + '<div class="big sm">' + nf(v[0]) + '<small>jobs</small></div></div>';
  }
  function rowFor(fips) { return wages && wages.areas[c2a[fips]]; }
  function median(a) {
    var s = a.slice().sort(function (x, y) { return x - y; }), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  // ----- my salary vs. the wage levels (H-1B cap lottery weighting) -----
  // Highest level whose wage the salary meets: 0 = below Level I, 1-4 = Level I-IV. Level n gets n lottery entries.
  function myLevel(row) {
    if (!row || row[5] === 3 || st.salary == null) return null;
    var lv = 0;
    for (var k = 0; k < 4; k++) { var a = annual(row, k); if (a != null && st.salary >= a) lv = k + 1; }
    return lv;
  }
  function metric(row) { return st.lvl === 'me' ? myLevel(row) : annual(row, st.lvl); }
  // Each entry is treated as an independent draw that succeeds with probability p1 (Level I's chance),
  // so n entries succeed with 1 - (1 - p1)^n. A rough model, not a USCIS figure.
  function chance(level) { return level >= 1 ? 1 - Math.pow(1 - st.p1, level) : null; }
  function pct(x) { return Math.round(x * 100) + '%'; }
  function levelText(v) { return v < 0.5 ? 'Below Level I' : 'Level ' + LV[Math.min(3, Math.round(v) - 1)]; }
  function cur() { return st.lvl === 'me' ? 'My level' : 'Level ' + LV[st.lvl]; }

  function stats(fp, fn) {
    var v = [];
    (byState[fp] || []).forEach(function (f) { var a = fn(rowFor(f)); if (a != null) v.push(a); });
    return v.length ? { med: median(v), min: Math.min.apply(0, v), max: Math.max.apply(0, v), n: v.length, of: byState[fp].length } : null;
  }
  function stateStats(fp) { return stats(fp, metric); }
  function hr(a) { return '$' + (a / HOURS).toFixed(2); }
  function yr(a) { return '$' + Math.round(a).toLocaleString('en-US'); }
  // all four levels for a state: median of its counties' wage areas, with the low-high spread
  function stateTable(fp, wide) {
    var rows = '';
    for (var k = 0; k < 4; k++) {
      var t = stats(fp, function (r) { return annual(r, k); });
      rows += '<tr' + (k === st.lvl ? ' class="cur"' : '') + '><td>Level ' + LV[k] + '</td>' +
        (t ? '<td>' + hr(t.med) + '</td><td>' + yr(t.med) + '</td>' + (wide ? '<td class="rng">' + hr(t.min) + '–' + hr(t.max).slice(1) + '</td>' : '')
           : '<td colspan="' + (wide ? 3 : 2) + '">no data</td>') + '</tr>';
    }
    return '<table><thead><tr><th>Level</th><th>Median /h</th><th>Median /yr</th>' + (wide ? '<th>Range /h</th>' : '') + '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

  // ----- routing -----
  function parseHash() {
    var p = location.hash.replace(/^#\/?/, '').split('/');
    if (p[0] && occByCode[p[0]]) st.soc = p[0];
    st.st = /^[A-Z]{2}$/.test(p[1] || '') ? p[1] : 'US';
    var l = parseInt(p[2], 10);
    st.lvl = l >= 1 && l <= 4 ? l - 1 : 0;
    var sal = parseInt(p[3], 10);
    if (sal >= 1000) st.salary = sal;
    if (p[2] === 'me' && st.salary != null) st.lvl = 'me';
  }
  function setHash() {
    var h = '#/' + st.soc + '/' + st.st + '/' + (st.lvl === 'me' ? 'me' : st.lvl + 1) + (st.salary != null ? '/' + st.salary : '');
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
    document.querySelectorAll('#lv button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.k === String(st.lvl)));
    });
    $('.mine').classList.toggle('on', st.lvl === 'me');
    if (document.activeElement !== $('#sal')) $('#sal').value = st.salary != null ? '$' + st.salary.toLocaleString('en-US') : '';
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
    svg.textContent = ''; els = {}; hover = null;   // removed paths never fire mouseleave
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
    var ids = Object.keys(els), val = {}, mn = Infinity, mx = -Infinity, me = st.lvl === 'me';
    ids.forEach(function (id) {
      var v = st.st === 'US' ? (stateStats(id) || {}).med : metric(rowFor(id));
      val[id] = v == null ? null : v;
      if (v != null) { mn = Math.min(mn, v); mx = Math.max(mx, v); }
    });
    var pre = me ? '--g' : '--r', scale;
    if (me) { mn = 0; mx = 4; scale = function (v) { return v / 4; }; }                              // fixed scale so colours mean the same everywhere
    else scale = function (v) { return mx === mn ? .5 : (v - mn) / (mx - mn); };
    ids.forEach(function (id) {
      var p = els[id], v = val[id];
      p.classList.toggle('nodata', v == null);
      p.style.fill = v == null ? '' : ramp(scale(v), pre);
    });
    var ok = isFinite(mn);
    $('#lmin').textContent = !ok ? '' : me ? 'Below Level I' : money(mn);
    $('#lmax').textContent = !ok ? '' : me ? 'Level IV' : money(mx);
    $('#bar').style.background = ok ? 'linear-gradient(90deg,' + [0, .25, .5, .75, 1].map(function (t) { return ramp(t, pre); }).join(',') + ')' : 'var(--nodata)';
    var cap;
    if (me) cap = 'Green: your $' + st.salary.toLocaleString('en-US') + ' reaches a high level here (more lottery entries). Red: below Level I, not fileable.' + (st.st === 'US' ? ' Colour is the typical county; select a state for its counties.' : '');
    else cap = 'Level ' + LV[st.lvl] + (st.st === 'US' ? ', median of each state’s wage areas. Select a state to see its counties.' : ', ' + stateName(st.st) + ' counties. Grey means no leveled wage for this occupation.');
    $('#legcap').textContent = cap;
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
    return '<div><div class="eyebrow">Occupation ' + esc(wages.soc) + '</div><div class="occ-t">' + esc(wages.title) + '</div></div>' +
      (wages.nat ? '<p class="muted">' + nf(wages.nat) + ' jobs in the United States (BLS, May 2025).</p>' : '');
  }

  function panelFor() {
    if (!wages) return;
    var id = hover != null ? hover : pinned, h;
    if (id != null && !els[id]) id = hover = null;   // stale id from the previous view
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
    if (hover != null && els[hover]) { tip.innerHTML = tipHtml(hover); tip.hidden = false; } else tip.hidden = true;
  }

  // small card that follows the pointer so the numbers sit next to the region
  var tip = document.createElement('div');
  tip.className = 'tip'; tip.hidden = true;
  $('.mapbox').appendChild(tip);
  function tipHtml(id) {
    if (st.st === 'US') {
      var s = geoS.states.filter(function (x) { return x.id === id; })[0];
      var sj = stateJobs(id);
      return '<b>' + esc(s.name) + '</b><span class="tsub">' + (sj && sj[0] != null ? nf(sj[0]) + ' jobs' : 'jobs not published') + '</span>' + stateTable(id, false);
    }
    var c = geoC[st.st].counties.filter(function (x) { return x.id === id; })[0], row = rowFor(id), rows = '';
    var aj = areaJobs(id);
    var h = '<b>' + esc(c.name) + '</b><span class="tsub">' + esc(areas[c2a[id]] || '') + '</span>' +
      '<span class="tsub">' + (aj && aj[0] != null ? nf(aj[0]) + ' jobs in area' : 'jobs not published') + '</span>';
    if (!row || row[5] === 3) return h + '<span class="tsub">No leveled wage</span>';
    for (var k = 0; k < 4; k++) {
      var v = annual(row, k), pre = row[5] === 2 ? '≥ ' : '';
      rows += '<tr' + (k === st.lvl ? ' class="cur"' : '') + '><td>Level ' + LV[k] + '</td><td>' + pre + hr(v) + '</td><td>' + pre + yr(v) + '</td></tr>';
    }
    return h + '<table><thead><tr><th>Level</th><th>Hourly</th><th>Annual</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }
  function moveTip(e) {
    if (tip.hidden) return;
    // fixed to the viewport, so a tall map never pushes the card off screen
    var w = tip.offsetWidth, h = tip.offsetHeight, vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    var x = e.clientX + 16, y = e.clientY + 16;
    if (x + w > vw - 8) x = e.clientX - w - 16;
    if (y + h > vh - 8) y = Math.max(8, vh - h - 8);
    tip.style.left = Math.max(8, x) + 'px'; tip.style.top = y + 'px';
  }
  svg.addEventListener('mousemove', moveTip);
  svg.addEventListener('mouseleave', function () { tip.hidden = true; });

  function stateHtml(fp) {
    var s = geoS.states.filter(function (x) { return x.id === fp; })[0], t = stateStats(fp);
    var h = '<div><div class="eyebrow">State</div><h2>' + esc(s.name) + '</h2></div>' + jobsBlock(stateJobs(fp), 'whole state');
    if (!t) return h + '<p class="muted">No leveled wage for ' + esc(wages.title) + ' here.</p>' + '<p class="muted">' + esc(wages.soc) + '</p>';
    if (st.lvl === 'me') {
      var lvls = (byState[fp] || []).map(function (f) { return myLevel(rowFor(f)); }).filter(function (x) { return x != null; });
      var c3 = lvls.filter(function (x) { return x >= 3; }).length, c0 = lvls.filter(function (x) { return x === 0; }).length;
      return h + '<div><div class="eyebrow">Your $' + st.salary.toLocaleString('en-US') + ' · typical county</div><div class="big">' + levelText(t.med) + '</div></div>' +
        stateTable(fp, true) +
        '<p class="muted">Level III or higher in ' + c3 + ' of ' + t.n + ' counties. Below Level I (not fileable) in ' + c0 + '. Select the state for the county detail.</p>';
    }
    return h + stateTable(fp, true) +
      '<p class="muted">Median and range across the ' + t.n + ' of ' + t.of + ' counties that have a leveled wage. Select the state to open its counties.</p>' +
      '<p class="muted"><b>' + esc(wages.title) + '</b> (' + esc(wages.soc) + ')</p>';
  }

  function countyHtml(id) {
    var c = geoC[st.st].counties.filter(function (x) { return x.id === id; })[0], a = c2a[id], row = rowFor(id);
    var h = '<div><div class="eyebrow">' + esc(stateName(st.st)) + '</div><h2>' + esc(c.name) + '</h2></div>' +
      '<p class="muted">' + esc(areas[a] || '') + '</p>' + jobsBlock(areaJobs(id), 'this wage area');
    if (!row || row[5] === 3) {
      return h + '<p class="muted">DOL publishes no leveled wage for ' + esc(wages.title) + ' in this area.</p>';
    }
    var rows = '';
    for (var k = 0; k < 4; k++) {
      var v = annual(row, k);
      rows += '<tr' + (k === st.lvl ? ' class="cur"' : '') + '><td>Level ' + LV[k] + '</td><td>' + (row[5] === 2 ? '≥ ' : '') + '$' + (v / HOURS).toFixed(2) + '</td><td>' + (row[5] === 2 ? '≥ ' : '') + '$' + Math.round(v).toLocaleString('en-US') + '</td></tr>';
    }
    h += '<table><thead><tr><th>Level</th><th>Hourly</th><th>Annual</th></tr></thead><tbody>' + rows + '</tbody></table>';
    if (st.salary != null) {
      var ml = myLevel(row);
      h += ml === 0
        ? '<div class="offer bad"><div class="eyebrow">Your $' + st.salary.toLocaleString('en-US') + '</div><p>Below Level I here. It is under the prevailing wage, so a petition at this salary is not fileable.</p></div>'
        : '<div class="offer"><div class="eyebrow">Your $' + st.salary.toLocaleString('en-US') + '</div><div class="big">Level ' + LV[ml - 1] + '<small>' + ml + (ml === 1 ? ' entry' : ' entries') + ' · about ' + pct(chance(ml)) + ' to be selected</small></div><p class="muted">Rough H-1B cap lottery estimate. See the assumptions below the map.</p></div>';
    }
    var same = (byState[id.slice(0, 2)] || []).filter(function (f) { return c2a[f] === a; }).length;
    h += '<span class="pill">' + esc(SRC[row[4]] || '') + '</span>';
    if (row[5] === 1) h += '<p class="muted">DOL publishes this occupation as an annual wage; hourly figures are annual ÷ 2080.</p>';
    if (row[5] === 2) h += '<p class="muted">Wages here are at or above the OEWS cap, so DOL issues $115.00/h ($239,200) at every level.</p>';
    h += '<p class="muted">' + (same > 1 ? 'This wage area covers ' + same + ' counties in ' + esc(stateName(st.st)) + '.' : 'This wage area covers one county in ' + esc(stateName(st.st)) + '.') + ' Outlined counties share it.</p>';
    return h + '<p class="muted"><b>' + esc(wages.title) + '</b> (' + esc(wages.soc) + ')</p>';
  }

  // ----- boot -----
  seg('#lv', LV.map(function (l, i) { return [i, 'Level ' + l]; }), null, function (v) { st.lvl = v === 'me' ? 'me' : +v; go(); });
  function store(k, v) { try { localStorage.setItem(k, v); } catch (e) { } }
  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function readSalary() {
    var n = parseFloat($('#sal').value.replace(/[^0-9.]/g, ''));
    st.salary = n >= 1000 ? Math.round(n) : null;   // ignore hourly-looking numbers
    store('wm.salary', st.salary == null ? '' : st.salary);
    st.lvl = st.salary == null ? (st.lvl === 'me' ? 0 : st.lvl) : 'me';   // a salary in the box means "colour by my level"
    go();
  }
  var mine = document.createElement('label');
  mine.className = 'mine'; mine.htmlFor = 'sal';
  mine.innerHTML = '<input id="sal" inputmode="numeric" autocomplete="off" placeholder="My salary, e.g. $150,000" aria-label="My annual salary">';
  $('#lv').appendChild(mine);
  $('#sal').addEventListener('change', readSalary);
  $('#sal').addEventListener('focus', function () { if (st.salary != null && st.lvl !== 'me') { st.lvl = 'me'; go(); } });
  $('#sal').addEventListener('keydown', function (e) { if (e.key === 'Enter') readSalary(); });
  $('#p1').addEventListener('change', function () {
    var n = parseFloat($('#p1').value);
    if (n >= 1 && n <= 90) st.p1 = n / 100;
    $('#p1').value = Math.round(st.p1 * 100);
    store('wm.p1', st.p1);
    if (wages) paint();
  });
  var sp = parseFloat(load('wm.p1')); if (sp > 0 && sp <= 0.9) st.p1 = sp;
  var ss = parseInt(load('wm.salary'), 10); if (ss >= 1000) st.salary = ss;
  $('#p1').value = Math.round(st.p1 * 100);
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
