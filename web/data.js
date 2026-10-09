// Reads the "Buyer Zips" workbook (mock CSVs or a shared Google Sheet), validates it, and expands
// every cell into zip-level coverage entries. Depends on the global `d3` (web/vendor) for CSV parsing.
//
// Workbook contract (see README.md):
//   _buyers     columns: buyer | status (active, prospect, paused) | notes
//   _verticals  columns: vertical | notes
//   <buyer>     one tab per buyer, named exactly as in _buyers. Row 1 = vertical names.
//               Each cell below is a 5-digit zip (ZIP+4 accepted) or "City, ST".

const ZIP_RE = /^(\d{5})(?:-\d{4})?$/;
const CITY_RE = /^(.+?),\s*([A-Za-z]{2})\.?$/;
const STATUSES = new Set(['active', 'prospect', 'paused']);

export const norm = (s) => String(s ?? '').toLowerCase().replace(/\./g, '').trim().split(/\s+/).join(' ');

const colLetter = (i) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(64 + ((n - 1) % 26) + 1) + s;
  return s;
};

export function tabUrl(config, tab) {
  if (config.source === 'sheet') {
    if (!config.sheetId) throw new Error('config.sheetId is empty');
    return `https://docs.google.com/spreadsheets/d/${config.sheetId}/gviz/tq?tqx=out:csv&headers=1&sheet=${encodeURIComponent(tab)}`;
  }
  return `${config.mockDir}${encodeURIComponent(tab)}.csv`;
}

// ---- Google sign-in (source: 'google') --------------------------------------------------------
// The page asks the viewer to sign in with their Google account and reads the sheet with the
// viewer's own access through the Sheets API. Nothing but the public OAuth client id lives in the
// page. Works with sheets shared only inside the Workspace domain.
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const TOKEN_KEY = 'zm.google.token';

function savedToken() {
  try { const t = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || 'null'); return t && t.exp > Date.now() ? t.value : null; } catch { return null; }
}
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src; s.async = true; s.onload = resolve; s.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.appendChild(s);
  });
}
// interactive=false returns null instead of opening a popup, so the page can show a sign-in button.
export async function googleToken(config, interactive) {
  const t = savedToken();
  if (t) return t;
  if (!interactive) return null;
  if (!config.clientId) throw new Error('config.clientId is empty');
  await loadScript('https://accounts.google.com/gsi/client');
  return new Promise((resolve, reject) => {
    const tc = google.accounts.oauth2.initTokenClient({
      client_id: config.clientId,
      scope: SCOPE,
      callback: (r) => {
        if (r.error) return reject(new Error(r.error_description || r.error));
        try { sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ value: r.access_token, exp: Date.now() + (r.expires_in - 60) * 1000 })); } catch {}
        resolve(r.access_token);
      },
      error_callback: (e) => reject(new Error(e.type === 'popup_closed' ? 'sign-in window was closed' : e.message || e.type)),
    });
    tc.requestAccessToken({ prompt: '' });
  });
}
export function googleSignOut() { try { sessionStorage.removeItem(TOKEN_KEY); } catch {} }

async function fetchTabGoogle(config, tab) {
  const token = savedToken();
  if (!token) throw new Error('not signed in');
  const range = encodeURIComponent(`'${tab.replace(/'/g, "''")}'`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${config.sheetId}/values/${range}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
  if (res.status === 401) { googleSignOut(); throw new Error('sign-in expired, reload to sign in again'); }
  if (res.status === 403) {
    const msg = await res.json().then((j) => j.error?.message || '').catch(() => '');
    throw new Error(/not been used|disabled|enable it/i.test(msg) ? 'Google Sheets API is not enabled for the Cloud project' : `your Google account has no access to this sheet${msg ? ` (${msg})` : ''}`);
  }
  if (res.status === 400 || res.status === 404) throw new Error('tab missing');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { values = [] } = await res.json();
  const width = Math.max(0, ...values.map((r) => r.length));
  return values.map((r) => Array.from({ length: width }, (_, i) => String(r[i] ?? '').trim()));
}

export async function fetchTab(config, tab) {
  if (config.source === 'google') return fetchTabGoogle(config, tab);
  const res = await fetch(tabUrl(config, tab), { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (/^\s*</.test(text)) throw new Error('got a web page instead of CSV (sheet not shared, or tab missing)');
  return d3.csvParseRows(text).map((r) => r.map((c) => (c ?? '').trim()));
}

function table(rows) {
  const [head = [], ...body] = rows;
  const keys = head.map(norm);
  return body
    .filter((r) => r.some((c) => c))
    .map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ''])));
}

// Step 1: read the tabs. Returns raw (unexpanded) cell entries plus structural issues.
export async function loadWorkbook(config) {
  const issues = [];
  const issue = (level, o) => issues.push({ level, ...o });

  const buyers = [];
  const buyerRows = table(await fetchTab(config, '_buyers'));
  if (!buyerRows.length || !('buyer' in buyerRows[0])) throw new Error('_buyers tab needs columns: buyer, status, notes');
  buyerRows.forEach((row, i) => {
    const name = row.buyer;
    const status = norm(row.status) || 'active';
    if (!name) return issue('error', { tab: '_buyers', row: i + 2, value: '', problem: 'buyer name is empty (row ignored)' });
    if (buyers.some((b) => b.name === name)) return issue('error', { tab: '_buyers', row: i + 2, value: name, problem: 'duplicate buyer (row ignored)' });
    if (!STATUSES.has(status)) issue('warn', { tab: '_buyers', row: i + 2, value: row.status, problem: 'status must be active, prospect or paused (treated as active)' });
    buyers.push({ name, status: STATUSES.has(status) ? status : 'active', notes: row.notes || '' });
  });

  const verticals = [];
  const verticalColor = new Map();   // optional `color` column in _verticals (any CSS color)
  const verticalRows = table(await fetchTab(config, '_verticals'));
  if (!verticalRows.length || !('vertical' in verticalRows[0])) throw new Error('_verticals tab needs columns: vertical, notes');
  verticalRows.forEach((row, i) => {
    const name = row.vertical;
    if (!name) return;
    if (verticals.some((v) => norm(v) === norm(name))) return issue('warn', { tab: '_verticals', row: i + 2, value: name, problem: 'duplicate vertical (ignored)' });
    verticals.push(name);
    const c = (row.color || '').trim();
    if (c) {
      if (typeof CSS !== 'undefined' && CSS.supports('color', c)) verticalColor.set(name, c);
      else issue('warn', { tab: '_verticals', row: i + 2, value: c, problem: 'color is not a CSS color like #2e9e6b (default color used)' });
    }
  });
  const vertByNorm = new Map(verticals.map((v) => [norm(v), v]));

  const raw = [];
  await Promise.all(buyers.map(async (b) => {
    let rows;
    try {
      rows = await fetchTab(config, b.name);
    } catch (e) {
      return issue('error', { tab: b.name, row: 0, value: '', problem: `tab could not be read: ${e.message}` });
    }
    const [head = [], ...body] = rows;
    const cols = head.map((h, c) => {
      if (!h) return null;
      const v = vertByNorm.get(norm(h));
      if (!v) issue('error', { tab: b.name, row: 1, col: colLetter(c), value: h, problem: 'column header is not listed in _verticals (column ignored)' });
      return v || null;
    });
    body.forEach((r, ri) => r.forEach((cell, ci) => {
      if (!cell) return;
      if (!cols[ci]) {
        if (!head[ci]) issue('warn', { tab: b.name, row: ri + 2, col: colLetter(ci), value: cell, problem: 'value under an empty header (ignored)' });
        return;
      }
      raw.push({ buyer: b.name, vertical: cols[ci], value: cell, tab: b.name, row: ri + 2, col: colLetter(ci) });
    }));
  }));

  return { buyers, verticals, verticalColor, raw, issues, loadedAt: new Date() };
}

// Step 2: turn cells into zips. `geo` provides prefixToStates (3-digit zip prefix -> states, most zips first), a Set of
// known states, and loadMeta(st) -> the state's meta file (zips, cities, places).
export async function resolveCoverage(wb, geo) {
  const issues = wb.issues.slice();
  const issue = (level, r, problem) => issues.push({ level, tab: r.tab, row: r.row, col: r.col, value: r.value, problem });

  const needs = new Set();
  const parsed = [];
  for (const r of wb.raw) {
    let m;
    if ((m = ZIP_RE.exec(r.value))) {
      const sts = geo.prefixToStates.get(m[1].slice(0, 3));
      if (!sts) { issue('error', r, 'zip prefix does not belong to any state'); continue; }
      sts.forEach((st) => needs.add(st));
      parsed.push({ ...r, kind: 'zip', zip: m[1], candidates: sts });
    } else if (/^\d{3,4}$/.test(r.value)) {
      issue('error', r, 'looks like a zip that lost its leading zero: format the column as plain text and re-enter');
    } else if ((m = CITY_RE.exec(r.value))) {
      const st = m[2].toUpperCase();
      if (!geo.states.has(st)) { issue('error', r, `"${m[2]}" is not a state code`); continue; }
      needs.add(st);
      parsed.push({ ...r, kind: 'city', city: m[1], state: st });
    } else {
      issue('error', r, 'not a 5-digit zip or "City, ST"');
    }
  }

  const metas = Object.fromEntries(await Promise.all([...needs].map(async (st) => [st, await geo.loadMeta(st)])));

  const entries = [];
  const seen = new Set();
  const add = (r, zip, via) => {
    const key = `${r.buyer}|${r.vertical}|${zip}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ buyer: r.buyer, vertical: r.vertical, zip, state: r.state, via });
  };
  for (const p of parsed) {
    if (p.kind === 'zip') {
      const st = p.candidates.find((c) => metas[c].zips[p.zip]);
      if (!st) {
        // Valid state prefix but no reference knows the zip: usually an unassigned, PO-box-only or
        // single-building zip (Google still resolves those to a city). Counted, not drawn.
        issue('warn', p, `not in the zip reference: likely unassigned, PO box or single-building zip (counted, not drawn)`);
        add({ ...p, state: p.candidates[0] }, p.zip, null);
        continue;
      }
      const z = metas[st].zips[p.zip];
      if (!z.drawable) issue('info', p, `${z.type === 'PO BOX' ? 'PO box' : 'non-standard'} zip with no map area (counted, not drawn)`);
      add({ ...p, state: st }, p.zip, null);
    } else {
      const meta = metas[p.state];
      const key = norm(p.city);
      const zips = new Set([...(meta.cities[key] || []), ...(meta.places[key]?.zips || [])]);
      const drawable = [...zips].filter((z) => meta.zips[z]?.drawable);
      if (!drawable.length) { issue('error', p, `city not found in ${p.state}`); continue; }
      for (const z of drawable) add(p, z, `${p.city}, ${p.state}`);
    }
  }

  const byZip = new Map();
  for (const e of entries) (byZip.get(e.zip) ?? byZip.set(e.zip, []).get(e.zip)).push(e);

  const order = { error: 0, warn: 1, info: 2 };
  issues.sort((a, b) => order[a.level] - order[b.level] || a.tab.localeCompare(b.tab) || a.row - b.row);
  return { ...wb, entries, byZip, issues, states: needs };
}
