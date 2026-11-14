import * as pdfjsLib from './pdf.min.mjs';
import { parseSchedulePdf, workerNames, rowsForWorker } from './parser.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs', import.meta.url).href;

// Všetky údaje (služby, história, adresy) sú v zdieľanom Google kalendári „Julka a Ferko“,
// takže obaja vidíte to isté. V telefóne je len kópia na rýchle zobrazenie bez internetu.

const TZ = 'Europe/Prague';
const SCOPE = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly';
// Client ID nie je tajný údaj – je viditeľný v každej prihlasovacej adrese.
const DEFAULT_CLIENT_ID = '394553646019-npjt6m9166n3e90b9n374tsb5hog7rv8.apps.googleusercontent.com';
const DEFAULT_CALENDAR_NAME = 'Julka a Ferko';
const CALENDAR_NAME_PREFIX = 'julka a fer'; // sedí na „Julka a Ferko“ aj „Julka a Feri“
const API = 'https://www.googleapis.com/calendar/v3';
const HISTORY_DAYS = 31;
const AHEAD_DAYS = 400;
const TAG = 'rozpisApp'; // značka udalostí, ktoré patria appke
const BOOK_SUMMARY = 'Rozpis appka – adresy zákazníkov (nemazať)';
const K = {
  settings: 'rozpis.settings', token: 'rozpis.token', session: 'rozpis.session', resume: 'rozpis.resume',
  state: 'rozpis.oauthState', cache: 'rozpis.cache', signedBefore: 'rozpis.signedBefore', silentAt: 'rozpis.silentAt',
  oldSaved: 'rozpis.saved', oldAddr: 'rozpis.addresses', oldHist: 'rozpis.history',
};

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
let syncing = false;
let syncError = '';
// Kópia údajov z kalendára: rows = služby appky, book = adresy podľa mena zákazníka
let cache = store.get(localStorage, K.cache);
if (!cache || !Array.isArray(cache.rows)) cache = { at: 0, calId: '', rows: [], book: {} };
if (!cache.book || typeof cache.book !== 'object') cache.book = {};
let histOpen = false;
let view = 'upload'; // 'agenda' | 'upload'
let addrEditing = null;
let addrBusy = false;
let shownDay = '';

const signedIn = () => !!(token && token.t && token.exp > Date.now() + 60000);
const saveSession = () => store.set(sessionStorage, K.session, S);
const saveCache = () => store.set(localStorage, K.cache, cache);
const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/i, '');

function notice(kind, html) {
  $('notice').innerHTML = html ? `<div class="banner ${kind}" role="status">${html}</div>` : '';
}

// ---------- Google prihlásenie (presmerovanie, bez cudzích skriptov) ----------
/** silent = bez okna (funguje, keď je telefón prihlásený do Google a súhlas už bol daný). */
function signIn({ silent = false, after = '' } = {}) {
  if (!settings.clientId) {
    openSettings();
    notice('warn', 'Najprv treba v Nastaveniach vložiť Google OAuth Client ID.');
    return;
  }
  const state = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  store.set(localStorage, K.state, { state, silent, after });
  store.set(localStorage, K.resume, { at: Date.now(), S, view });
  if (silent) store.set(localStorage, K.silentAt, Date.now());
  const p = new URLSearchParams({
    client_id: settings.clientId.trim(),
    redirect_uri: redirectUri(),
    response_type: 'token',
    scope: SCOPE,
    include_granted_scopes: 'true',
    state,
  });
  if (silent) p.set('prompt', 'none');
  location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + p.toString());
}

function signOut() {
  token = null;
  calendars = [];
  store.del(localStorage, K.token);
  store.del(localStorage, K.signedBefore);
  renderAuth();
}

/** Spracuje návrat z Google. Vráti, čo sa malo po prihlásení urobiť ('save' alebo ''). */
function handleAuthReturn() {
  if (!location.hash || !/(access_token|error)=/.test(location.hash)) return '';
  const h = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname + location.search);
  const expected = store.get(localStorage, K.state) || {};
  store.del(localStorage, K.state);
  const resume = store.get(localStorage, K.resume);
  store.del(localStorage, K.resume);
  if (resume && Date.now() - resume.at < 30 * 60000) {
    if (resume.S && resume.S.events && resume.S.events.length) S = resume.S;
    if (resume.view) view = resume.view;
  }
  if (h.get('error')) {
    // Tiché prihlásenie nevyšlo (napr. treba vybrať účet) – stačí ponúknuť tlačidlo
    if (!expected.silent) notice('err', 'Prihlásenie sa nepodarilo: ' + esc(h.get('error')));
    return '';
  }
  if (!expected.state || h.get('state') !== expected.state) {
    notice('err', 'Prihlásenie sa nepodarilo overiť. Skús to prosím znova.');
    return '';
  }
  token = { t: h.get('access_token'), exp: Date.now() + (parseInt(h.get('expires_in'), 10) || 3600) * 1000 };
  store.set(localStorage, K.token, token);
  store.set(localStorage, K.signedBefore, 1);
  return expected.after || '';
}

/** Pri otvorení appky skúsi obnoviť prihlásenie bez okna (najviac raz za 10 minút). */
function trySilentSignIn() {
  if (signedIn() || !navigator.onLine || !store.get(localStorage, K.signedBefore)) return false;
  const last = store.get(localStorage, K.silentAt) || 0;
  if (Date.now() - last < 10 * 60000) return false;
  signIn({ silent: true });
  return true;
}

class AuthError extends Error {}

async function gfetch(path, opts = {}) {
  if (!signedIn()) throw new AuthError('Prihlásenie vypršalo.');
  const res = await fetch(API + path, {
    ...opts,
    headers: { Authorization: 'Bearer ' + token.t, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  if (res.status === 401) {
    token = null;
    store.del(localStorage, K.token);
    renderAuth();
    throw new AuthError('Prihlásenie vypršalo.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body.error && body.error.message) || 'HTTP ' + res.status);
  return body;
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
function nowParts() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const g = (t) => parts.find((x) => x.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour')}:${g('minute')}` };
}
const todayIso = () => nowParts().date;

/** Začiatok a koniec udalosti ako miestny čas (bez zóny). Bez konca = 1 hodina. */
function eventTimes(row) {
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

// ---------- Zákazníci a adresy ----------
/** Meno zákazníka ako kľúč adresára (bez prípony o zaúčaní). */
function clientKey(udalost) {
  const k = String(udalost || '').replace(/\s*\(Zaúčanie\)\s*$/, '').trim();
  return k === 'Zaúčanie' || k === 'Služba / Udalosť' ? '' : k;
}
const addressFor = (udalost) => { const k = clientKey(udalost); return (k && cache.book[k]) || ''; };
const COORD_RE = /^-?\d{1,2}\.\d+,\s*-?\d{1,3}\.\d+$/; // adresa zadaná ako súradnice z aktuálnej polohy
const mapsUrl = (addr) => 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(addr);

// ---------- Udalosti v kalendári ----------
const evKey = (summary, start, end) => `${summary || ''}|${String(start).slice(0, 16)}|${String(end).slice(0, 16)}`;
const cut = (v) => String(v ?? '').slice(0, 1000);

function tagsFor(row) {
  return {
    [TAG]: '1',
    worker: cut(S.name),
    kdo: cut(row.kdo || S.name),
    pasmo: cut(row.pasmo),
    pozn: cut(row.pozn),
    ...(row.merged ? { merged: '1' } : {}),
    ...(!validTime(row.do) ? { noEnd: '1' } : {}),
  };
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
    extendedProperties: { private: tagsFor(row) },
  };
}

/** Udalosť z kalendára → riadok pre zobrazenie. */
function rowFromEvent(ev) {
  if (!ev || ev.status === 'cancelled' || !ev.start || !ev.start.dateTime || !ev.end || !ev.end.dateTime) return null;
  const p = (ev.extendedProperties && ev.extendedProperties.private) || {};
  return {
    id: ev.id,
    date: ev.start.dateTime.slice(0, 10),
    od: ev.start.dateTime.slice(11, 16),
    do: p.noEnd ? '' : ev.end.dateTime.slice(11, 16),
    udalost: ev.summary || '',
    pasmo: p.pasmo || '',
    pozn: p.pozn || '',
    kdo: p.kdo || '',
    worker: p.worker || '',
    location: ev.location || '',
  };
}

async function listEvents(cal, fromDate, toDate, extra = {}) {
  const out = [];
  let pageToken = '';
  do {
    const q = new URLSearchParams({
      timeMin: fromDate + 'T00:00:00Z',
      timeMax: toDate + 'T00:00:00Z',
      singleEvents: 'true', orderBy: 'startTime', maxResults: '2500', timeZone: TZ,
      ...extra,
    });
    if (pageToken) q.set('pageToken', pageToken);
    const page = await gfetch(`/calendars/${cal}/events?${q}`);
    out.push(...(page.items || []));
    pageToken = page.nextPageToken || '';
  } while (pageToken);
  return out;
}

// Adresár je jedna skrytá celodenná udalosť z 1. 1. 2000, popis obsahuje adresy ako JSON.
async function findBookEvent(cal) {
  const q = new URLSearchParams({ privateExtendedProperty: `${TAG}=addrbook`, maxResults: '10', showDeleted: 'false' });
  const page = await gfetch(`/calendars/${cal}/events?${q}`);
  return (page.items || []).find((e) => e.status !== 'cancelled') || null;
}
function parseBook(ev) {
  if (!ev || !ev.description) return {};
  const d = ev.description;
  try {
    const data = JSON.parse(d.slice(d.indexOf('{')));
    const src = data && data.addresses && typeof data.addresses === 'object' ? data.addresses : {};
    const out = {};
    for (const [k, v] of Object.entries(src)) if (typeof v === 'string' && v.trim() && k.trim()) out[k.trim()] = v.trim();
    return out;
  } catch { return {}; }
}
/** Bezpečná zmena adresára: načíta aktuálny stav z kalendára, zmení ho a zapíše späť. */
async function updateBook(cal, change) {
  const ev = await findBookEvent(cal);
  const book = parseBook(ev);
  change(book);
  const description = 'Adresy zákazníkov pre appku Rozpis služieb. Neupravovať ručne.\n' + JSON.stringify({ addresses: book });
  if (ev) {
    await gfetch(`/calendars/${cal}/events/${encodeURIComponent(ev.id)}`, { method: 'PATCH', body: JSON.stringify({ description }) });
  } else {
    await gfetch(`/calendars/${cal}/events`, {
      method: 'POST',
      body: JSON.stringify({
        summary: BOOK_SUMMARY, description,
        start: { date: '2000-01-01' }, end: { date: '2000-01-02' },
        transparency: 'transparent',
        reminders: { useDefault: false, overrides: [] },
        extendedProperties: { private: { [TAG]: 'addrbook' } },
      }),
    });
  }
  cache.book = book;
  saveCache();
  return book;
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
    const byName = calendars.find((c) => c.name.trim().toLowerCase().startsWith(CALENDAR_NAME_PREFIX));
    settings.calendarId = byName ? byName.id : '';
    store.set(localStorage, K.settings, settings);
  }
}

async function ensureCalendar() {
  if (!calendars.length || !settings.calendarId) await loadCalendars();
  renderCalendars();
  if (!settings.calendarId) {
    throw new Error(`Kalendár „${DEFAULT_CALENDAR_NAME}“ sa v prihlásenom účte nenašiel. Vyber ho v poli „Kalendár“ v záložke Nahrať rozpis.`);
  }
  return encodeURIComponent(settings.calendarId);
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

// ---------- Načítanie spoločných údajov ----------
async function refresh() {
  if (!signedIn() || syncing) return false;
  syncing = true;
  syncError = '';
  renderSync();
  try {
    const cal = await ensureCalendar();
    const today = todayIso();
    const events = await listEvents(cal, shiftDays(today, -HISTORY_DAYS - 1), shiftDays(today, AHEAD_DAYS), { privateExtendedProperty: `${TAG}=1` });
    const book = parseBook(await findBookEvent(cal));
    cache = { at: Date.now(), calId: settings.calendarId, rows: events.map(rowFromEvent).filter(Boolean), book };
    saveCache();
    await migrateLocalData(cal);
    return true;
  } catch (e) {
    syncError = e instanceof AuthError ? 'auth' : e.message;
    return false;
  } finally {
    syncing = false;
    if (view === 'agenda') renderAgenda(); else renderSync();
  }
}

/** Adresy, ktoré boli doteraz len v tomto telefóne, sa raz presunú do zdieľaného kalendára. */
async function migrateLocalData(cal) {
  const local = store.get(localStorage, K.oldAddr);
  if (local && typeof local === 'object' && Object.keys(local).length) {
    await updateBook(cal, (book) => {
      for (const [k, v] of Object.entries(local)) if (typeof v === 'string' && v.trim() && !book[k]) book[k] = v.trim();
    });
  }
  store.del(localStorage, K.oldAddr);
  store.del(localStorage, K.oldSaved);
  store.del(localStorage, K.oldHist);
}

// ---------- Uloženie rozpisu do kalendára ----------
async function saveToCalendar() {
  if (busy) return;
  if (!signedIn()) { signIn({ after: 'save' }); return; }
  const picked = S.rows.filter((r) => r.imp);
  if (!picked.length) return;
  for (const r of S.rows) { delete r.status; delete r.msg; }
  const bad = picked.filter((r) => !eventTimes(r));
  for (const r of bad) { r.status = 'err'; r.msg = 'Chýba platný dátum alebo čas Od'; }
  const todo = picked.filter((r) => eventTimes(r));

  busy = true;
  const prog = $('prog');
  renderBar();
  let created = 0; let already = 0; let updated = 0; let removed = 0; let err = bad.length;
  try {
    const cal = await ensureCalendar();
    cache.book = parseBook(await findBookEvent(cal)); // najnovšie adresy (mohol ich pridať druhý telefón)

    // Všetky udalosti v dňoch rozpisu – kvôli duplicitám a zmenám v rozpise
    const covered = new Set(S.events.map((e) => e.date));
    const dates = [...covered, ...todo.map((r) => r.date)].sort();
    const existing = dates.length ? await listEvents(cal, shiftDays(dates[0], -1), shiftDays(dates[dates.length - 1], 2)) : [];
    const byKey = new Map();
    for (const ev of existing) {
      if (ev.status === 'cancelled' || !ev.start || !ev.start.dateTime || !ev.end || !ev.end.dateTime) continue;
      const k = evKey(ev.summary, ev.start.dateTime, ev.end.dateTime);
      if (!byKey.has(k)) byKey.set(k, ev);
    }
    const plans = todo.map((r) => { const body = eventBody(r); return { r, body, key: evKey(body.summary, body.start.dateTime, body.end.dateTime) }; });
    const planned = new Set(plans.map((x) => x.key));

    // Služby tohto pracovníka, ktoré appka uložila skôr a v novom rozpise už nie sú
    const stale = existing.filter((ev) => {
      const p = (ev.extendedProperties && ev.extendedProperties.private) || {};
      if (p[TAG] !== '1' || p.worker !== S.name || !ev.start || !ev.start.dateTime || !ev.end || !ev.end.dateTime) return false;
      return covered.has(ev.start.dateTime.slice(0, 10)) && !planned.has(evKey(ev.summary, ev.start.dateTime, ev.end.dateTime));
    });
    if (stale.length) {
      const list = stale.slice(0, 8).map((ev) => `• ${ev.start.dateTime.slice(8, 10)}.${ev.start.dateTime.slice(5, 7)}. ${ev.start.dateTime.slice(11, 16)} ${ev.summary || ''}`).join('\n');
      const more = stale.length > 8 ? `\n… a ďalšie (${stale.length - 8})` : '';
      const what = stale.length === 1 ? 'Táto služba je v kalendári, ale v novom rozpise nie je (alebo je odškrtnutá)' : `Tieto služby (${stale.length}) sú v kalendári, ale v novom rozpise nie sú (alebo sú odškrtnuté)`;
      if (confirm(`${what} – ${S.name}:\n\n${list}${more}\n\nOdstrániť z kalendára?`)) {
        for (const ev of stale) {
          await gfetch(`/calendars/${cal}/events/${encodeURIComponent(ev.id)}`, { method: 'DELETE' });
          removed++;
        }
      }
    }

    prog.hidden = false; prog.value = 0; prog.max = Math.max(1, plans.length);
    for (let i = 0; i < plans.length; i++) {
      const { r, body, key } = plans[i];
      $('count').textContent = `Ukladám ${i + 1} / ${plans.length}…`;
      const ex = byKey.get(key);
      try {
        if (ex) {
          // Služba už v kalendári je – nevytvára sa znova, len sa označí pre appku a doplní adresa
          const p = (ex.extendedProperties && ex.extendedProperties.private) || {};
          const needTag = p[TAG] !== '1';
          const needLoc = !!body.location && !ex.location;
          if (needTag || needLoc) {
            await gfetch(`/calendars/${cal}/events/${encodeURIComponent(ex.id)}`, {
              method: 'PATCH',
              body: JSON.stringify({ ...(needTag ? { extendedProperties: { private: { ...p, ...body.extendedProperties.private } } } : {}), ...(needLoc ? { location: body.location } : {}) }),
            });
          }
          if (needLoc) { r.status = 'upd'; updated++; } else { r.status = 'dup'; already++; }
        } else {
          const made = await gfetch(`/calendars/${cal}/events`, { method: 'POST', body: JSON.stringify(body) });
          byKey.set(key, made);
          r.status = 'ok'; created++;
        }
      } catch (e) {
        if (e instanceof AuthError) throw e;
        r.status = 'err'; r.msg = e.message; err++;
      }
      prog.value = i + 1;
    }
    await refresh();
    const parts = [`nové: <b>${created}</b>`, `už boli v kalendári: <b>${already}</b>`];
    if (updated) parts.push(`doplnená adresa: <b>${updated}</b>`);
    if (removed) parts.push(`odstránené: <b>${removed}</b>`);
    if (err) parts.push(`chyby: <b>${err}</b>`);
    if (!err) view = 'agenda';
    notice(err ? 'warn' : 'ok', `Uložené pre ${esc(S.name)} – ${parts.join(', ')}.`);
  } catch (e) {
    if (e instanceof AuthError) notice('warn', 'Prihlásenie vypršalo. Ťukni na „Uložiť“ znova – čo sa už uložilo, sa nezopakuje.');
    else notice('err', 'Uloženie sa nepodarilo: ' + esc(e.message));
  } finally {
    busy = false;
    prog.hidden = true;
    saveSession();
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

// ---------- Zmena adresy (zdieľaná) ----------
async function setAddress(key, value) {
  if (addrBusy) return;
  if (!signedIn()) { notice('warn', 'Adresy sú spoločné v kalendári, na ich uloženie sa treba prihlásiť.'); signIn(); return; }
  const v = String(value || '').trim();
  const old = cache.book[key] || '';
  addrBusy = true;
  renderAgenda();
  try {
    const cal = await ensureCalendar();
    await updateBook(cal, (book) => { if (v) book[key] = v; else delete book[key]; });
    // Nadchádzajúce služby toho zákazníka dostanú adresu ako miesto (ručne zadané miesto sa neprepíše)
    const today = todayIso();
    let n = 0;
    for (const r of cache.rows) {
      if (r.date < today || clientKey(r.udalost) !== key || !r.id) continue;
      if (r.location && r.location !== old) continue;
      if (r.location === v) continue;
      await gfetch(`/calendars/${cal}/events/${encodeURIComponent(r.id)}`, { method: 'PATCH', body: JSON.stringify({ location: v }) });
      r.location = v; n++;
    }
    saveCache();
    addrEditing = null;
    notice('ok', v ? `Adresa pre ${esc(key)} je uložená${n ? ` a doplnená do ${n} ${n === 1 ? 'služby' : 'služieb'} v kalendári` : ''}.` : `Adresa pre ${esc(key)} je odstránená.`);
  } catch (e) {
    notice('err', e instanceof AuthError ? 'Prihlásenie vypršalo, adresa sa neuložila. Prihlás sa a skús znova.' : 'Adresu sa nepodarilo uložiť: ' + esc(e.message));
  } finally {
    addrBusy = false;
    renderAgenda();
  }
}

// ---------- Vykreslenie ----------
function renderAuth() {
  $('btnAuth').textContent = signedIn() ? 'Prihlásené ✓' : 'Prihlásiť';
  renderCalendars();
}

const STATUS = { ok: ['ok', 'Uložené'], upd: ['ok', 'Doplnená adresa'], dup: ['warn', 'Už v kalendári'], err: ['err', 'Chyba'] };

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
        <input type="checkbox" data-act="imp" data-i="${i}" ${r.imp ? 'checked' : ''} aria-label="Uložiť túto službu">
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
  if (!busy) $('count').textContent = `Vybraných: ${n} z ${S.rows.length} · uložia sa do kalendára ${DEFAULT_CALENDAR_NAME}`;
  const b = $('btnSaveApp');
  b.disabled = busy || n === 0;
  b.textContent = busy ? 'Ukladám…' : signedIn() ? `Uložiť ${n} služieb` : 'Prihlásiť a uložiť';
}

function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = new Intl.DateTimeFormat('sk-SK', { timeZone: TZ, day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);
  return p;
}

function renderSync() {
  const el = $('syncInfo');
  if (!el) return;
  let html;
  if (syncing) html = 'Načítavam z kalendára…';
  else if (!signedIn()) html = `${cache.at ? `Naposledy načítané ${esc(fmtTime(cache.at))}. ` : ''}<button class="edit" type="button" data-act="signin">Prihlásiť sa</button> pre aktuálne spoločné služby.`;
  else if (syncError === 'auth') html = 'Prihlásenie vypršalo. <button class="edit" type="button" data-act="signin">Prihlásiť sa</button>';
  else if (syncError) html = `Nepodarilo sa načítať (${esc(syncError)}). Zobrazujem naposledy načítané.`;
  else html = cache.at ? `Spoločné s kalendárom ${esc(DEFAULT_CALENDAR_NAME)} · aktualizované ${esc(fmtTime(cache.at))}` : '';
  el.innerHTML = html;
  $('btnRefresh').hidden = !signedIn();
  $('btnRefresh').disabled = syncing;
}

function agendaCard(r, past) {
  const key = clientKey(r.udalost);
  const addr = (key && cache.book[key]) || r.location || '';
  const time = r.od ? `${esc(r.od)}–${r.do ? esc(r.do) : '?'}` : '—';
  let addrHtml = '';
  if (key && addrEditing === key && !past) {
    addrHtml = `<div class="addr-edit">
      <label class="field">Adresa – ${esc(key)}</label>
      <input type="text" class="addr-input" data-key="${esc(key)}" value="${esc(cache.book[key] || '')}" autocomplete="off" placeholder="Ulica 12, Mesto"${addrBusy ? ' disabled' : ''}>
      <div class="row-btns" style="margin-top:8px">
        <button class="btn" type="button" data-act="addr-geo"${addrBusy ? ' disabled' : ''}>📍 Použiť aktuálnu polohu</button>
      </div>
      <div class="muted small geo-msg" role="status">${addrBusy ? 'Ukladám do kalendára…' : ''}</div>
      <div class="row-btns" style="margin-top:8px">
        <button class="btn primary" type="button" data-act="addr-save" data-key="${esc(key)}"${addrBusy ? ' disabled' : ''}>Uložiť adresu</button>
        <button class="btn" type="button" data-act="addr-cancel"${addrBusy ? ' disabled' : ''}>Zrušiť</button>
      </div>
    </div>`;
  } else if (addr) {
    addrHtml = `<div class="addr">
      <a class="maplink" href="${esc(mapsUrl(addr))}" target="_blank" rel="noopener noreferrer">📍 ${esc(COORD_RE.test(addr) ? `Uložená poloha (${addr})` : addr)}</a>
      ${past || !key ? '' : `<button class="edit" type="button" data-act="addr-edit" data-key="${esc(key)}">Zmeniť</button>`}
    </div>`;
  } else if (key && !past) {
    addrHtml = `<div class="addr"><button class="edit" type="button" data-act="addr-edit" data-key="${esc(key)}">+ Pridať adresu</button></div>`;
  }
  return `<div class="shift agenda${past ? ' off' : ''}">
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
}

/** Rozdelí služby na nadchádzajúce a históriu (služba cez polnoc ostane, kým neskončí). */
function splitRows() {
  const { date: today, time } = nowParts();
  const yesterday = shiftDays(today, -1);
  const limit = shiftDays(today, -HISTORY_DAYS);
  const stays = (r) => r.date >= today ||
    (r.date === yesterday && validTime(r.od) && validTime(r.do) && r.do < r.od && time < r.do);
  const sorted = [...cache.rows].sort((a, b) => a.date.localeCompare(b.date) || a.od.localeCompare(b.od));
  const upcoming = sorted.filter(stays);
  const past = sorted.filter((r) => !stays(r) && r.date >= limit).sort((a, b) => b.date.localeCompare(a.date) || a.od.localeCompare(b.od));
  return { today, upcoming, past };
}

function renderAgenda() {
  const { today, upcoming, past } = splitRows();
  shownDay = today;
  const tomorrow = shiftDays(today, 1);
  const worker = (upcoming[0] && upcoming[0].worker) || (past[0] && past[0].worker) || '';
  $('agendaTitle').textContent = worker ? `Moje služby – ${worker}` : 'Moje služby';
  renderSync();
  let html = '';
  if (!upcoming.length) {
    html = cache.at || signedIn()
      ? '<div class="banner info">Žiadne nadchádzajúce služby. V záložke „Nahrať rozpis“ vyber PDF a ťukni na „Uložiť“.</div>'
      : '<div class="banner info">Prihlás sa do Google, aby sa načítali spoločné služby z kalendára.</div>';
  }
  let lastDay = null;
  upcoming.forEach((r) => {
    if (r.date !== lastDay) {
      const badge = r.date === today ? ' <span class="tag ok">Dnes</span>' : r.date === tomorrow ? ' <span class="tag">Zajtra</span>' : '';
      html += `<div class="day">${esc(dayLabel(r.date))}${badge}</div>`;
      lastDay = r.date;
    }
    html += agendaCard(r, false);
  });
  if (past.length) {
    html += `<div class="row-btns hist-toggle"><button class="btn" type="button" data-act="toggle-hist">${histOpen ? 'Skryť históriu' : `História – posledný mesiac (${past.length})`}</button></div>`;
    if (histOpen) {
      lastDay = null;
      past.forEach((r) => {
        if (r.date !== lastDay) { html += `<div class="day past">${esc(dayLabel(r.date))}</div>`; lastDay = r.date; }
        html += agendaCard(r, true);
      });
    }
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
$('cal').addEventListener('change', (e) => { settings.calendarId = e.target.value; store.set(localStorage, K.settings, settings); renderCalendars(); refresh(); });
$('btnReset').addEventListener('click', () => { setName(S.name); renderList(); });
$('btnDropOff').addEventListener('click', () => { S.rows = S.rows.filter((r) => r.imp); editing = -1; saveSession(); renderList(); });
$('btnSaveApp').addEventListener('click', saveToCalendar);
$('btnRefresh').addEventListener('click', () => { notice('', ''); refresh(); });
$('tabAgenda').addEventListener('click', () => {
  view = 'agenda'; addrEditing = null; histOpen = false; notice('', ''); render();
  if (signedIn() && Date.now() - cache.at > 60000) refresh();
});
$('tabUpload').addEventListener('click', () => { view = 'upload'; notice('', ''); render(); });
$('syncInfo').addEventListener('click', (e) => { if (e.target.closest('[data-act=signin]')) signIn(); });

$('agendaList').addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]');
  if (!t || addrBusy) return;
  const act = t.dataset.act;
  if (act === 'addr-geo') { useCurrentPosition(t.closest('.addr-edit')); return; }
  if (act === 'addr-save') {
    const inp = t.closest('.addr-edit').querySelector('.addr-input');
    setAddress(t.dataset.key, inp.value);
    return;
  }
  if (act === 'toggle-hist') histOpen = !histOpen;
  if (act === 'addr-edit') {
    if (!signedIn()) { notice('warn', 'Adresy sú spoločné v kalendári, na ich úpravu sa treba prihlásiť.'); signIn(); return; }
    addrEditing = t.dataset.key;
  }
  if (act === 'addr-cancel') addrEditing = null;
  renderAgenda();
  if (act === 'addr-edit') { const inp = $('agendaList').querySelector('.addr-input'); if (inp) inp.focus(); }
});
$('agendaList').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('addr-input') && !addrBusy) setAddress(e.target.dataset.key, e.target.value);
});

/** Vyplní do poľa adresy súradnice aktuálnej polohy telefónu (uloží sa až tlačidlom Uložiť). */
function useCurrentPosition(box) {
  const msg = box.querySelector('.geo-msg');
  const inp = box.querySelector('.addr-input');
  if (!navigator.geolocation) { msg.textContent = 'Toto zariadenie polohu neposkytuje.'; return; }
  msg.textContent = 'Zisťujem polohu…';
  navigator.geolocation.getCurrentPosition((pos) => {
    if (!inp.isConnected) return;
    inp.value = `${pos.coords.latitude.toFixed(6)}, ${pos.coords.longitude.toFixed(6)}`;
    msg.textContent = `Poloha zistená s presnosťou asi ${Math.round(pos.coords.accuracy)} m. Ťukni na „Uložiť adresu“.`;
  }, (err) => {
    if (!msg.isConnected) return;
    msg.textContent = err.code === 1
      ? 'Prístup k polohe je zakázaný. Povoľ ho pre túto stránku v nastaveniach prehliadača.'
      : 'Polohu sa nepodarilo zistiť. Skús to vonku alebo so zapnutou GPS.';
  }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
}

// Záloha a obnova adries (súbor ostáva v zariadení)
$('btnExport').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ addresses: cache.book }, null, 2)], { type: 'application/json' });
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
  $('dlg').close();
  try {
    if (!signedIn()) throw new Error('na obnovu adries sa treba prihlásiť');
    const data = JSON.parse(await f.text());
    const src = data && data.addresses && typeof data.addresses === 'object' ? data.addresses : null;
    if (!src) throw new Error('súbor neobsahuje adresy');
    let n = 0;
    const cal = await ensureCalendar();
    await updateBook(cal, (book) => {
      for (const [k, v] of Object.entries(src)) if (typeof v === 'string' && v.trim() && k.trim()) { book[k.trim()] = v.trim(); n++; }
    });
    notice('ok', `Obnovených adries: <b>${n}</b>.`);
    render();
  } catch (e) {
    notice('err', 'Zálohu sa nepodarilo načítať: ' + esc(e.message));
  }
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
  $('addrCount').textContent = String(Object.keys(cache.book).length);
  $('dlg').showModal();
}
$('btnSettings').addEventListener('click', openSettings);
$('btnCancel').addEventListener('click', () => $('dlg').close());
$('btnSignOut').addEventListener('click', () => { signOut(); $('dlg').close(); render(); });
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
view = cache.rows.length || store.get(localStorage, K.signedBefore) ? 'agenda' : 'upload';
const after = handleAuthReturn();
if (cameFromGoogle && S.events.length && view !== 'agenda') view = 'upload';
if (S.events.length) saveSession();

if (!cameFromGoogle && trySilentSignIn()) {
  // presmerováva sa na Google – vráti sa sem prihlásené
} else {
  render();
  if (signedIn()) {
    if (after === 'save' && S.events.length) { view = 'upload'; render(); saveToCalendar(); } else refresh();
  }
}

// O polnoci (alebo po návrate do appky v iný deň) sa včerajšok presunie do histórie;
// po návrate do appky sa údaje z kalendára obnovia, ak sú staršie ako 2 minúty.
function dayCheck() {
  if (todayIso() !== shownDay && view === 'agenda' && addrEditing === null) renderAgenda();
}
setInterval(dayCheck, 30000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  dayCheck();
  if (busy || addrBusy) return;
  if (signedIn()) { if (Date.now() - cache.at > 120000) refresh(); } else if (!busy) trySilentSignIn();
});
