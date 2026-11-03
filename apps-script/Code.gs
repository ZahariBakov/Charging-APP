/**
 * Tesla Charging Tracker — Google Apps Script backend.
 *
 * Paste this into Extensions → Apps Script of the charging spreadsheet (file "Code.gs"),
 * and paste dist/Index.html into an HTML file named "Index". Deploy as a Web app:
 *   Execute as: Me   ·   Who has access: Only myself
 *
 * Sheet layout (one row per charging session, newest at the top):
 *   B Дата · C Оператор · D Енергия (kWh) · E Сума (EUR) · F Време (min)
 *   G Тип зареждане (AC/DC) · H Цена киловат (formula) · I Километраж · J Проценти
 * Row 3 is the header, row 4 is the empty anchor row the totals start from (SUM(D4:...)),
 * so new sessions are inserted at row 5 and every total below picks them up automatically.
 */

const SHEET_ID = 121620705;   // the gid of the sessions tab
const FIRST_ROW = 5;          // first session row, directly under the anchor row
const COL = { date: 2, operator: 3, kwh: 4, price: 5, time: 6, type: 7, perKwh: 8, odometer: 9, percent: 10 };
const WIDTH = 9;              // columns B..J
const DATE_FORMAT = 'dd.mm.yyyy';

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Tesla Charging Tracker')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ---------- API used by the page (google.script.run) ----------

function getSessions() {
  return readSessions_(sheet_());
}

function addSession(input) {
  return withLock_(() => {
    const sh = sheet_();
    const s = validate_(input);
    const rows = readSessions_(sh);

    // Keep the sheet sorted newest first: insert above the first session that is not newer
    const before = rows.find(r => r.date <= s.date);
    const row = before ? before.id : (rows.length ? rows[rows.length - 1].id + 1 : FIRST_ROW);

    sh.insertRowBefore(row);
    // Same look as the neighbouring session rows
    const styleFrom = row + 1 <= sh.getLastRow() ? row + 1 : row - 1;
    if (styleFrom >= FIRST_ROW) {
      sh.getRange(styleFrom, COL.date, 1, WIDTH)
        .copyTo(sh.getRange(row, COL.date, 1, WIDTH), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    }
    writeRow_(sh, row, s);
    return readSessions_(sh);
  });
}

function updateSession(original, input) {
  return withLock_(() => {
    const sh = sheet_();
    const s = validate_(input);
    checkUnchanged_(sh, original);
    writeRow_(sh, original.id, s);
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
  const sh = ss.getSheets().find(s => s.getSheetId() === SHEET_ID) || ss.getSheets()[0];
  return sh;
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

// Session rows run from row 5 down to the first row without AC/DC (the statistics below)
function readSessions_(sh) {
  const last = sh.getLastRow();
  if (last < FIRST_ROW) return [];
  const values = sh.getRange(FIRST_ROW, COL.date, last - FIRST_ROW + 1, WIDTH).getValues();
  const tz = sh.getParent().getSpreadsheetTimeZone();
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const type = String(v[COL.type - 2]).trim().toUpperCase();
    if (type !== 'AC' && type !== 'DC') break;
    out.push({
      id: FIRST_ROW + i,                      // sheet row number
      date: toISO_(v[COL.date - 2], tz),
      operator: String(v[COL.operator - 2]).trim(),
      kwh: num_(v[COL.kwh - 2]),
      price: num_(v[COL.price - 2]),
      time: num_(v[COL.time - 2]),
      type: type,
      odometer: num_(v[COL.odometer - 2]),
      percent: v[COL.percent - 2] === '' ? null : num_(v[COL.percent - 2])
    });
  }
  return out;
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
  const current = readSessions_(sh).find(r => r.id === original.id);
  const same = current && current.date === original.date && current.operator === original.operator &&
    current.kwh === original.kwh && current.odometer === original.odometer;
  if (!same) throw new Error('The sheet was changed in the meantime. Reload the app and try again.');
}

function validate_(s) {
  const out = {
    date: String(s.date || ''),
    operator: String(s.operator || '').trim(),
    type: String(s.type || '').toUpperCase(),
    kwh: Number(s.kwh), price: Number(s.price), time: Number(s.time),
    percent: Number(s.percent), odometer: Number(s.odometer)
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out.date)) throw new Error('Invalid date.');
  if (!out.operator) throw new Error('Operator is required.');
  if (out.type !== 'AC' && out.type !== 'DC') throw new Error('Charging type must be AC or DC.');
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
