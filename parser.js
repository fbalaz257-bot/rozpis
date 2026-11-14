// Čítanie PDF rozpisu služieb – čistá logika bez UI (dá sa testovať aj mimo prehliadača).
// Postup: z PDF sa vytiahnu textové bloky s ich polohou (každá bunka tabuľky je jeden blok),
// zoradia sa do riadkov podľa výšky a do stĺpcov podľa hlavičiek "Od / Do / Událost / Kdo / Pásmo / Pozn".

const mul = (A, B) => [
  A[0] * B[0] + A[2] * B[1],
  A[1] * B[0] + A[3] * B[1],
  A[0] * B[2] + A[2] * B[3],
  A[1] * B[2] + A[3] * B[3],
  A[0] * B[4] + A[2] * B[5] + A[4],
  A[1] * B[4] + A[3] * B[5] + A[5],
];
const apply = (M, x, y) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
const IDENT = [1, 0, 0, 1, 0, 0];
const asMatrix = (args) => {
  if (!args) return null;
  const m = args.length === 1 && args[0] && args[0].length === 6 ? args[0] : args;
  return m && m.length >= 6 ? Array.from(m).slice(0, 6) : null;
};

/**
 * Z operátorov stránky (pdf.js getOperatorList) vyrobí zoznam textových blokov
 * { s, x, xEnd, y } v súradniciach viewportu (y rastie smerom nadol).
 */
export function chunksFromOperatorList(opList, OPS, viewportTransform) {
  const chunks = [];
  let ctm = IDENT.slice();
  const stack = [];
  let tm = IDENT.slice(); // matica textového riadku
  let adv = 0; // posun v rámci riadku (v jednotkách textového priestoru)
  let fontSize = 1;
  const vp = viewportTransform || IDENT;

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i];
    switch (fn) {
      case OPS.save:
        stack.push(ctm.slice());
        break;
      case OPS.restore:
        if (stack.length) ctm = stack.pop();
        break;
      case OPS.transform: {
        const m = asMatrix(args);
        if (m) ctm = mul(ctm, m);
        break;
      }
      case OPS.paintFormXObjectBegin: {
        stack.push(ctm.slice());
        const m = args && args[0] && args[0].length === 6 ? Array.from(args[0]) : null;
        if (m) ctm = mul(ctm, m);
        break;
      }
      case OPS.paintFormXObjectEnd:
        if (stack.length) ctm = stack.pop();
        break;
      case OPS.beginText:
        tm = IDENT.slice();
        adv = 0;
        break;
      case OPS.setFont:
        fontSize = Number(args && args[1]) || 1;
        break;
      case OPS.setTextMatrix: {
        const m = asMatrix(args);
        if (m) tm = m;
        adv = 0;
        break;
      }
      case OPS.moveText:
      case OPS.setLeadingMoveText:
        tm = mul(tm, [1, 0, 0, 1, Number(args[0]) || 0, Number(args[1]) || 0]);
        adv = 0;
        break;
      case OPS.showText: {
        const glyphs = (args && args[0]) || [];
        let s = '';
        const start = adv;
        for (const g of glyphs) {
          if (typeof g === 'number') {
            adv -= (g / 1000) * fontSize;
          } else if (g && typeof g === 'object') {
            s += g.unicode ?? '';
            adv += ((Number(g.width) || 0) / 1000) * fontSize;
          }
        }
        if (s.trim()) {
          const M = mul(vp, mul(ctm, tm));
          const [x, y] = apply(M, start, 0);
          const [xEnd] = apply(M, adv, 0);
          chunks.push({ s, x, xEnd, y });
        }
        break;
      }
      default:
        break;
    }
  }
  return chunks;
}

const clean = (v) => (v == null ? '' : String(v).replace(/ /g, ' ').trim());
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;
const COL_KEYS = [
  ['od', /^od$/i],
  ['do', /^do$/i],
  ['udalost', /^ud[aá]lost/i],
  ['kdo', /^kdo$/i],
  ['pasmo', /^p[aá]smo?/i],
  ['pozn', /^pozn/i],
];
const colKey = (label) => {
  const t = clean(label);
  for (const [key, re] of COL_KEYS) if (re.test(t)) return key;
  return null;
};

function groupLines(chunks) {
  const sorted = [...chunks].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const c of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(c.y - last.y) <= 2) last.items.push(c);
    else lines.push({ y: c.y, items: [c] });
  }
  for (const l of lines) l.items.sort((a, b) => a.x - b.x);
  return lines;
}

function joinChunks(items) {
  let out = '';
  let prevEnd = null;
  for (const it of items) {
    if (prevEnd !== null && it.x - prevEnd > 1) out += ' ';
    out += it.s;
    prevEnd = it.xEnd;
  }
  return clean(out);
}

function isoDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Zo zoznamu textových blokov jednej stránky vráti udalosti rozpisu. */
export function eventsFromChunks(chunks, fallbackYear = new Date().getFullYear()) {
  const events = [];
  const lines = groupLines(chunks);

  // Riadky s hlavičkou stĺpcov (Od, Do, ..., Kdo)
  const headerIdx = [];
  lines.forEach((l, i) => {
    const keys = l.items.map((c) => colKey(c.s));
    if (keys.includes('od') && keys.includes('do') && keys.includes('kdo')) headerIdx.push(i);
  });
  if (!headerIdx.length) return events;

  // Rok a číslo týždňa z textu nad prvou hlavičkou
  let year = null;
  let week = null;
  for (let i = 0; i < headerIdx[0]; i++) {
    for (const c of lines[i].items) {
      const my = /\b(20\d{2})\b/.exec(c.s);
      if (my && year === null) year = parseInt(my[1], 10);
      const mw = /t[ýy]den\s*č?\.?\s*(\d{1,2})/i.exec(c.s);
      if (mw && week === null) week = parseInt(mw[1], 10);
    }
  }
  if (year === null) year = fallbackYear;

  headerIdx.forEach((hi, k) => {
    const header = lines[hi];
    // Bloky = jednotlivé dni; každý začína stĺpcom "Od"
    const blocks = [];
    for (const c of header.items) {
      const key = colKey(c.s);
      if (!key) continue;
      if (key === 'od') blocks.push({ x: c.x, cols: [] });
      if (blocks.length) blocks[blocks.length - 1].cols.push({ key, x: c.x });
    }
    if (!blocks.length) return;
    let minGap = Infinity;
    for (const b of blocks) for (let j = 1; j < b.cols.length; j++) minGap = Math.min(minGap, b.cols[j].x - b.cols[j - 1].x);
    const pad = Math.min(3, Number.isFinite(minGap) ? minGap * 0.2 : 3);
    blocks.forEach((b, j) => {
      b.from = b.x - pad;
      b.to = j + 1 < blocks.length ? blocks[j + 1].x - pad : Infinity;
    });

    // Názvy dní sú v riadku tesne nad hlavičkou
    const dayLine = hi > 0 ? lines[hi - 1] : null;
    for (const b of blocks) {
      b.date = null;
      if (!dayLine) continue;
      for (const c of dayLine.items) {
        if (c.x < b.from || c.x >= b.to) continue;
        const m = /(\d+)\.\s*(\d+)\./.exec(c.s);
        if (!m) continue;
        const d = parseInt(m[1], 10);
        const mo = parseInt(m[2], 10);
        let y = year;
        // Týždeň cez prelom roka: rok v hlavičke patrí k číslu týždňa
        if (week !== null) {
          if (mo === 12 && week <= 1) y = year - 1;
          if (mo === 1 && week >= 52) y = year + 1;
        }
        b.date = isoDate(y, mo, d);
        break;
      }
    }

    // Dátové riadky: od hlavičky po riadok s názvami dní ďalšej časti
    const end = k + 1 < headerIdx.length ? headerIdx[k + 1] - 1 : lines.length;
    // Bežný rozostup riadkov tabuľky – aby sa dalo poznať, že dva riadky idú hneď po sebe
    const gaps = [];
    for (let li = hi + 1; li < end; li++) gaps.push(lines[li].y - lines[li - 1].y);
    gaps.sort((a, b) => a - b);
    const pitch = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;

    const perBlock = blocks.map(() => []);
    for (let li = hi + 1; li < end; li++) {
      const line = lines[li];
      // Poznámky pod čiarou v hornej časti (rovnako ako pôvodná appka)
      if (k === 0 && line.items.some((c) => /DV|doktor|supervi/.test(c.s))) continue;
      blocks.forEach((b, bi) => {
        if (!b.date) return;
        const inBlock = line.items.filter((c) => c.x >= b.from && c.x < b.to);
        if (!inBlock.length) return;
        const cell = { y: line.y };
        b.cols.forEach((col, j) => {
          const from = col.x - pad;
          const to = j + 1 < b.cols.length ? b.cols[j + 1].x - pad : b.to;
          cell[col.key] = joinChunks(inBlock.filter((c) => c.x >= from && c.x < to));
        });
        perBlock[bi].push(cell);
      });
    }

    const rowEvents = []; // { y, order, ev } – aby poradie ostalo po riadkoch ako v tabuľke
    blocks.forEach((b, bi) => {
      const cells = perBlock[bi];
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i];
        const od = c.od || '';
        if (!(od && (c.kdo || c.udalost) && TIME_RE.test(od))) continue;
        const ev = {
          date: b.date,
          od,
          do: c.do || '',
          udalost: c.udalost || '',
          kdo: c.kdo || '',
          pasmo: c.pasmo || '',
          pozn: c.pozn || '',
        };
        // Jedna služba zapísaná na dva riadky: prvý má len "Od", hneď ďalší len "Do"
        const n = cells[i + 1];
        if (
          !ev.do && n && !n.od && TIME_RE.test(n.do || '') &&
          (!pitch || n.y - c.y <= pitch * 1.5) &&
          (n.kdo || '') === ev.kdo &&
          (!n.udalost || n.udalost === ev.udalost) &&
          (!n.pozn || !ev.pozn || n.pozn === ev.pozn)
        ) {
          ev.do = n.do;
          if (!ev.pozn) ev.pozn = n.pozn || '';
          if (!ev.pasmo) ev.pasmo = n.pasmo || '';
          ev.merged = true;
        }
        rowEvents.push({ y: c.y, order: bi, ev });
      }
    });
    rowEvents.sort((a, b) => a.y - b.y || a.order - b.order);
    for (const r of rowEvents) events.push(r.ev);
  });
  return events;
}

/** Prečíta celý PDF dokument (pdf.js) a vráti všetky udalosti. */
export async function parseSchedulePdf(pdfjsLib, data) {
  const doc = await pdfjsLib.getDocument({ data }).promise;
  const all = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const ops = await page.getOperatorList();
    const chunks = chunksFromOperatorList(ops, pdfjsLib.OPS, viewport.transform);
    all.push(...eventsFromChunks(chunks));
  }
  return all;
}

// ---------- Výber služieb pre jedného pracovníka (zhodné s pôvodnou appkou) ----------

const SPLIT_RE = /[\s,+/\-]+/;
const isUpper = (t) => t === t.toUpperCase() && t !== t.toLowerCase();

/** Zoznam mien/skratiek: stĺpec Kdo + skratky spomenuté v poznámkach. */
export function workerNames(events) {
  const set = new Set();
  for (const e of events) if (e.kdo) set.add(e.kdo);
  for (const e of events) {
    for (const t of String(e.pozn || '').split(SPLIT_RE)) {
      const c = t.trim();
      if ((c.length === 2 || c.length === 3) && isUpper(c) && !['SEN', 'ODP', 'KLÍ'].includes(c)) set.add(c);
    }
  }
  return [...set].filter(Boolean).sort((a, b) => a.localeCompare(b, 'cs'));
}

const hhmm = (t) => (t ? String(t).slice(0, 5) : '');

/** Riadky pre vybraného pracovníka, vrátane zaúčania (meno len v poznámke). */
export function rowsForWorker(events, name) {
  const sel = String(name || '').toUpperCase();
  const rows = [];
  for (const e of events) {
    const kdo = clean(e.kdo);
    const pozn = clean(e.pozn);
    const udalost = clean(e.udalost);
    const tokens = pozn.split(SPLIT_RE);
    const direct = kdo.toUpperCase() === sel;
    const inNotes = tokens.some((t) => t.trim().toUpperCase() === sel);
    if (!direct && !inNotes) continue;
    let rUdalost = udalost;
    let rPozn = pozn;
    let rKdo = kdo;
    if (inNotes && !direct) {
      rUdalost = udalost ? `${udalost} (Zaúčanie)` : 'Zaúčanie';
      const rest = tokens.filter((t) => t.trim() && t.trim().toUpperCase() !== sel).join(' ');
      const extra = rest ? ` - ${rest}` : '';
      rPozn = kdo ? `Zaúčanie (s ${kdo})${extra}` : `Zaúčanie${extra}`;
      rKdo = kdo ? `${name} (zaúčanie u ${kdo})` : name;
    }
    rows.push({
      imp: true,
      date: e.date,
      od: hhmm(e.od),
      do: hhmm(e.do),
      udalost: rUdalost,
      pasmo: clean(e.pasmo),
      pozn: rPozn,
      kdo: rKdo,
      ...(e.merged ? { merged: true } : {}),
    });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.od.localeCompare(b.od));
  return rows;
}
