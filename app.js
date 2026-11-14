import * as pdfjsLib from './pdf.min.mjs';
import { parseSchedulePdf, workerNames, rowsForWorker } from './parser.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs', import.meta.url).href;

const TZ = 'Europe/Prague';
const SCOPE = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly';
// Client ID nie je tajný údaj – je viditeľný v každej prihlasovacej adrese.
const DEFAULT_CLIENT_ID = '394553646019-npjt6m9166n3e90b9n374tsb5hog7rv8.apps.googleusercontent.com';
const DEFAULT_CALENDAR_NAME = 'Julka a Feri';
const API = 'https://www.googleapis.com/calendar/v3';
const K = { settings: 'rozpis.settings', token: 'rozpis.token', session: 'rozpis.session', resume: 'rozpis.resume', state: 'rozpis.oauthState', saved: 'rozpis.saved', addr: 'rozpis.addresses' };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(area, key) { try { return JSON.parse(area.getItem(key)); } catch { return null; } },
  set(area, key, val) { try { area.setItem(key, JSON.stringify(val)); } catch { /* plné úložisko – nevadí */ } },
  del(area, key) { try { area.removeItem(key); } catch { /* */ } },
};

// ---------- Stav ----------
let settings = Object.assign({ clientId: DEFAULT_CLIENT_ID, calendarId: '', defaultName: 'BJ' }, store.get(localStorage, K.settings) || {});
if (!settings.clientId) settings.clientId = DEFAULT_CLIENT_ID;
if (settings.calendarId === 'primary') settings.calendarId = '';
let calendars = []; // kalendáre, do ktorých môže prihlásený účet zapisovať
let token = store.get(localStorage, K.token);
let S = { fileName: '', events: [], name: '', rows: [] }; // rozpracovaný rozpis
let editing = -1;
let busy = false;
// Uložené služby a adresy zákazníkov – ostávajú len v tomto zariadení
let saved = store.get(localStorage, K.saved) || { name: '', rows: [] };
if (!Array.isArray(saved.rows)) saved = { name: '', rows: [] };
let addresses = store.get(localStorage, K.addr) || {};
let view = 'upload'; // 'agenda' | 'upload'
let showOld = false;
let addrEditing = null;

const signedIn = () => !!(token && token.t && token.exp > Date.now() + 60000);
const saveSession = () => store.set(sessionStorage, K.session, S);
const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/i, '');

function notice(kind, html) {
  $('notice').innerHTML = html ? `<div class="banner ${kind}" role="status">${html}</div>` : '';
}

// ---------- Google prihlásenie (presmerovanie, bez cudzích skriptov) ----------
function signIn() {
  if (!settings.clientId) {
    openSettings();
    notice('warn', 'Najprv treba v Nastaveniach vložiť Google OAuth Client ID.');
    return;
  }
  const state = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  store.set(localStorage, K.state, state);
  if (S.events.length) store.set(localStorage, K.resume, { at: Date.now(), S });
  const p = new URLSearchParams({
    client_id: settings.clientId.trim(),
    redirect_uri: redirectUri(),
    response_type: 'token',
    scope: SCOPE,
    include_granted_scopes: 'true',
    state,
  });
  location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + p.toString());
}

function signOut() {
  token = null;
  calendars = [];
  store.del(localStorage, K.token);
  renderAuth();
}

function handleAuthReturn() {
  if (!location.hash || !/(access_token|error)=/.test(location.hash)) return;
  const h = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname + location.search);
  const expected = store.get(localStorage, K.state);
  store.del(localStorage, K.state);
  const resume = store.get(localStorage, K.resume);
  store.del(localStorage, K.resume);
  if (resume && resume.S && Date.now() - resume.at < 30 * 60000) S = resume.S;
  if (h.get('error')) {
    notice('err', 'Prihlásenie sa nepodarilo: ' + esc(h.get('error')));
    return;
  }
  if (!expected || h.get('state') !== expected) {
    notice('err', 'Prihlásenie sa nepodarilo overiť. Skús to prosím znova.');
    return;
  }
  token = { t: h.get('access_token'), exp: Date.now() + (parseInt(h.get('expires_in'), 10) || 3600) * 1000 };
  store.set(localStorage, K.token, token);
  notice('ok', 'Prihlásenie prebehlo. ' + (S.events.length ? 'Teraz môžeš importovať.' : ''));
}

class AuthError extends Error {}

async function gfetch(path, opts = {}) {
  if (!signedIn()) throw new AuthError('Prihlásenie vypršalo.');
  const res = await fetch(API + path, {
    ...opts,
    headers: { Authorization: 'Bearer ' + token.t, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  if (res.status === 401) {
    signOut();
    throw new AuthError('Prihlásenie vypršalo.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body.error && body.error.message) || 'HTTP ' + res.status);
  return body;
}

// ---------- Uložené služby a adresy ----------
/** Meno zákazníka ako kľúč adresára (bez prípony o zaúčaní). */
function clientKey(udalost) {
  const k = String(udalost || '').replace(/\s*\(Zaúčanie\)\s*$/, '').trim();
  return k === 'Zaúčanie' || k === 'Služba / Udalosť' ? '' : k;
}
const addressFor = (udalost) => { const k = clientKey(udalost); return (k && addresses[k]) || ''; };
const mapsUrl = (addr) => 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(addr);
function todayIso() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/** Uloží zaškrtnuté služby z nahraného rozpisu; dni z toho istého rozpisu nahradí. */
function saveToApp() {
  const covered = new Set(S.events.map((e) => e.date));
  const limit = shiftDays(todayIso(), -120);
  const keep = saved.rows.filter((r) => !covered.has(r.date) && r.date >= limit);
  const add = S.rows.filter((r) => r.imp && validDate(r.date)).map((r) => ({
    date: r.date, od: r.od, do: r.do, udalost: r.udalost, pasmo: r.pasmo, pozn: r.pozn, kdo: r.kdo, ...(r.merged ? { merged: true } : {}),
  }));
  const seen = new Set();
  const rows = [...keep, ...add].filter((r) => {
    const k = `${r.date}|${r.od}|${r.do}|${r.udalost}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => a.date.localeCompare(b.date) || a.od.localeCompare(b.od));
  saved = { name: S.name, rows };
  store.set(localStorage, K.saved, saved);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  return add.length;
}

function setAddress(key, value) {
  const v = String(value || '').trim();
  if (v) addresses[key] = v; else delete addresses[key];
  store.set(localStorage, K.addr, addresses);
}

// ---------- Výber kalendára ----------
async function loadCalendars() {
  if (!signedIn()) { calendars = []; return; }
  const out = [];
  let pageToken = '';
  do {
    const q = new URLSearchParams({ minAccessRole: 'writer', maxResults: '250' });
    if (pageToken) q.set('pageToken', pageToken);
    const page = await gfetch(`/users/me/calendarList?${q}`);
    for (const c of page.items || []) out.push({ id: c.id, name: c.summaryOverride || c.summary || c.id, primary: !!c.primary });
    pageToken = page.nextPageToken || '';
  } while (pageToken);
  calendars = out;
  if (!calendars.some((c) => c.id === settings.calendarId)) {
    const byName = calendars.find((c) => c.name.trim().toLowerCase() === DEFAULT_CALENDAR_NAME.toLowerCase());
    settings.calendarId = byName ? byName.id : '';
    store.set(localStorage, K.settings, settings);
  }
}

function renderCalendars() {
  const sel = $('cal');
  if (!signedIn()) {
    sel.innerHTML = `<option value="">${esc(DEFAULT_CALENDAR_NAME)} (po prihlásení)</option>`;
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  sel.innerHTML = (settings.calendarId ? '' : '<option value="">— vyber kalendár —</option>') +
    calendars.map((c) => `<option value="${esc(c.id)}"${c.id === settings.calendarId ? ' selected' : ''}>${esc(c.name)}${c.primary ? ' (hlavný)' : ''}</option>`).join('');
}

// ---------- Dátum a čas ----------
const pad2 = (n) => String(n).padStart(2, '0');
const DAYS = ['Nedeľa', 'Pondelok', 'Utorok', 'Streda', 'Štvrtok', 'Piatok', 'Sobota'];
function dayLabel(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return 'Bez dátumu';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return `${DAYS[d.getUTCDay()]} ${+m[3]}. ${+m[2]}. ${m[1]}`;
}
function shiftDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}
const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const validTime = (s) => /^\d{2}:\d{2}$/.test(s || '');

/** Začiatok a koniec udalosti ako miestny čas (bez zóny). Bez konca = 1 hodina. */
export function eventTimes(row) {
  if (!validDate(row.date) || !validTime(row.od)) return null;
  const [h, mi] = row.od.split(':').map(Number);
  let endDate = row.date;
  let eh; let em;
  if (validTime(row.do)) {
    [eh, em] = row.do.split(':').map(Number);
    if (eh * 60 + em < h * 60 + mi) endDate = shiftDays(row.date, 1); // cez polnoc
  } else {
    eh = h + 1; em = mi;
    if (eh >= 24) { eh -= 24; endDate = shiftDays(row.date, 1); }
  }
  return { start: `${row.date}T${pad2(h)}:${pad2(mi)}:00`, end: `${endDate}T${pad2(eh)}:${pad2(em)}:00` };
}

function eventBody(row) {
  const t = eventTimes(row);
  const desc = [['Kdo', row.kdo || S.name], ['Pásmo', row.pasmo], ['Poznámka', row.pozn]]
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  const location = addressFor(row.udalost);
  return {
    summary: row.udalost || 'Služba / Udalosť',
    description: desc,
    ...(location ? { location } : {}),
    start: { dateTime: t.start, timeZone: TZ },
    end: { dateTime: t.end, timeZone: TZ },
    reminders: { useDefault: false, overrides: [] },
  };
}

// ---------- Import ----------
async function runImport() {
  if (busy) return;
  if (!signedIn()) { signIn(); return; }
  const picked = S.rows.filter((r) => r.imp);
  if (!picked.length) return;
  for (const r of S.rows) { delete r.status; delete r.msg; }
  const bad = picked.filter((r) => !eventTimes(r));
  for (const r of bad) { r.status = 'err'; r.msg = 'Chýba platný dátum alebo čas Od'; }
  const todo = picked.filter((r) => eventTimes(r));
  if (!todo.length) { renderList(); return; }

  if (!calendars.length) {
    try { await loadCalendars(); } catch (e) {
      if (e instanceof AuthError) { signIn(); return; }
      notice('err', 'Nepodarilo sa načítať zoznam kalendárov: ' + esc(e.message)); return;
    }
    renderCalendars();
  }
  if (!settings.calendarId) {
    notice('warn', `Kalendár „${esc(DEFAULT_CALENDAR_NAME)}“ sa v prihlásenom účte nenašiel. Vyber kalendár v poli „Kalendár“ a spusti import znova.`);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  busy = true;
  const cal = encodeURIComponent(settings.calendarId);
  const prog = $('prog');
  prog.hidden = false; prog.value = 0; prog.max = todo.length;
  $('btnImport').disabled = true;
  let created = 0; let dup = 0; let err = bad.length;
  try {
    // Existujúce udalosti v danom období – kvôli duplicitám
    const dates = todo.map((r) => r.date).sort();
    const seen = new Set();
    let pageToken = '';
    do {
      const q = new URLSearchParams({
        timeMin: shiftDays(dates[0], -1) + 'T00:00:00Z',
        timeMax: shiftDays(dates[dates.length - 1], 3) + 'T00:00:00Z',
        singleEvents: 'true', maxResults: '2500', timeZone: TZ,
      });
      if (pageToken) q.set('pageToken', pageToken);
      const page = await gfetch(`/calendars/${cal}/events?${q}`);
      for (const ev of page.items || []) {
        if (ev.status === 'cancelled' || !ev.start || !ev.start.dateTime || !ev.end || !ev.end.dateTime) continue;
        seen.add(`${ev.summary || ''}|${ev.start.dateTime.slice(0, 16)}|${ev.end.dateTime.slice(0, 16)}`);
      }
      pageToken = page.nextPageToken || '';
    } while (pageToken);

    for (let i = 0; i < todo.length; i++) {
      const r = todo[i];
      const body = eventBody(r);
      const key = `${body.summary}|${body.start.dateTime.slice(0, 16)}|${body.end.dateTime.slice(0, 16)}`;
      $('count').textContent = `Importujem ${i + 1} / ${todo.length}…`;
      if (seen.has(key)) {
        r.status = 'dup'; dup++;
      } else {
        try {
          await gfetch(`/calendars/${cal}/events`, { method: 'POST', body: JSON.stringify(body) });
          r.status = 'ok'; created++; seen.add(key);
        } catch (e) {
          if (e instanceof AuthError) throw e;
          r.status = 'err'; r.msg = e.message; err++;
        }
      }
      prog.value = i + 1;
    }
    saveToApp();
    notice(err ? 'warn' : 'ok', `Import dokončený. Vytvorené: <b>${created}</b>, preskočené duplicity: <b>${dup}</b>, chyby: <b>${err}</b>. Služby sú uložené aj v appke.`);
  } catch (e) {
    if (e instanceof AuthError) notice('warn', 'Prihlásenie vypršalo. Ťukni na „Prihlásiť“ a import spusti znova – už vytvorené udalosti sa preskočia.');
    else notice('err', 'Import sa nepodaril: ' + esc(e.message));
  } finally {
    busy = false;
    prog.hidden = true;
    $('btnImport').disabled = false;
    saveSession();
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

// ---------- Vykreslenie ----------
function renderAuth() {
  $('btnAuth').textContent = signedIn() ? 'Prihlásené ✓' : 'Prihlásiť';
  renderCalendars();
}

const STATUS = { ok: ['ok', 'Vytvorené'], dup: ['warn', 'Už v kalendári'], err: ['err', 'Chyba'] };

function renderList() {
  const box = $('list');
  if (!S.rows.length) {
    box.innerHTML = `<div class="banner info">Pre „${esc(S.name)}“ sa v rozpise nenašli žiadne služby.</div>`;
  } else {
    let html = ''; let lastDay = null;
    S.rows.forEach((r, i) => {
      if (r.date !== lastDay) { html += `<div class="day">${esc(dayLabel(r.date))}</div>`; lastDay = r.date; }
      const st = r.status ? STATUS[r.status] : null;
      const time = r.od ? `${esc(r.od)}–${r.do ? esc(r.do) : '?'}` : '—';
      html += `<div class="shift${r.imp ? '' : ' off'}">
        <input type="checkbox" data-act="imp" data-i="${i}" ${r.imp ? 'checked' : ''} aria-label="Importovať">
        <div>
          <div><span class="time">${time}</span> <span class="what">${esc(r.udalost || 'Služba / Udalosť')}</span></div>
          <div class="tags">
            ${r.pasmo ? `<span class="tag">Pásmo ${esc(r.pasmo)}</span>` : ''}
            ${r.pozn ? `<span class="tag">${esc(r.pozn)}</span>` : ''}
            ${!r.do && r.od ? '<span class="tag warn">bez konca → 1 hod.</span>' : ''}
            ${r.merged ? '<span class="tag">spojené z 2 riadkov</span>' : ''}
            ${st ? `<span class="tag ${st[0]}">${st[1]}${r.msg ? ': ' + esc(r.msg) : ''}</span>` : ''}
          </div>
        </div>
        <button class="edit" type="button" data-act="edit" data-i="${i}">${editing === i ? 'Hotovo' : 'Upraviť'}</button>
        ${editing === i ? `<div class="editor">
          <label class="field">Dátum</label><input type="date" data-f="date" data-i="${i}" value="${esc(r.date)}">
          <div class="grid2">
            <div><label class="field">Od</label><input type="time" data-f="od" data-i="${i}" value="${esc(r.od)}"></div>
            <div><label class="field">Do</label><input type="time" data-f="do" data-i="${i}" value="${esc(r.do)}"></div>
          </div>
          <label class="field">Udalosť</label><input type="text" data-f="udalost" data-i="${i}" value="${esc(r.udalost)}">
          <div class="grid2">
            <div><label class="field">Pásmo</label><input type="text" data-f="pasmo" data-i="${i}" value="${esc(r.pasmo)}"></div>
            <div><label class="field">Poznámka</label><input type="text" data-f="pozn" data-i="${i}" value="${esc(r.pozn)}"></div>
          </div>
          <div class="row-btns" style="margin-top:12px"><button class="btn danger" type="button" data-act="del" data-i="${i}">Vymazať riadok</button></div>
        </div>` : ''}
      </div>`;
    });
    box.innerHTML = html;
  }
  renderBar();
}

function renderBar() {
  const n = S.rows.filter((r) => r.imp).length;
  $('bar').hidden = view !== 'upload' || !S.events.length;
  $('count').textContent = `Vybraných: ${n} z ${S.rows.length}`;
  $('btnSaveApp').disabled = busy || n === 0;
  const b = $('btnImport');
  b.disabled = busy || n === 0;
  b.textContent = signedIn() ? 'Aj do Google Kalendára' : 'Prihlásiť a do Kalendára';
}

function renderAgenda() {
  const today = todayIso();
  const tomorrow = shiftDays(today, 1);
  const all = saved.rows;
  const rows = showOld ? all : all.filter((r) => r.date >= today);
  const older = all.length - all.filter((r) => r.date >= today).length;
  $('agendaTitle').textContent = saved.name ? `Moje služby – ${saved.name}` : 'Moje služby';
  let html = '';
  if (!all.length) {
    html = '<div class="banner info">Zatiaľ tu nič nie je. V záložke „Nahrať rozpis“ vyber PDF a ťukni na „Uložiť do appky“.</div>';
  } else if (!rows.length) {
    html = '<div class="banner info">Žiadne nadchádzajúce služby. Nahraj nový rozpis.</div>';
  }
  let lastDay = null;
  rows.forEach((r) => {
    if (r.date !== lastDay) {
      const badge = r.date === today ? ' <span class="tag ok">Dnes</span>' : r.date === tomorrow ? ' <span class="tag">Zajtra</span>' : '';
      html += `<div class="day${r.date < today ? ' past' : ''}">${esc(dayLabel(r.date))}${badge}</div>`;
      lastDay = r.date;
    }
    const key = clientKey(r.udalost);
    const addr = key ? addresses[key] || '' : '';
    const time = r.od ? `${esc(r.od)}–${r.do ? esc(r.do) : '?'}` : '—';
    let addrHtml = '';
    if (key && addrEditing === key) {
      addrHtml = `<div class="addr-edit">
        <label class="field">Adresa – ${esc(key)}</label>
        <input type="text" class="addr-input" data-key="${esc(key)}" value="${esc(addr)}" autocomplete="off" placeholder="Ulica 12, Mesto">
        <div class="row-btns" style="margin-top:8px">
          <button class="btn primary" type="button" data-act="addr-save" data-key="${esc(key)}">Uložiť adresu</button>
          <button class="btn" type="button" data-act="addr-cancel">Zrušiť</button>
        </div>
      </div>`;
    } else if (key && addr) {
      addrHtml = `<div class="addr">
        <a class="maplink" href="${esc(mapsUrl(addr))}" target="_blank" rel="noopener noreferrer">📍 ${esc(addr)}</a>
        <button class="edit" type="button" data-act="addr-edit" data-key="${esc(key)}">Zmeniť</button>
      </div>`;
    } else if (key) {
      addrHtml = `<div class="addr"><button class="edit" type="button" data-act="addr-edit" data-key="${esc(key)}">+ Pridať adresu</button></div>`;
    }
    html += `<div class="shift agenda${r.date < today ? ' off' : ''}">
      <div class="when"><span class="time">${time}</span></div>
      <div>
        <div class="what">${esc(r.udalost || 'Služba / Udalosť')}</div>
        <div class="tags">
          ${r.pasmo ? `<span class="tag">Pásmo ${esc(r.pasmo)}</span>` : ''}
          ${r.pozn ? `<span class="tag">${esc(r.pozn)}</span>` : ''}
          ${!r.do && r.od ? '<span class="tag warn">bez konca</span>' : ''}
        </div>
        ${addrHtml}
      </div>
    </div>`;
  });
  if (older > 0) {
    html += `<div class="row-btns" style="margin:14px 0"><button class="btn" type="button" data-act="toggle-old">${showOld ? 'Skryť staršie služby' : `Zobraziť aj staršie (${older})`}</button></div>`;
  }
  $('agendaList').innerHTML = html;
}

function renderAll() {
  const rows = [...S.events].sort((a, b) => a.date.localeCompare(b.date) || a.od.localeCompare(b.od));
  $('allTable').innerHTML = `<table><thead><tr><th>Dátum</th><th>Od</th><th>Do</th><th>Udalosť</th><th>Kdo</th><th>Pásmo</th><th>Poznámka</th></tr></thead><tbody>${rows
    .map((e) => `<tr><td>${esc(e.date.split('-').reverse().map(Number).join('. '))}</td><td>${esc(e.od.slice(0, 5))}</td><td>${esc(e.do.slice(0, 5))}</td><td>${esc(e.udalost)}</td><td>${esc(e.kdo)}</td><td>${esc(e.pasmo)}</td><td>${esc(e.pozn)}</td></tr>`)
    .join('')}</tbody></table>`;
}

function render() {
  renderAuth();
  $('agenda').hidden = view !== 'agenda';
  $('upload').hidden = view !== 'upload';
  $('tabAgenda').classList.toggle('on', view === 'agenda');
  $('tabUpload').classList.toggle('on', view === 'upload');
  if (view === 'agenda') renderAgenda();
  const has = S.events.length > 0;
  $('work').hidden = !has;
  $('pickText').textContent = has ? 'Vybrať iný PDF rozpis' : 'Vybrať PDF rozpis služieb';
  if (has) {
    $('fileInfo').textContent = `${S.fileName} · ${S.events.length} záznamov v rozpise`;
    const names = workerNames(S.events);
    $('who').innerHTML = names.map((n) => `<option${n === S.name ? ' selected' : ''}>${esc(n)}</option>`).join('');
    renderList();
    renderAll();
  } else {
    $('bar').hidden = true;
  }
}

function pickName(names) {
  const want = (settings.defaultName || '').trim().toUpperCase();
  return names.find((n) => n.toUpperCase() === want) || names[0] || '';
}

function setName(name) {
  S.name = name;
  S.rows = rowsForWorker(S.events, name);
  editing = -1;
  saveSession();
}

// ---------- Udalosti UI ----------
$('file').addEventListener('change', async (ev) => {
  const f = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!f) return;
  notice('info', 'Spracovávam PDF…');
  try {
    const events = await parseSchedulePdf(pdfjsLib, new Uint8Array(await f.arrayBuffer()));
    if (!events.length) {
      notice('warn', 'V PDF sa nenašli žiadne služby. Je to správny súbor rozpisu?');
      return;
    }
    S = { fileName: f.name, events, name: '', rows: [] };
    setName(pickName(workerNames(events)));
    view = 'upload';
    notice('', '');
    render();
  } catch (e) {
    notice('err', 'Súbor sa nepodarilo spracovať: ' + esc(e.message || e));
  }
});

$('who').addEventListener('change', (e) => { setName(e.target.value); renderList(); });
$('cal').addEventListener('change', (e) => { settings.calendarId = e.target.value; store.set(localStorage, K.settings, settings); renderCalendars(); });
$('btnReset').addEventListener('click', () => { setName(S.name); renderList(); });
$('btnDropOff').addEventListener('click', () => { S.rows = S.rows.filter((r) => r.imp); editing = -1; saveSession(); renderList(); });
$('btnImport').addEventListener('click', runImport);
$('btnSaveApp').addEventListener('click', () => {
  const n = saveToApp();
  view = 'agenda';
  showOld = !saved.rows.some((r) => r.date >= todayIso());
  notice('ok', `Uložené do appky: <b>${n}</b> služieb pre ${esc(S.name)}.`);
  render();
  window.scrollTo({ top: 0 });
});
$('tabAgenda').addEventListener('click', () => { view = 'agenda'; addrEditing = null; notice('', ''); render(); });
$('tabUpload').addEventListener('click', () => { view = 'upload'; notice('', ''); render(); });

$('agendaList').addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act;
  if (act === 'toggle-old') showOld = !showOld;
  if (act === 'addr-edit') addrEditing = t.dataset.key;
  if (act === 'addr-cancel') addrEditing = null;
  if (act === 'addr-save') {
    const inp = t.closest('.addr-edit').querySelector('.addr-input');
    setAddress(t.dataset.key, inp.value);
    addrEditing = null;
  }
  renderAgenda();
  if (act === 'addr-edit') { const inp = $('agendaList').querySelector('.addr-input'); if (inp) inp.focus(); }
});
$('agendaList').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('addr-input')) { setAddress(e.target.dataset.key, e.target.value); addrEditing = null; renderAgenda(); }
});

// Záloha a obnova adries (súbor ostáva v zariadení)
$('btnExport').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ addresses }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'rozpis-adresy.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});
$('fileImport').addEventListener('change', async (ev) => {
  const f = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const src = data && data.addresses && typeof data.addresses === 'object' ? data.addresses : null;
    if (!src) throw new Error('súbor neobsahuje adresy');
    let n = 0;
    for (const [k, v] of Object.entries(src)) if (typeof v === 'string' && v.trim() && k.trim()) { addresses[k.trim()] = v.trim(); n++; }
    store.set(localStorage, K.addr, addresses);
    $('dlg').close();
    notice('ok', `Obnovených adries: <b>${n}</b>.`);
    render();
  } catch (e) {
    $('dlg').close();
    notice('err', 'Zálohu sa nepodarilo načítať: ' + esc(e.message));
  }
});
$('btnClearSaved').addEventListener('click', () => {
  saved = { name: '', rows: [] };
  store.set(localStorage, K.saved, saved);
  $('dlg').close();
  notice('ok', 'Uložené služby sú vymazané. Adresy ostali.');
  render();
});
$('btnAuth').addEventListener('click', () => { if (!signedIn()) signIn(); else openSettings(); });

$('list').addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const i = +t.dataset.i;
  if (t.dataset.act === 'edit') { editing = editing === i ? -1 : i; renderList(); }
  if (t.dataset.act === 'del') { S.rows.splice(i, 1); editing = -1; saveSession(); renderList(); }
});
$('list').addEventListener('change', (e) => {
  const t = e.target;
  const i = +t.dataset.i;
  if (t.dataset.act === 'imp') { S.rows[i].imp = t.checked; saveSession(); renderList(); return; }
  if (t.dataset.f) { S.rows[i][t.dataset.f] = t.value.trim(); delete S.rows[i].status; delete S.rows[i].msg; saveSession(); }
});

function openSettings() {
  $('setClient').value = settings.clientId;
  $('setName').value = settings.defaultName;
  $('showOrigin').textContent = location.origin;
  $('showRedirect').textContent = redirectUri();
  $('btnSignOut').hidden = !signedIn();
  $('addrCount').textContent = String(Object.keys(addresses).length);
  $('btnClearSaved').disabled = !saved.rows.length;
  $('dlg').showModal();
}
$('btnSettings').addEventListener('click', openSettings);
$('btnCancel').addEventListener('click', () => $('dlg').close());
$('btnSignOut').addEventListener('click', () => { signOut(); $('dlg').close(); renderBar(); });
$('btnSave').addEventListener('click', () => {
  settings = {
    clientId: $('setClient').value.trim() || DEFAULT_CLIENT_ID,
    calendarId: settings.calendarId,
    defaultName: $('setName').value.trim(),
  };
  store.set(localStorage, K.settings, settings);
  $('dlg').close();
  notice('ok', 'Nastavenia uložené.');
});

// ---------- Štart ----------
const lastSession = store.get(sessionStorage, K.session);
if (lastSession && lastSession.events && lastSession.events.length) S = lastSession;
const cameFromGoogle = /(access_token|error)=/.test(location.hash || '');
handleAuthReturn();
if (S.events.length) saveSession();
view = (cameFromGoogle && S.events.length) || !saved.rows.length ? 'upload' : 'agenda';
render();
if (signedIn()) {
  loadCalendars().then(renderCalendars).catch(() => { /* zoznam sa načíta pri importe */ });
}
