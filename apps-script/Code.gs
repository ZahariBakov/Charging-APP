/**
 * EV Charging Tracker — Google Apps Script backend.
 *
 * Paste this into Extensions → Apps Script of the charging spreadsheet (file "Code.gs"),
 * and paste dist/Index.html into an HTML file named "Index". Deploy as a Web app:
 *   Execute as: Me   ·   Who has access: Only myself
 *
 * Sheet layout (one row per charging session, newest at the top):
 *   B Date · C Operator · D Energy (kWh) · E Price (EUR) · F Time (min)
 *   G Type (AC/DC) · H Price per kWh (formula) · I Odometer · J Ending %
 * Row 3 is the header, row 4 is the empty anchor row the totals start from (SUM(D4:...)),
 * so new sessions are inserted at row 5 and every total below picks them up automatically.
 */

// Limits the script's access to this one spreadsheet, not all of your files
/** @OnlyCurrentDoc */

const SHEET_ID = 121620705;   // the gid of the sessions tab
const FIRST_ROW = 5;          // first session row, directly under the anchor row
const COL = { date: 2, operator: 3, kwh: 4, price: 5, time: 6, type: 7, perKwh: 8, odometer: 9, percent: 10 };
const WIDTH = 9;              // columns B..J
const DATE_FORMAT = 'dd.mm.yyyy';
const TYPES = ['AC', 'DC'];

// The icon in the browser tab. Apps Script needs a link to a PNG, so it comes from GitHub.
const FAVICON_URL = 'https://raw.githubusercontent.com/ZahariBakov/Charging-APP/main/assets/favicon.png';

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('EV Charging Tracker')
    .setFaviconUrl(FAVICON_URL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ---------- API used by the page (google.script.run) ----------
// Every call returns { sessions, problems }: the sessions, and the rows that could not be read.

function getSessions() {
  return readSessions_(sheet_());
}

function addSession(input) {
  return withLock_(() => {
    const sh = sheet_();
    insertSorted_(sh, validate_(input));
    return readSessions_(sh);
  });
}

function updateSession(original, input) {
  return withLock_(() => {
    const sh = sheet_();
    const s = validate_(input);
    checkUnchanged_(sh, original);

    if (s.date === original.date) {
      writeRow_(sh, original.id, s);
    } else {
      // A new date belongs elsewhere in the newest-first order, so the row moves there.
      // The new row is added before the old one is deleted, so a failure in between
      // leaves a duplicate instead of losing the session.
      const row = insertSorted_(sh, s);
      sh.deleteRow(row <= original.id ? original.id + 1 : original.id);
    }
    return readSessions_(sh);
  });
}

function deleteSession(original) {
  return withLock_(() => {
    const sh = sheet_();
    checkUnchanged_(sh, original);
    sh.deleteRow(original.id);
    return readSessions_(sh);
  });
}

// ---------- Helpers ----------

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheets().find(s => s.getSheetId() === SHEET_ID) || ss.getSheets()[0];
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return fn();
  } finally {
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
}

// Session rows run from row 5 down to the last row with AC/DC in column G; the statistics
// below them are left alone. Inside that range, empty rows are skipped and rows without a
// readable date or AC/DC are reported as problems instead of being hidden silently.
function readSessions_(sh) {
  const last = sh.getLastRow();
  if (last < FIRST_ROW) return { sessions: [], problems: [] };

  const values = sh.getRange(FIRST_ROW, COL.date, last - FIRST_ROW + 1, WIDTH).getValues();
  const tz = sh.getParent().getSpreadsheetTimeZone();
  const cell = (v, key) => v[COL[key] - COL.date];
  const typeOf = v => String(cell(v, 'type')).trim().toUpperCase();

  let end = values.length - 1;
  while (end >= 0 && !TYPES.includes(typeOf(values[end]))) end--;

  const sessions = [];
  const problems = [];
  for (let i = 0; i <= end; i++) {
    const v = values[i];
    const row = FIRST_ROW + i;
    if (v.every(c => c === '')) continue;

    const type = typeOf(v);
    const date = toISO_(cell(v, 'date'), tz);
    if (!TYPES.includes(type) || !date) {
      problems.push(row);
      continue;
    }

    sessions.push({
      id: row,                                // sheet row number
      date: date,
      operator: String(cell(v, 'operator')).trim(),
      kwh: num_(cell(v, 'kwh')),
      price: num_(cell(v, 'price')),
      time: num_(cell(v, 'time')),
      type: type,
      odometer: num_(cell(v, 'odometer')),
      percent: cell(v, 'percent') === '' ? null : num_(cell(v, 'percent'))
    });
  }
  return { sessions: sessions, problems: problems };
}

// Keeps the sheet sorted newest first: inserts above the first session that is not newer.
// Returns the row number of the new session.
function insertSorted_(sh, s) {
  const rows = readSessions_(sh).sessions;
  const before = rows.find(r => r.date <= s.date);
  const last = rows[rows.length - 1];
  const row = before ? before.id : (last ? last.id + 1 : FIRST_ROW);

  sh.insertRowBefore(row);

  // Same look as a neighbouring session: the one pushed down, or the one above when added last
  const styleFrom = before ? row + 1 : (last ? last.id : null);
  if (styleFrom) {
    sh.getRange(styleFrom, COL.date, 1, WIDTH)
      .copyTo(sh.getRange(row, COL.date, 1, WIDTH), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
  }

  writeRow_(sh, row, s);
  return row;
}

function writeRow_(sh, row, s) {
  const [y, m, d] = s.date.split('-').map(Number);
  // Noon avoids the date moving a day when the script and sheet time zones differ
  const date = new Date(y, m - 1, d, 12);

  sh.getRange(row, COL.date, 1, WIDTH).setValues([[
    date, s.operator, s.kwh, s.price, s.time, s.type,
    `=ROUND(E${row}/D${row}, 2)`, s.odometer, s.percent
  ]]);
  sh.getRange(row, COL.date).setNumberFormat(DATE_FORMAT);
}

// The page sends the row it saw; refuse to touch the row if the sheet changed since then
function checkUnchanged_(sh, original) {
  const current = readSessions_(sh).sessions.find(r => r.id === original.id);
  const same = current && current.date === original.date && current.operator === original.operator &&
    current.kwh === original.kwh && current.odometer === original.odometer;
  if (!same) throw new Error('The sheet was changed in the meantime. Reload the app and try again.');
}

function validate_(s) {
  const out = {
    date: String(s.date || ''),
    operator: String(s.operator || '').trim(),
    type: String(s.type || '').toUpperCase(),
    kwh: Number(s.kwh),
    price: Number(s.price),
    time: Number(s.time),
    percent: Number(s.percent),
    odometer: Number(s.odometer)
  };

  if (!/^\d{4}-\d{2}-\d{2}$/.test(out.date)) throw new Error('Invalid date.');
  if (!out.operator) throw new Error('Operator is required.');
  if (!TYPES.includes(out.type)) throw new Error('Charging type must be AC or DC.');
  ['kwh', 'price', 'time', 'percent', 'odometer'].forEach(k => {
    if (!Number.isFinite(out[k]) || out[k] < 0) throw new Error(`Invalid value for ${k}.`);
  });
  if (out.kwh === 0) throw new Error('Energy (kWh) must be more than 0.');
  if (out.percent > 100) throw new Error('Ending percentage must be 0–100.');

  return out;
}

// Dates in the sheet are either real dates or text like "30.10.2026"
function toISO_(v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  const m = String(v).trim().match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return '';
}

function num_(v) {
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}
