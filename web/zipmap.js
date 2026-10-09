// Buyer zip coverage map. Vanilla ES module: mountZipMap(container, config) builds the whole UI
// inside `container` and returns { reload, destroy }. Depends on globals d3 + topojson (web/vendor).
import { loadWorkbook, resolveCoverage, googleToken, googleSignOut } from './data.js';

const W = 975, H = 610;      // AlbersUSA canvas; the SVG scales to its container
const CAP = 3;                // buyer-depth steps within a vertical's hue: 1, 2, 3+
// One hue per vertical, in _verticals order, unless the tab gives a color. Orange is kept for prospects.
const PALETTE = ['#3a62d3', '#2e9e6b', '#7b5bd6', '#1f9fb8', '#c0479a', '#b8860b', '#8b5e3c', '#d9534f'];
const MULTI = '#5f6670';      // a zip covered under two or more of the selected verticals

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
function cssToRgb(color) {
  const rgb = hexToRgb(color);
  if (rgb) return rgb;
  const el = document.createElement('span'); el.style.color = color; document.body.appendChild(el);
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(el).color); el.remove();
  return m ? [+m[1], +m[2], +m[3]] : [95, 102, 112];
}
// Lighten toward white by `t` (0 = the color itself). Three buyer-depth steps: 1 → light, 2 → mid, 3+ → full.
function shade(color, n) {
  const t = n >= 3 ? 0 : n === 2 ? 0.32 : 0.58;
  const [r, g, b] = cssToRgb(color).map((c) => Math.round(c + (255 - c) * t));
  return `rgb(${r},${g},${b})`;
}
const FAR = 3, MID = 7, NEAR = 12;

export async function mountZipMap(container, config) {
  const el = typeof container === 'string' ? document.querySelector(container) : container;
  el.classList.add('zm');
  el.innerHTML = template();
  const $ = (s) => el.querySelector(s);

  const state = {
    verticals: new Set(), buyers: new Set(), prospects: true,
    cov: null, view: null, pinned: null, first: true,
    loading: new Map(), recs: new Map(), zipRec: new Map(), lastFill: new Map(), labels: { places: [], zips: [] }, open: {},
  };

  // ---- geo context -------------------------------------------------------------------------
  const index = await (await fetch(config.geoDir + 'index.json')).json();
  const geo = {
    states: new Set(index.states.map((s) => s.abbr)),
    info: new Map(index.states.map((s) => [s.abbr, s])),
    prefixToStates: (() => {
      const m = new Map();
      for (const s of index.states) for (const [p, n] of Object.entries(s.prefixes || {})) (m.get(p) ?? m.set(p, []).get(p)).push([s.abbr, n]);
      for (const [p, arr] of m) m.set(p, arr.sort((a, b) => b[1] - a[1]).map((a) => a[0]));
      return m;
    })(),
    metaCache: new Map(),
    loadMeta(st) {
      if (!this.metaCache.has(st)) this.metaCache.set(st, fetch(`${config.geoDir}${st}-meta.json`).then((r) => r.json()));
      return this.metaCache.get(st);
    },
  };
  const us = await (await fetch(config.geoDir + 'us.json')).json();
  const projection = d3.geoAlbersUsa().scale(1300).translate([W / 2, H / 2]);
  const path = d3.geoPath(projection);
  const stateFeatures = topojson.feature(us, us.objects.states).features;
  const stateByAbbr = new Map(stateFeatures.map((f) => [f.properties.STUSPS, f]));

  const mapEl = $('.zm-map');
  const svg = d3.select($('.zm-map svg')).attr('viewBox', `0 0 ${W} ${H}`);
  const defs = svg.append('defs');
  const hatch = defs.append('pattern').attr('id', 'zm-hatch').attr('patternUnits', 'userSpaceOnUse')
    .attr('width', 6).attr('height', 6).attr('patternTransform', 'rotate(45)');
  hatch.append('line').attr('x1', 0).attr('y1', 0).attr('x2', 0).attr('y2', 6).attr('class', 'zm-hatch-line').attr('stroke-width', 1.2);

  const root = svg.append('g').attr('class', 'zm-root').attr('data-zoom', 'far');
  const gStates = root.append('g').attr('class', 'zm-states');
  const gZips = root.append('g').attr('class', 'zm-zips');
  const gProspects = root.append('g').attr('class', 'zm-prospects');
  const gCounties = root.append('g').attr('class', 'zm-counties');
  const gPlaces = root.append('g').attr('class', 'zm-places');
  const gBorders = root.append('g').attr('class', 'zm-borders');
  const gLabels = root.append('g').attr('class', 'zm-labels').attr('font-size', 11).attr('stroke-width', 2.5);
  const gZipLabels = root.append('g').attr('class', 'zm-ziplabels').attr('font-size', 9).attr('stroke-width', 2);

  gStates.selectAll('path').data(stateFeatures).join('path').attr('d', path).attr('class', 'zm-state')
    .on('click', () => unpin());
  gCounties.append('path').attr('d', path(topojson.mesh(us, us.objects.counties, (a, b) => a !== b)));
  gBorders.append('path').attr('d', path(topojson.mesh(us, us.objects.states)));

  const zoom = d3.zoom().scaleExtent([1, 80])
    .filter((ev) => (ev.type === 'wheel' ? ev.shiftKey || ev.ctrlKey : !ev.ctrlKey && !ev.button))
    .wheelDelta((ev) => -(ev.deltaY || ev.deltaX) * (ev.deltaMode === 1 ? 0.05 : ev.deltaMode ? 1 : 0.002) * (ev.ctrlKey ? 10 : 1))
    .on('zoom', (ev) => {
    const t = ev.transform;
    root.attr('transform', t);
    root.attr('data-zoom', t.k < FAR ? 'far' : t.k < MID ? 'mid' : t.k < NEAR ? 'near' : 'close');
    hatch.attr('width', 6 / t.k).attr('height', 6 / t.k).select('line').attr('y2', 6 / t.k).attr('stroke-width', 1.2 / t.k);
    gLabels.attr("font-size", 11 / t.k).attr("stroke-width", 2.5 / t.k);
    gZipLabels.attr("font-size", 9 / t.k).attr("stroke-width", 2 / t.k);
    hideTip();
    scheduleLabels();
  });
  svg.call(zoom);
  let labelTimer = null;
  function scheduleLabels() { clearTimeout(labelTimer); labelTimer = setTimeout(renderLabels, 120); }
  svg.on('click', (ev) => { if (ev.target === svg.node()) unpin(); });

  function zoomTo([[x0, y0], [x1, y1]], pad = 0.92) {
    if (![x0, y0, x1, y1].every(Number.isFinite)) return;
    const k = Math.max(1, Math.min(80, pad / Math.max((x1 - x0) / W, (y1 - y0) / H)));
    const t = d3.zoomIdentity.translate(W / 2 - k * (x0 + x1) / 2, H / 2 - k * (y0 + y1) / 2).scale(k);
    svg.transition().duration(750).call(zoom.transform, t);
  }

  // ---- per-state zip layers ----------------------------------------------------------------
  function ensureState(st) {
    if (!state.loading.has(st)) {
      state.loading.set(st, (async () => {
        const [topo, meta] = await Promise.all([
          fetch(`${config.geoDir}${st}.json`).then((r) => { if (!r.ok) throw new Error(`no map data for ${st}`); return r.json(); }),
          geo.loadMeta(st),
        ]);
        const zips = topojson.feature(topo, topo.objects.zcta).features;
        const places = topojson.feature(topo, topo.objects.place).features;
        const rec = { st, meta, zipPaths: new Map(), zipBounds: new Map(), zipCentroid: new Map(), placeXY: new Map() };

        gZips.append('g').attr('data-state', st).selectAll('path').data(zips).join('path')
          .attr('d', path).attr('class', 'zm-zip').attr('fill', 'transparent')
          .each(function (d) {
            const z = d.properties.zip;
            rec.zipPaths.set(z, this);
            rec.zipBounds.set(z, path.bounds(d));
            rec.zipCentroid.set(z, path.centroid(d));
          })
          .on('pointerenter', (ev, d) => { if (!state.pinned) showTip(d.properties.zip, st, ev); })
          .on('pointermove', (ev) => { if (!state.pinned) moveTip(ev); })
          .on('pointerleave', () => { if (!state.pinned) hideTip(); })
          .on('click', (ev, d) => { ev.stopPropagation(); togglePin(d.properties.zip, st, ev); });

        for (const zip of rec.zipPaths.keys()) state.zipRec.set(zip, rec);

        gPlaces.append('path').attr('d', path(topojson.mesh(topo, topo.objects.place)));
        for (const f of places) {
          const xy = path.centroid(f);
          if (Number.isFinite(xy[0])) rec.placeXY.set(f.properties.geoid, xy);
        }
        state.recs.set(st, rec);
        return rec;
      })());
    }
    return state.loading.get(st);
  }

  // ---- the view: filters -> colors, labels, stats ------------------------------------------
  function compute() {
    const cov = state.cov;
    if (!cov) return;
    const statusOf = new Map(cov.buyers.map((b) => [b.name, b.status]));
    const counts = new Map(), pros = new Map(), detail = new Map(), verts = new Map();
    for (const e of cov.entries) {
      if (!state.buyers.has(e.buyer)) continue;
      if (!state.verticals.has(e.vertical)) continue;
      const s = statusOf.get(e.buyer);
      (detail.get(e.zip) ?? detail.set(e.zip, []).get(e.zip)).push({ ...e, status: s });
      if (s === 'active') {
        (counts.get(e.zip) ?? counts.set(e.zip, new Set()).get(e.zip)).add(e.buyer);
        (verts.get(e.zip) ?? verts.set(e.zip, new Set()).get(e.zip)).add(e.vertical);
      }
      else if (s === 'prospect' && state.prospects) (pros.get(e.zip) ?? pros.set(e.zip, new Set()).get(e.zip)).add(e.buyer);
    }
    const activeSel = cov.buyers.filter((b) => b.status === 'active' && state.buyers.has(b.name));
    const activeHit = new Set([...counts.values()].flatMap((s) => [...s]));
    const single = activeSel.length === 1;
    let max = 0;
    for (const s of counts.values()) max = Math.max(max, s.size);
    const usedVerts = new Set();
    let anyMulti = false;
    const color = (zip, n) => {
      const vs = verts.get(zip);
      if (vs.size === 1) { const v = vs.values().next().value; usedVerts.add(v); return shade(vertColor(v), single ? 3 : n); }
      anyMulti = true;
      return shade(MULTI, single ? 3 : n);
    };

    const labels = [], zipLabels = [];
    let citiesTouched = 0, notDrawn = 0;
    const last = state.lastFill;
    for (const rec of state.recs.values()) {
      for (const [zip, node] of rec.zipPaths) {
        const n = counts.get(zip)?.size || 0;
        const fill = n ? color(zip, n) : 'transparent';
        if (last.get(zip) !== fill) { node.setAttribute('fill', fill); node.classList.toggle('is-covered', n > 0); last.set(zip, fill); }
        if (n || pros.has(zip)) zipLabels.push({ zip, xy: rec.zipCentroid.get(zip) });
      }
      for (const pl of Object.values(rec.meta.places)) {
        const hit = pl.zips.some((z) => counts.has(z));
        const pro = !hit && pl.zips.some((z) => pros.has(z));
        if (hit) citiesTouched++;
        const xy = rec.placeXY.get(pl.geoid);
        if ((hit || pro) && xy) labels.push({ key: pl.geoid, name: pl.name, xy, hit, big: pro || (pl.lsad === '25' && pl.zips.length >= 2) || pl.zips.length >= 5 });
      }
    }
    for (const zip of counts.keys()) if (!state.zipRec.has(zip)) notDrawn++;
    // Prospect hatch: one path per prospect zip, reusing the zip's outline. Nothing for the rest.
    gProspects.selectAll('path').data([...pros.keys()].filter((z) => state.zipRec.has(z)), (d) => d).join(
      (enter) => enter.append('path').attr('class', 'zm-prospect').attr('d', (z) => state.zipRec.get(z).zipPaths.get(z).getAttribute('d')),
    );
    state.labels = { places: labels, zips: zipLabels };
    renderLabels();

    const prospectOnly = [...pros.keys()].filter((z) => !counts.has(z)).length;
    state.view = { counts, pros, detail, single, max, activeSel, activeHit, prospectOnly, citiesTouched, notDrawn, usedVerts, anyMulti };
    renderStats();
    renderLegend();
    if (state.pinned) showTip(state.pinned.zip, state.pinned.st, null);
  }

  // Labels live only inside the current viewport, and only at near/close zoom. That keeps the DOM
  // small whatever the size of the coverage.
  function renderLabels() {
    const t = d3.zoomTransform(svg.node());
    const level = root.attr('data-zoom');
    if (level === 'far' || level === 'mid') { gLabels.selectAll('text').remove(); gZipLabels.selectAll('text').remove(); return; }
    const pad = 40 / t.k;
    const x0 = -t.x / t.k - pad, x1 = (W - t.x) / t.k + pad, y0 = -t.y / t.k - pad, y1 = (H - t.y) / t.k + pad;
    const inView = (d) => d.xy[0] >= x0 && d.xy[0] <= x1 && d.xy[1] >= y0 && d.xy[1] <= y1;
    const places = state.labels.places.filter((d) => inView(d) && (level === 'close' || d.big));
    gLabels.selectAll('text').data(places, (d) => d.key).join('text')
      .attr('x', (d) => d.xy[0]).attr('y', (d) => d.xy[1]).attr('class', (d) => 'zm-label' + (d.hit ? '' : ' is-prospect')).text((d) => d.name);
    const zips = level === 'close' ? state.labels.zips.filter(inView) : [];
    gZipLabels.selectAll('text').data(zips, (d) => d.zip).join('text')
      .attr('x', (d) => d.xy[0]).attr('y', (d) => d.xy[1]).text((d) => d.zip);
  }

  function renderStats() {
    const v = state.view, cov = state.cov;
    $('.zm-stats').innerHTML = [
      tile(v.counts.size, 'zips covered', verticalLabel() + (v.notDrawn ? ` · ${v.notDrawn.toLocaleString()} not drawable` : '')),
      tile(v.activeHit.size, 'active buyers', `of ${v.activeSel.length} selected`),
      tile(v.prospectOnly, 'prospect-only zips', 'would add coverage'),
      tile(v.citiesTouched, 'cities touched', 'any zip covered'),
    ].join('');
    renderAlert();
  }
  function vertColor(v) {
    const cov = state.cov;
    return cov.verticalColor.get(v) || PALETTE[Math.max(0, cov.verticals.indexOf(v)) % PALETTE.length];
  }
  function verticalLabel() {
    const all = state.cov.verticals;
    const sel = all.filter((x) => state.verticals.has(x));
    if (!sel.length) return 'no vertical selected';
    if (sel.length === all.length) return 'all verticals';
    return sel.length <= 2 ? sel.join(' + ') : `${sel.length} verticals`;
  }
  function renderAlert() {
    const cov = state.cov;
    const errors = cov.issues.filter((i) => i.level === 'error').length;
    const flagged = cov.issues.filter((i) => i.level !== 'info').length;
    const notes = infoSummary(cov).total;
    const a = $('.zm-alert');
    a.classList.toggle('is-bad', errors > 0);
    a.classList.toggle('is-warn', !errors && flagged > 0);
    a.innerHTML = `<span class="zm-alert-ico">${errors ? '&#9888;' : flagged ? '&#9888;' : notes ? '&#9432;' : '&#10003;'}</span>
      <span class="zm-alert-t">${flagged ? `${flagged} data issue${flagged === 1 ? '' : 's'}${errors ? ` · ${errors} to fix` : ''}${flagged - errors ? ` · ${flagged - errors} to review` : ''}` : 'No data issues'}${notes ? ` · ${notes.toLocaleString()} notes` : ''}</span>
      <span class="zm-alert-chev">${$('.zm-issues').hidden ? '&#9662;' : '&#9652;'}</span>`;
  }
  const tile = (n, label, sub, cls = '') =>
    `<div class="zm-tile ${cls}"><div class="zm-tile-n">${n.toLocaleString()}</div><div class="zm-tile-l">${label}</div><div class="zm-tile-s">${sub}</div></div>`;

  function renderLegend() {
    const v = state.view;
    let html = '';
    if (!v.max) html = '<span class="zm-legend-none">No active coverage in this view</span>';
    else {
      const rows = state.cov.verticals.filter((x) => v.usedVerts.has(x)).map((x) => [x, vertColor(x)]);
      if (v.anyMulti) rows.push(['2+ verticals', MULTI]);
      const steps = v.single ? [3] : [1, 2, 3];
      html = `<div class="zm-legend-grid" style="grid-template-columns:auto repeat(${steps.length},16px)">
        <span class="zm-legend-t">${v.single ? `covered by ${esc(v.activeSel[0].name)}` : 'buyers per zip'}</span>${v.single ? '' : '<span class="zm-legend-h">1</span><span class="zm-legend-h">2</span><span class="zm-legend-h">3+</span>'}
        ${rows.map(([name, c]) => `<span class="zm-legend-n">${esc(name)}</span>${steps.map((n) => `<span class="zm-sw-cell"><svg width="14" height="14"><rect width="14" height="14" rx="3" fill="${shade(c, n)}"/></svg></span>`).join('')}`).join('')}
      </div>`;
    }
    if (state.prospects && v.pros.size) html += sw('url(#zm-hatch)', 'prospect target', 'is-hatch');
    $('.zm-legend').innerHTML = html;
  }
  const sw = (fill, label, cls = '') =>
    `<span class="zm-sw ${cls}"><svg width="14" height="14"><rect width="14" height="14" rx="3" fill="${fill}"/></svg>${label}</span>`;

  function infoSummary(cov) {
    const groups = new Map(), seen = new Set();
    let total = 0;
    for (const i of cov.issues) {
      if (i.level !== 'info') continue;
      const z = `${i.tab}|${i.value}`;
      if (seen.has(z)) continue;
      seen.add(z); total++;
      const k = `${i.tab}|${i.problem}`;
      (groups.get(k) ?? groups.set(k, { tab: i.tab, problem: i.problem, n: 0 }).get(k)).n++;
    }
    return { total, groups };
  }

  function renderIssues() {
    const all = state.cov.issues;
    const list = all.filter((i) => i.level !== 'info');
    const info = infoSummary(state.cov).groups;
    const box = $('.zm-issues');
    if (!all.length) { box.innerHTML = '<p class="zm-issues-ok">No data issues. Every cell read cleanly.</p>'; return; }
    box.innerHTML = `<div class="zm-issues-head">Errors are left off the map and need a fix in the sheet. Warnings are counted and just need a look.</div>
      ${list.map((i) => `<div class="zm-issue is-${i.level}"><div class="zm-issue-w"><b>${esc(i.tab)}</b> ${i.col || ''}${i.row || ''}<span class="zm-issue-v">${esc(i.value)}</span></div><div class="zm-issue-p">${esc(i.problem)}</div></div>`).join('')}
      ${info.size ? `<div class="zm-issues-notes">${[...info.values()].map((i) => `<div><b>${esc(i.tab)}</b> · ${i.n.toLocaleString()} ${esc(i.problem)}</div>`).join('')}</div>` : ''}`;
  }

  // ---- controls ----------------------------------------------------------------------------
  function renderControls() {
    const cov = state.cov;
    const openState = (key) => (state.open[key] ?? true) ? 'open' : '';
    $('.zm-verticals').innerHTML = `<details class="zm-sec" data-key="verticals" ${openState('verticals')}><summary>Verticals <span class="zm-sec-n"></span></summary>
      <div class="zm-sec-body">${cov.verticals.map((v) =>
        `<label class="zm-chip"><input type="checkbox" value="${esc(v)}" ${state.verticals.has(v) ? 'checked' : ''}><span class="zm-dot" style="background:${vertColor(v)}"></span>${esc(v)}</label>`).join('')}
      <div class="zm-sec-links"><a href="#" data-all="1">all</a> · <a href="#" data-all="0">none</a></div></div></details>`;
    $('.zm-verticals').querySelectorAll('input').forEach((cb) => cb.addEventListener('change', () => {
      cb.checked ? state.verticals.add(cb.value) : state.verticals.delete(cb.value);
      compute();
    }));
    $('.zm-verticals').querySelectorAll('a[data-all]').forEach((a) => a.addEventListener('click', (ev) => {
      ev.preventDefault();
      const on = a.dataset.all === '1';
      state.verticals = new Set(on ? cov.verticals : []);
      $('.zm-verticals').querySelectorAll('input').forEach((cb) => { cb.checked = on; });
      compute();
    }));

    const groups = [['active', 'Buyers'], ['prospect', 'Prospects'], ['paused', 'Paused']];
    $('.zm-buyers').innerHTML = groups.map(([status, label]) => {
      const bs = cov.buyers.filter((b) => b.status === status);
      if (!bs.length) return '';
      return `<details class="zm-sec zm-group-${status}" data-key="${status}" ${openState(status)}><summary>${label} <span class="zm-sec-n">${bs.length}</span></summary><div class="zm-sec-body">${bs.map((b) =>
        `<label class="zm-chip" title="${esc(b.notes)}"><input type="checkbox" value="${esc(b.name)}" ${state.buyers.has(b.name) ? 'checked' : ''} ${status === 'paused' ? 'disabled' : ''}>${esc(b.name)}</label>`).join('')}</div></details>`;
    }).join('');
    $('.zm-buyers').querySelectorAll('input').forEach((cb) => cb.addEventListener('change', () => {
      cb.checked ? state.buyers.add(cb.value) : state.buyers.delete(cb.value);
      compute();
    }));
    el.querySelectorAll('details.zm-sec').forEach((d) => d.addEventListener('toggle', () => { state.open[d.dataset.key] = d.open; }));

    const jsel = $('.zm-jump');
    const sts = [...cov.states].sort();
    jsel.innerHTML = `<option value="">Jump to…</option><option value="US">United States</option>` + sts.map((s) => `<option value="${s}">${esc(geo.info.get(s)?.name || s)}</option>`).join('');
  }

  $('.zm-alert').addEventListener('click', () => { $('.zm-issues').hidden = !$('.zm-issues').hidden; renderAlert(); });
  $('.zm-prospects-toggle').addEventListener('change', (ev) => { state.prospects = ev.target.checked; compute(); });
  $('.zm-jump').addEventListener('change', (ev) => {
    const v = ev.target.value;
    ev.target.value = '';
    if (!v) return;
    if (v === 'US') svg.transition().duration(750).call(zoom.transform, d3.zoomIdentity);
    else { const f = stateByAbbr.get(v); if (f) zoomTo(path.bounds(f)); }
  });
  $('.zm-fit').addEventListener('click', fitCoverage);
  $('.zm-zin').addEventListener('click', () => svg.transition().duration(300).call(zoom.scaleBy, 1.7));
  $('.zm-zout').addEventListener('click', () => svg.transition().duration(300).call(zoom.scaleBy, 1 / 1.7));
  $('.zm-zreset').addEventListener('click', () => svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity));
  $('.zm-reload').addEventListener('click', () => load(true));
  $('.zm-signin').addEventListener('click', () => load(true));

  function fitCoverage() {
    const v = state.view;
    if (!v) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const zips = new Set([...v.counts.keys(), ...v.pros.keys()]);
    for (const rec of state.recs.values()) for (const z of zips) {
      const b = rec.zipBounds.get(z);
      if (!b) continue;
      x0 = Math.min(x0, b[0][0]); y0 = Math.min(y0, b[0][1]); x1 = Math.max(x1, b[1][0]); y1 = Math.max(y1, b[1][1]);
    }
    if (x0 < x1) zoomTo([[x0, y0], [x1, y1]]);
  }

  // ---- tooltip -----------------------------------------------------------------------------
  const tip = $('.zm-tip');
  function tipHtml(zip, st) {
    const rec = state.recs.get(st);
    const m = rec?.meta.zips[zip] || {};
    const rows = state.view?.detail.get(zip) || [];
    const vert = state.verticals.size === state.cov.verticals.length ? '' : ` for ${esc(verticalLabel())}`;
    let html = `<div class="zm-tip-h"><b>${zip}</b> ${esc(m.city || '')}, ${st}</div><div class="zm-tip-s">${esc(m.county || '')}</div>`;
    const by = (status) => {
      const g = new Map();
      for (const r of rows.filter((r) => r.status === status)) {
        const e = g.get(r.buyer) ?? g.set(r.buyer, { verts: new Set(), via: new Set() }).get(r.buyer);
        e.verts.add(r.vertical);
        if (r.via) e.via.add(r.via);
      }
      return [...g].map(([b, e]) => `<li><b>${esc(b)}</b> · ${[...e.verts].join(', ')}${e.via.size ? ` <i>via ${esc([...e.via].join('; '))}</i>` : ''}</li>`).join('');
    };
    const a = by('active'), p = state.prospects ? by('prospect') : '';
    if (!a && !p) html += `<div class="zm-tip-none">No coverage${vert}</div>`;
    if (a) html += `<div class="zm-tip-t">Buyers${vert}</div><ul>${a}</ul>`;
    if (p) html += `<div class="zm-tip-t is-prospect">Prospects${vert}</div><ul>${p}</ul>`;
    if (state.pinned) html += `<div class="zm-tip-pin">pinned · click again to release</div>`;
    return html;
  }
  function showTip(zip, st, ev) { tip.innerHTML = tipHtml(zip, st); tip.hidden = false; if (ev) moveTip(ev); }
  function moveTip(ev) {
    const [x, y] = d3.pointer(ev, mapEl);
    const r = mapEl.getBoundingClientRect();
    tip.style.left = `${x + 16 + tip.offsetWidth > r.width ? x - tip.offsetWidth - 12 : x + 16}px`;
    tip.style.top = `${Math.max(8, Math.min(y + 12, r.height - tip.offsetHeight - 8))}px`;
  }
  function hideTip() { tip.hidden = true; }
  function togglePin(zip, st, ev) {
    if (state.pinned && state.pinned.zip === zip) return unpin();
    state.pinned = { zip, st };
    showTip(zip, st, ev);
  }
  function unpin() { state.pinned = null; hideTip(); }

  // ---- load pipeline -----------------------------------------------------------------------
  function setStatus(msg, bad = false) { const s = $('.zm-status'); s.textContent = msg; s.classList.toggle('is-bad', bad); }

  async function load(interactive = false) {
    $('.zm-signin').hidden = true;
    if (config.source === 'google') {
      try {
        const tok = await googleToken(config, interactive);
        if (!tok) { setStatus('Sign in to read the sheet'); $('.zm-signin').hidden = false; return; }
      } catch (e) { setStatus(`Sign-in failed: ${e.message}`, true); $('.zm-signin').hidden = false; return; }
    }
    setStatus('Reading sheet…');
    try {
      const wb = await loadWorkbook(config);
      const cov = await resolveCoverage(wb, geo);
      const had = state.cov ? state.buyers : null;
      const hadV = state.cov ? state.verticals : null;
      state.cov = cov;
      state.buyers = new Set(cov.buyers.filter((b) => b.status !== 'paused' && (!had || had.has(b.name))).map((b) => b.name));
      state.verticals = new Set(cov.verticals.filter((v) => !hadV || hadV.has(v)));
      renderControls();
      renderIssues();
      const sts = [...cov.states].sort();
      setStatus(`Loading map data for ${sts.join(', ')}…`);
      await Promise.all(sts.map((st) => ensureState(st).catch((e) => cov.issues.push({ level: 'error', tab: '(map)', row: 0, value: st, problem: e.message }))));
      renderIssues();
      compute();
      const src = config.source === 'mock' ? 'mock data' : 'Google Sheet';
      setStatus(`${cov.entries.length.toLocaleString()} zip entries · ${cov.buyers.length} buyers · ${src} · read ${cov.loadedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
      if (state.first) { state.first = false; fitCoverage(); }
    } catch (e) {
      console.error(e);
      setStatus(`Could not load: ${e.message}`, true);
    }
  }

  await load();
  return { reload: load, destroy: () => { el.innerHTML = ''; el.classList.remove('zm'); } };
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function template() {
  return `
  <aside class="zm-side">
    <div class="zm-title">Buyer zip coverage<div class="zm-status">Loading…</div></div>
    <button class="zm-signin" type="button" hidden>Sign in with Google</button>
    <div class="zm-stats"></div>
    <button class="zm-alert" type="button"></button>
    <section class="zm-issues" hidden></section>
    <div class="zm-verticals"></div>
    <div class="zm-buyers"></div>
    <label class="zm-field zm-toggle"><input type="checkbox" class="zm-prospects-toggle" checked> Show prospects</label>
    <div class="zm-block zm-actions">
      <select class="zm-jump"></select>
      <button class="zm-fit" type="button">Fit to coverage</button>
      <button class="zm-reload" type="button">Reload data</button>
    </div>
  </aside>
  <main class="zm-main">
    <div class="zm-map">
      <svg xmlns="http://www.w3.org/2000/svg"></svg>
      <div class="zm-zoom">
        <button class="zm-zin" type="button" title="Zoom in">+</button>
        <button class="zm-zout" type="button" title="Zoom out">−</button>
        <button class="zm-zreset" type="button" title="Reset to whole US">⌂</button>
      </div>
      <div class="zm-legend"></div>
      <div class="zm-tip" hidden></div>
      <div class="zm-hint">shift + scroll to zoom · drag to pan · click a zip to pin its details</div>
    </div>
  </main>`;
}
