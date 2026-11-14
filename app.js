import * as pdfjsLib from './pdf.min.mjs';
import { parseSchedulePdf, workerNames, rowsForWorker } from './parser.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs', import.meta.url).href;

const TZ = 'Europe/Prague';
const SCOPE = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly';
// Client ID nie je tajný údaj – je viditeľný v každej prihlasovacej adrese.
const DEFAULT_CLIENT_ID = '394553646019-npjt6m9166n3e90b9n374tsb5hog7rv8.apps.googleusercontent.com';
const DEFAULT_CALENDAR_NAME = 'Julka a Feri';
const API = 'https://www.googleapis.com/calendar/v3';
const K = { settings: 'rozpis.settings', token: 'rozpis.token', session: 'rozpis.session', resume: 'rozpis.resume', state: 'rozpis.oauthState' };

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
  return {
    summary: row.udalost || 'Služba / Udalosť',
    description: desc,
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
    notice(err ? 'warn' : 'ok', `Import dokončený. Vytvorené: <b>${created}</b>, preskočené duplicity: <b>${dup}</b>, chyby: <b>${err}</b>.`);
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
  $('bar').hidden = !S.events.length;
  $('count').textContent = `Vybraných na import: ${n} z ${S.rows.length}`;
  const b = $('btnImport');
  b.disabled = busy || n === 0;
  b.textContent = signedIn() ? `Importovať ${n} do Google Kalendára` : 'Prihlásiť sa do Google a importovať';
}

function renderAll() {
  const rows = [...S.events].sort((a, b) => a.date.localeCompare(b.date) || a.od.localeCompare(b.od));
  $('allTable').innerHTML = `<table><thead><tr><th>Dátum</th><th>Od</th><th>Do</th><th>Udalosť</th><th>Kdo</th><th>Pásmo</th><th>Poznámka</th></tr></thead><tbody>${rows
    .map((e) => `<tr><td>${esc(e.date.split('-').reverse().map(Number).join('. '))}</td><td>${esc(e.od.slice(0, 5))}</td><td>${esc(e.do.slice(0, 5))}</td><td>${esc(e.udalost)}</td><td>${esc(e.kdo)}</td><td>${esc(e.pasmo)}</td><td>${esc(e.pozn)}</td></tr>`)
    .join('')}</tbody></table>`;
}

function render() {
  renderAuth();
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
const saved = store.get(sessionStorage, K.session);
if (saved && saved.events && saved.events.length) S = saved;
handleAuthReturn();
if (S.events.length) saveSession();
render();
if (signedIn()) {
  loadCalendars().then(renderCalendars).catch(() => { /* zoznam sa načíta pri importe */ });
}
