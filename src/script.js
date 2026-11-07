// ---------- Settings ----------

// Kept from the app's old name on purpose: changing it would lose sessions saved in local mode
const STORAGE_KEY = 'teslaChargingTracker.v2.sessions';

const TYPES = {
  AC: { color: 'var(--c-ac)', badge: 'rgba(52, 211, 153, .15)' },
  DC: { color: 'var(--c-dc)', badge: 'rgba(56, 189, 248, .15)' }
};

// Operators from the Google Sheet, most used first. Spelling here is the one that gets saved.
const DEFAULT_OPERATORS = [
  'GigaCharger', 'EvPoint', 'Fines', 'Tesla Supercharger', 'ElDrive', 'OMV',
  'Electrip', 'Kaufland - Varna', 'KIA Hypercharge', 'Electrocharge', 'EVN'
];

const NEW_OPERATOR = '__new__';   // value of the "+ New operator…" option

// True when the page is served by Apps Script, so sessions live in the Google Sheet
const useSheet = typeof google !== 'undefined' && google.script && google.script.run;

const $ = id => document.getElementById(id);

// ---------- Dates (always local time, never UTC) ----------

function toISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatDate(iso) {
  return parseISO(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// 02.11.2026, so searching the way you write dates works
function formatDateNumeric(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

function monthName(y, m) {
  return new Date(y, m, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

// ---------- Numbers and text ----------

// Round half up to 2 decimals: 23.457 -> 23.46, 1.005 -> 1.01.
// Shifting via the exponent avoids float errors that would turn 1.005 into 1.00.
const round2 = n => Number(Math.round(Number(n + 'e2')) + 'e-2');

// iPhones with Bulgarian settings only offer a comma on the number keypad, so accept both
const parseDecimal = v => round2(parseFloat(String(v).trim().replace(',', '.')));

const fmtMoney = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtKwh = n => (Math.round(n * 10) / 10).toFixed(1);

// Same as ROUND(E/D, 2) in the sheet. toPrecision drops float noise first:
// 2.01 / 2 gives 1.00499999…, which should count as 1.005 and round to 1.01.
const pricePerKwh = s => s.kwh > 0 ? round2(Number((s.price / s.kwh).toPrecision(12))).toFixed(2) : '—';

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Sample data: all in the current month, only used on first run ----------

function buildSamples() {
  const today = new Date();
  const dayInMonth = offset => {
    const d = new Date(today.getFullYear(), today.getMonth(), Math.max(1, today.getDate() - offset));
    return toISO(d);
  };

  return [
    { id: 1, date: dayInMonth(9), operator: 'Fines',              type: 'DC', kwh: 44.41, price: 17.32, time: 29,  percent: 77, odometer: 22980 },
    { id: 2, date: dayInMonth(6), operator: 'EvPoint',            type: 'AC', kwh: 30.18, price: 8.69,  time: 285, percent: 61, odometer: 23410 },
    { id: 3, date: dayInMonth(3), operator: 'GigaCharger',        type: 'AC', kwh: 26.18, price: 5.24,  time: 660, percent: 61, odometer: 23805 },
    { id: 4, date: dayInMonth(0), operator: 'Tesla Supercharger', type: 'DC', kwh: 46.99, price: 8.94,  time: 26,  percent: 86, odometer: 24120 }
  ];
}

// ---------- Validation ----------

function isValidSession(s) {
  return s && typeof s.id === 'number' && /^\d{4}-\d{2}-\d{2}$/.test(s.date) && s.type in TYPES &&
    typeof s.operator === 'string' && s.operator.trim() !== '' &&
    ['kwh', 'price', 'time', 'odometer'].every(k => Number.isFinite(s[k])) &&
    (s.percent === null || Number.isFinite(s.percent));   // older sheet rows have no percentage
}

// ---------- Google Sheet backend ----------

function callSheet(fn, ...args) {
  return new Promise((resolve, reject) => {
    const runner = google.script.run
      .withSuccessHandler(resolve)
      .withFailureHandler(err => reject(new Error(err && err.message ? err.message : String(err))));
    runner[fn](...args);
  });
}

// Every sheet call returns the sessions plus the rows it could not read
function applySheetResult(result) {
  sessions = result.sessions.filter(isValidSession);
  showSheetProblems(result.problems);
}

function showSheetProblems(rows) {
  const el = $('sheet-problems');
  el.hidden = rows.length === 0;
  if (rows.length === 0) return;

  const one = rows.length === 1;
  const which = one ? `Row ${rows[0]}` : `Rows ${rows.join(', ')}`;
  el.textContent = `${which} in the Google Sheet could not be read (the date or AC/DC in column G is missing), ` +
    `so ${one ? 'it is' : 'they are'} not shown here. Fix ${one ? 'it' : 'them'} in the sheet and reload the app.`;
}

function showMessage(text) {
  const el = $('app-message');
  el.textContent = text || '';
  el.hidden = !text;
}

// ---------- Local persistence (works even when the browser blocks storage) ----------

let storageOk = true;

function loadSessions() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter(isValidSession);
    }
  } catch (e) {
    storageOk = false;
  }
  return buildSamples();
}

function saveSessions() {
  if (useSheet) return;

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
    storageOk = true;
  } catch (e) {
    storageOk = false;
  }
  $('storage-notice').hidden = storageOk;
}

// ---------- State ----------

let sessions = useSheet ? [] : loadSessions();
let busy = false;
let editingId = null;
let editingOriginal = null;   // the session as it was when Edit was pressed, sent to the sheet as a check
let defaultDate = '';         // the date the form filled in by itself, not one the user picked
let searchQuery = '';
let activeFilter = 'All';

const now = new Date();
let viewYear = now.getFullYear();
let viewMonth = now.getMonth();   // 0-based

// ---------- Operators ----------

// Defaults plus any operator already used, so a newly added one appears in the list next time
function operatorList() {
  const list = [...DEFAULT_OPERATORS];
  sessions.forEach(s => {
    if (!list.some(o => o.toLowerCase() === s.operator.toLowerCase())) list.push(s.operator);
  });
  return list;
}

// Reuse the existing spelling when a typed name only differs in case (EVPoint -> EvPoint)
function normalizeOperator(name) {
  const clean = name.trim().replace(/\s+/g, ' ');
  return operatorList().find(o => o.toLowerCase() === clean.toLowerCase()) || clean;
}

function renderOperatorOptions(selected) {
  const select = $('operator');
  const options = operatorList().map(o => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`);
  select.innerHTML = options.join('') + `<option value="${NEW_OPERATOR}">+ New operator…</option>`;
  select.value = selected || DEFAULT_OPERATORS[0];
  toggleNewOperator();
}

function toggleNewOperator() {
  const isNew = $('operator').value === NEW_OPERATOR;
  const input = $('operator-new');
  input.hidden = !isNew;
  input.required = isNew;
  if (!isNew) input.value = '';
}

// Preselect AC/DC from the last session with this operator
function lastTypeFor(operator) {
  const last = sessions.filter(s => s.operator === operator).sort(newestFirst)[0];
  return last ? last.type : null;
}

function setType(type) {
  document.querySelectorAll('input[name="type"]').forEach(r => { r.checked = r.value === type; });
}

// ---------- Selected month + filters ----------

// Newest first. On the same day the sheet keeps the newest on top (the lower row number),
// while locally a higher id is the newer one.
function newestFirst(a, b) {
  return b.date.localeCompare(a.date) || (useSheet ? a.id - b.id : b.id - a.id);
}

function sessionsInMonth() {
  const prefix = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-`;
  return sessions.filter(s => s.date.startsWith(prefix));
}

function visibleSessions(monthSessions) {
  const q = searchQuery.trim().toLowerCase();
  const matches = s => [s.operator, s.type, s.date, formatDate(s.date), formatDateNumeric(s.date)]
    .some(v => String(v || '').toLowerCase().includes(q));

  return monthSessions
    .filter(s => activeFilter === 'All' || s.type === activeFilter)
    .filter(s => !q || matches(s))
    .sort(newestFirst);
}

// ---------- Rendering ----------

function renderStats(monthSessions) {
  const kwh = monthSessions.reduce((sum, s) => sum + s.kwh, 0);
  const cost = monthSessions.reduce((sum, s) => sum + s.price, 0);

  $('stat-kwh').textContent = fmtKwh(kwh);
  $('stat-cost').textContent = fmtMoney.format(cost);
  $('stat-count').textContent = monthSessions.length;
}

// Pie chart drawn as SVG circle segments, so the app needs no internet connection
function renderChart(monthSessions) {
  const totals = {};
  monthSessions.forEach(s => { totals[s.type] = (totals[s.type] || 0) + s.kwh; });
  const sum = Object.values(totals).reduce((a, b) => a + b, 0);
  const el = $('chart');

  if (sum <= 0) {
    el.innerHTML = '<p class="chart-empty">No data this month</p>';
    return;
  }

  const R = 15.915;   // circumference ≈ 100, so dash lengths are percentages
  let offset = 0;
  let segments = '';
  let legend = '';

  Object.keys(TYPES).filter(t => totals[t] > 0).forEach(type => {
    const pct = totals[type] / sum * 100;
    const color = TYPES[type].color;
    segments += `<circle r="${R}" cx="21" cy="21" fill="none" stroke="${color}" stroke-width="10"
      stroke-dasharray="${pct} ${100 - pct}" stroke-dashoffset="${-offset}"></circle>`;
    legend += `<li><i style="background:${color}"></i>${type}: <b>${fmtKwh(totals[type])} kWh</b> (${Math.round(pct)}%)</li>`;
    offset += pct;
  });

  el.innerHTML = `<svg viewBox="0 0 42 42" role="img" aria-label="Energy by charging type">${segments}</svg>` +
    `<ul class="legend">${legend}</ul>`;
}

function renderTable(monthSessions) {
  const visible = visibleSessions(monthSessions);
  $('rows').innerHTML = visible.map(s => `
    <tr class="${s.id === editingId ? 'editing' : ''}">
      <td data-label="Date">${formatDate(s.date)}</td>
      <td data-label="Operator" class="loc">${escapeHtml(s.operator)}</td>
      <td data-label="Type"><span class="badge" style="background:${TYPES[s.type].badge};color:${TYPES[s.type].color}">${s.type}</span></td>
      <td data-label="kWh" class="num">${s.kwh.toFixed(2)}</td>
      <td data-label="Price (€)" class="num">${fmtMoney.format(s.price)}</td>
      <td data-label="€/kWh" class="num">${pricePerKwh(s)}</td>
      <td data-label="Time (min)" class="num">${s.time}</td>
      <td data-label="End %" class="num">${s.percent === null ? '—' : s.percent + '%'}</td>
      <td data-label="Odometer (km)" class="num">${s.odometer}</td>
      <td class="row-actions">
        <button data-action="edit" data-id="${s.id}" ${busy ? 'disabled' : ''}>Edit</button>
        <button data-action="delete" data-id="${s.id}" class="del" ${busy ? 'disabled' : ''}>Delete</button>
      </td>
    </tr>`).join('');

  const n = monthSessions.length;
  $('empty-month').hidden = n > 0;
  $('empty-filter').hidden = n === 0 || visible.length > 0;
  $('list-count').textContent = visible.length === n
    ? `${n} session${n === 1 ? '' : 's'} this month`
    : `Showing ${visible.length} of ${n} this month`;

  document.querySelectorAll('.filter-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.filter === activeFilter));
}

function render() {
  const label = monthName(viewYear, viewMonth);
  $('month-label').textContent = label;
  $('summary-month').textContent = '— ' + label;

  const monthSessions = sessionsInMonth();
  renderStats(monthSessions);
  renderChart(monthSessions);
  renderTable(monthSessions);
}

// ---------- Form: add / edit ----------

const form = $('session-form');
const formFields = ['date', 'kwh', 'price', 'time', 'percent', 'odometer'];

function resetForm() {
  form.reset();
  defaultDate = toISO(new Date());
  $('date').value = defaultDate;
  renderOperatorOptions();
  setType(lastTypeFor($('operator').value));
}

function startEdit(id) {
  const s = sessions.find(x => x.id === id);
  if (!s || busy) return;

  editingId = id;
  editingOriginal = { ...s };
  formFields.forEach(f => { $(f).value = s[f] ?? ''; });
  ['kwh', 'price'].forEach(f => { $(f).value = round2(s[f]); });
  renderOperatorOptions(s.operator);
  setType(s.type);

  $('form-title').textContent = 'Edit Charging Session';
  $('submit-btn').textContent = 'Save Changes';
  $('cancel-edit').hidden = false;
  render();
  form.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function stopEdit() {
  editingId = null;
  editingOriginal = null;
  resetForm();

  $('form-title').textContent = 'Add Charging Session';
  $('submit-btn').textContent = '+ Add Session';
  $('cancel-edit').hidden = true;
  render();
}

function setBusy(on, label) {
  busy = on;
  $('submit-btn').disabled = on;
  if (on) $('submit-btn').textContent = label;
  document.querySelectorAll('.row-actions button').forEach(b => { b.disabled = on; });
}

function readForm() {
  const operator = $('operator').value === NEW_OPERATOR
    ? normalizeOperator($('operator-new').value)
    : $('operator').value;

  return {
    date: $('date').value,
    operator,
    type: form.querySelector('input[name="type"]:checked').value,
    kwh: parseDecimal($('kwh').value),
    price: parseDecimal($('price').value),
    time: parseInt($('time').value, 10),
    percent: parseInt($('percent').value, 10),
    odometer: parseInt($('odometer').value, 10)
  };
}

// When leaving the field, show the rounded value, keeping the separator that was typed
['kwh', 'price'].forEach(id => {
  $(id).addEventListener('change', () => {
    const el = $(id);
    const raw = el.value.trim();
    if (!/^\d+[.,]\d{3,}$/.test(raw)) return;

    const rounded = parseDecimal(raw).toFixed(2);
    el.value = raw.includes(',') ? rounded.replace('.', ',') : rounded;
  });
});

form.addEventListener('submit', async e => {
  e.preventDefault();
  if (busy || !form.reportValidity()) return;

  const entry = readForm();

  if (useSheet) {
    const label = $('submit-btn').textContent;
    setBusy(true, 'Saving to Google Sheet…');
    try {
      applySheetResult(editingId !== null
        ? await callSheet('updateSession', editingOriginal, entry)
        : await callSheet('addSession', entry));
      showMessage('');
    } catch (err) {
      // Keep everything typed in the form so nothing is lost
      showMessage('Not saved: ' + err.message);
      setBusy(false);
      $('submit-btn').textContent = label;
      return;
    }
    setBusy(false);
  } else if (editingId !== null) {
    sessions = sessions.map(s => s.id === editingId ? { id: editingId, ...entry } : s);
  } else {
    const nextId = sessions.reduce((max, s) => Math.max(max, s.id), 0) + 1;
    sessions.push({ id: nextId, ...entry });
  }

  // Jump to the entry's month so the change is visible
  const d = parseISO(entry.date);
  viewYear = d.getFullYear();
  viewMonth = d.getMonth();

  saveSessions();
  stopEdit();
});

$('cancel-edit').addEventListener('click', stopEdit);

$('operator').addEventListener('change', () => {
  toggleNewOperator();
  if ($('operator').value === NEW_OPERATOR) $('operator-new').focus();
  else if (editingId === null) setType(lastTypeFor($('operator').value));
});

// ---------- Delete ----------

async function deleteSession(id) {
  const s = sessions.find(x => x.id === id);
  if (!s || busy) return;

  const summary = `${formatDate(s.date)} — ${s.operator} ${s.type}, ${fmtKwh(s.kwh)} kWh`;
  if (!confirm(`Delete this charging session?\n\n${summary}`)) return;

  if (useSheet) {
    const label = $('submit-btn').textContent;
    setBusy(true, 'Deleting…');
    try {
      applySheetResult(await callSheet('deleteSession', s));
      showMessage('');
    } catch (err) {
      showMessage('Not deleted: ' + err.message);
    }
    setBusy(false);
    $('submit-btn').textContent = label;
  } else {
    sessions = sessions.filter(x => x.id !== id);
  }

  saveSessions();
  // In the sheet, deleting a row moves every row below it up, so an edit in progress
  // would point at the wrong row. Leave edit mode instead.
  if (editingId === id || (useSheet && editingId !== null)) stopEdit();
  else render();
}

// ---------- Other events ----------

$('rows').addEventListener('click', e => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;

  const id = Number(btn.dataset.id);
  if (btn.dataset.action === 'edit') startEdit(id);
  else deleteSession(id);
});

$('search').addEventListener('input', e => {
  searchQuery = e.target.value;
  renderTable(sessionsInMonth());
});

$('filters').addEventListener('click', e => {
  const btn = e.target.closest('.filter-btn');
  if (!btn) return;

  activeFilter = btn.dataset.filter;
  renderTable(sessionsInMonth());
});

function shiftMonth(delta) {
  const d = new Date(viewYear, viewMonth + delta, 1);
  viewYear = d.getFullYear();
  viewMonth = d.getMonth();
  render();
}

$('prev-month').addEventListener('click', () => shiftMonth(-1));
$('next-month').addEventListener('click', () => shiftMonth(1));

// ---------- Refresh when coming back to the app ----------

// The same fields the sheet compares before it lets an edit through
const sameSession = (a, b) =>
  a.date === b.date && a.operator === b.operator && a.kwh === b.kwh && a.odometer === b.odometer;

// Switching back to this tab or unlocking the phone reloads the sheet, so sessions added on
// another device show up. A form date left at its default also moves on to today.
async function refresh() {
  if (busy) return;

  const today = toISO(new Date());
  if (editingId === null && $('date').value === defaultDate) $('date').value = today;
  defaultDate = today;

  if (!useSheet) return;

  setBusy(true, $('submit-btn').textContent);
  try {
    applySheetResult(await callSheet('getSessions'));
  } catch (err) {
    // Offline or Google is slow: keep showing what was loaded before
  }
  setBusy(false);

  // A session added above moves every row down; keep editing the same session, not the same row
  if (editingOriginal) {
    const same = sessions.find(s => sameSession(s, editingOriginal));
    if (same) {
      editingId = same.id;
      editingOriginal = { ...same };
    }
  }
  render();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
});

// ---------- Init ----------

async function init() {
  if (useSheet) {
    $('data-source').textContent = 'Data is saved in your Google Sheet';
    setBusy(true, 'Loading from Google Sheet…');
    render();
    try {
      applySheetResult(await callSheet('getSessions'));
      showMessage('');
    } catch (err) {
      showMessage('Could not load the Google Sheet: ' + err.message + ' Reload the page to try again.');
    }
    setBusy(false);
    stopEdit();   // puts the form and the "+ Add Session" label back after "Loading…"
  } else {
    $('data-source').textContent = 'Local mode — data is saved only in this browser';
    resetForm();
    saveSessions();   // stores the samples on first run and shows the warning if storage is blocked
    render();
  }
}

init();
