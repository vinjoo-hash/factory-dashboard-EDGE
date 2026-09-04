/**
 * admin.js — Admin panel. Every write goes through saveXxx() -> POST with adminKey.
 * Nothing here duplicates schedule/calculation logic — that all lives in engine.js.
 */

let ADMIN = { key: '', slotConfig: [], workers: [], allWorkers: [], lines: [], records: [], downtimeLogs: [] };
let rowCounter = 0;
let EDITING_RECORD_ID = null;

function toast(msg, isError) {
  const host = document.getElementById('toastHost');
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

/**
 * Every write goes through this instead of a raw fetch(). Two things this
 * buys us that a plain fetch doesn't:
 * 1. A hard timeout (default 15s) via AbortController — a hung request (bad
 *    network, a slow Apps Script cold start) can no longer leave a button
 *    stuck on "جاري الحفظ..." forever with no feedback.
 * 2. One place that always returns a PARSED, predictable shape, so callers
 *    never have to guess whether res.json() itself might throw.
 */
async function postAction(action, payload, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 15000);
  try {
    const res = await fetch(CONFIG.API_URL, {
      method: 'POST',
      body: JSON.stringify({ action, adminKey: ADMIN.key, ...payload }),
      signal: controller.signal,
    });
    let data;
    try { data = await res.json(); }
    catch (parseErr) { return { ok: false, message: 'لم يتم حفظ البيانات، حاول مرة أخرى', _technical: 'Bad JSON response: ' + parseErr.message }; }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, message: 'انتهت مهلة الاتصال بالخادم، حاول مرة أخرى', _technical: 'timeout' };
    return { ok: false, message: 'لم يتم حفظ البيانات، حاول مرة أخرى', _technical: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Shows the right toast for any postAction() result, logging the technical detail to console only (never to the user). */
function handleActionResult(data, successMessage) {
  if (data._technical) console.error('[admin]', data._technical);
  if (data.error === 'SERVER_BUSY_TRY_AGAIN') { toast('الخادم مشغول بحفظ سابق، حاول مرة أخرى بعد ثانية', true); return false; }
  if (!data.ok) { toast(data.message || 'لم يتم حفظ البيانات، حاول مرة أخرى', true); return false; }
  toast(data.message || successMessage || 'تم الحفظ بنجاح ✓');
  return true;
}

function doLogin() {
  const key = document.getElementById('adminKeyInput').value.trim();
  if (!key) { toast('أدخل كلمة المرور', true); return; }
  ADMIN.key = key;
  sessionStorage.setItem('adminKey', key);
  loadAdminData();
}

async function loadAdminData() {
  try {
    const res = await fetch(`${CONFIG.API_URL}?action=getData`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    ADMIN.slotConfig = data.slotConfig.map(s => ({ ...s, slot: String(s.slot) }));
    ADMIN.workers = data.workers;
    ADMIN.allWorkers = data.allWorkers || data.workers;
    ADMIN.lines = data.lines;
    ADMIN.records = data.records;
    ADMIN.downtimeLogs = data.downtimeLogs || [];

    document.getElementById('loginCard').style.display = 'none';
    document.getElementById('adminApp').style.display = 'block';

    initEntryTab();
    renderWorkersList();
    renderTargetsList();
    renderSlotConfigTable();
    populateDowntimeLines();
    renderDataQualityReport();
    renderRecordsList();
  } catch (err) {
    toast('فشل الاتصال — تحقق من الرابط في config.js', true);
    console.error(err);
  }
}

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
  document.getElementById('tab-' + name).style.display = 'block';
  if (name === 'quality') renderDataQualityReport();
  if (name === 'records') renderRecordsList();
}

// ---------- ENTRY TAB ----------

function initEntryTab() {
  const dateInput = document.getElementById('entryDate');
  if (!dateInput.value) dateInput.value = Engine.fmtDate(new Date());

  const slotSelect = document.getElementById('entrySlot');
  const sorted = [...ADMIN.slotConfig].sort((a, b) => Engine.timeToMinutes(a.start) - Engine.timeToMinutes(b.start));
  slotSelect.innerHTML = sorted.map(s => `<option value="${s.slot}">فترة ${s.slot} (${s.start}–${s.end})${s.type === 'OVERTIME' ? ' - أوفر تايم' : ''}</option>`).join('');

  const statusInfo = Engine.getStatus(ADMIN.slotConfig, new Date());
  if (statusInfo.slot) slotSelect.value = String(statusInfo.slot);
  document.getElementById('adminSlotInfo').textContent = Engine.STATUS_LABELS_AR[statusInfo.status];

  document.getElementById('entryRows').innerHTML = '';
  addEntryRow();
}

function currentEntrySlotType() {
  const slotVal = document.getElementById('entrySlot').value;
  const s = ADMIN.slotConfig.find(x => String(x.slot) === String(slotVal));
  return s ? s.type : 'NORMAL';
}

function lineOptionsHTML(selected) {
  const lines = [...new Set(ADMIN.lines.map(l => l.line))];
  if (!lines.length) lines.push('Line(4)', 'Line(5)', 'Line(6)', 'Line(7)');
  return lines.map(l => `<option value="${l}" ${l === selected ? 'selected' : ''}>${l}</option>`).join('');
}

function populateDowntimeLines() {
  const select = document.getElementById('downtimeLine');
  const lines = [...new Set(ADMIN.lines.map(l => l.line))];
  select.innerHTML = '<option value="">اختر الخط</option>' + lines.map(line => `<option value="${line}">${line}</option>`).join('');
}

function workerOptionsHTML(selected) {
  return ADMIN.workers.map(w => `<option value="${w.name}" ${w.name === selected ? 'selected' : ''}>${w.name}</option>`).join('');
}

function addEntryRow(prefill) {
  rowCounter++;
  const id = 'row' + rowCounter;
  const row = document.createElement('div');
  row.className = 'entry-row';
  row.id = id;
  row.innerHTML = `
    <div><select class="e-worker">${workerOptionsHTML(prefill && prefill.worker)}</select></div>
    <div><select class="e-line">${lineOptionsHTML(prefill && prefill.line)}</select></div>
    <div><input type="number" class="e-qty" min="0" placeholder="الكمية" value="${prefill ? prefill.production : ''}"></div>
    <button class="btn-danger" onclick="document.getElementById('${id}').remove()">✕</button>`;
  document.getElementById('entryRows').appendChild(row);
}

let SAVE_IN_PROGRESS = false;

async function saveProduction() {
  // Front-line guard: a double-tap or an impatient repeat-click must never fire
  // a second request while the first is still in flight. The real protection is
  // the server-side lock in Code.gs, but stopping the duplicate request here
  // means no wasted round-trip and no "SERVER_BUSY" message for a normal double-tap.
  if (SAVE_IN_PROGRESS) return;

  const date = document.getElementById('entryDate').value;
  const slot = document.getElementById('entrySlot').value;
  const type = currentEntrySlotType();
  // Scoped to #entryRows specifically — NOT a page-wide '.entry-row' query.
  // The downtime-reason widget below also uses the '.entry-row' CSS class
  // (just for the same grid layout), so an unscoped query here would also
  // match that row and crash on .querySelector('.e-worker') returning null.
  const rows = [...document.querySelectorAll('#entryRows .entry-row')];
  const entries = rows.map(r => ({
    date, slot, type,
    worker: r.querySelector('.e-worker').value,
    line: r.querySelector('.e-line').value,
    production: r.querySelector('.e-qty').value,
  })).filter(e => e.production !== '');

  if (!entries.length) { toast('أدخل كمية واحدة على الأقل', true); return; }
  for (const e of entries) {
    if (Number(e.production) < 0 || isNaN(Number(e.production))) { toast('كمية غير صالحة لأحد العمال', true); return; }
  }

  const saveBtn = document.querySelector('#tab-entry .btn-primary');
  SAVE_IN_PROGRESS = true;
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'جاري الحفظ...'; }

  try {
    const data = await postAction('saveProduction', { entries });
    if (handleActionResult(data, 'تم حفظ الإنتاج بنجاح')) loadAdminData();
  } finally {
    SAVE_IN_PROGRESS = false;
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'حفظ الإنتاج'; }
  }
}

// ---------- PRODUCTION RECORDS TAB (view / edit / delete) ----------

function renderRecordsList() {
  const dateInput = document.getElementById('recordsDate');
  if (!dateInput.value) dateInput.value = Engine.fmtDate(new Date());
  if (!dateInput.dataset.wired) { dateInput.dataset.wired = '1'; dateInput.addEventListener('change', renderRecordsList); }

  const date = dateInput.value;
  const dayRecords = ADMIN.records
    .filter(r => r.date === date)
    .sort((a, b) => String(a.slot).localeCompare(String(b.slot), undefined, { numeric: true }) || a.line.localeCompare(b.line));

  const box = document.getElementById('recordsList');
  if (!dayRecords.length) { box.innerHTML = '<div class="empty-state">لا توجد سجلات إنتاج لهذا اليوم</div>'; return; }

  box.innerHTML = dayRecords.map(r => `
    <div class="worker-row">
      <div>
        <b>${r.worker}</b> — ${r.line}
        <div class="lines">فترة ${r.slot} · ${r.type === 'OVERTIME' ? 'أوفر تايم' : 'عادي'} · الكمية: ${r.production}</div>
      </div>
      <div style="display:flex; gap:6px;">
        <button class="btn-secondary" onclick="editProductionRecord('${r.recordId}')">تعديل</button>
        <button class="btn-danger" onclick="deleteProductionRecord('${r.recordId}')">حذف</button>
      </div>
    </div>`).join('');
}

function editProductionRecord(recordId) {
  const r = ADMIN.records.find(x => x.recordId === recordId);
  if (!r) { toast('لم يتم العثور على هذا السجل — حدّث الصفحة وحاول مرة أخرى', true); return; }
  EDITING_RECORD_ID = recordId;

  document.getElementById('editWorker').innerHTML = workerOptionsHTML(r.worker);
  document.getElementById('editLine').innerHTML = lineOptionsHTML(r.line);
  const sortedSlots = [...ADMIN.slotConfig].sort((a, b) => Engine.timeToMinutes(a.start) - Engine.timeToMinutes(b.start));
  document.getElementById('editSlot').innerHTML = sortedSlots.map(s => `<option value="${s.slot}" ${String(s.slot) === String(r.slot) ? 'selected' : ''}>فترة ${s.slot} (${s.start}–${s.end})${s.type === 'OVERTIME' ? ' - أوفر تايم' : ''}</option>`).join('');
  document.getElementById('editQty').value = r.production;

  document.getElementById('recordEditCard').style.display = 'block';
  document.getElementById('recordEditCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function cancelEditRecord() {
  EDITING_RECORD_ID = null;
  document.getElementById('recordEditCard').style.display = 'none';
}

async function saveEditedRecord() {
  if (!EDITING_RECORD_ID) return;
  const original = ADMIN.records.find(x => x.recordId === EDITING_RECORD_ID);
  if (!original) { toast('لم يتم العثور على هذا السجل', true); cancelEditRecord(); return; }

  const newQty = document.getElementById('editQty').value;
  if (newQty === '' || Number(newQty) < 0 || isNaN(Number(newQty))) { toast('كمية غير صالحة', true); return; }

  const newWorker = document.getElementById('editWorker').value;
  const newLine = document.getElementById('editLine').value;
  const newSlot = document.getElementById('editSlot').value;
  const slotInfo = ADMIN.slotConfig.find(s => String(s.slot) === String(newSlot));

  // Ask for confirmation only when the change is substantial (quantity moved
  // by more than a small amount, or the worker/line/slot itself changed) —
  // per the requested UX: don't nag for a trivial correction.
  const qtyChanged = Number(newQty) !== Number(original.production);
  const bigChange = Math.abs(Number(newQty) - Number(original.production)) >= Math.max(20, Number(original.production) * 0.3);
  const identityChanged = newWorker !== original.worker || newLine !== original.line || String(newSlot) !== String(original.slot);
  if (bigChange || identityChanged) {
    const ok = confirm('هذا تعديل جوهري على السجل — هل أنت متأكد من الحفظ؟');
    if (!ok) return;
  }

  const editBtn = document.querySelector('#recordEditCard .btn-primary');
  if (editBtn) { editBtn.disabled = true; editBtn.textContent = 'جاري الحفظ...'; }

  try {
    const data = await postAction('updateProduction', {
      recordId: EDITING_RECORD_ID,
      date: original.date, slot: newSlot, worker: newWorker, line: newLine,
      production: newQty, type: slotInfo ? slotInfo.type : original.type,
    });
    if (handleActionResult(data, 'تم تعديل الإنتاج بنجاح')) {
      cancelEditRecord();
      loadAdminData();
    }
  } finally {
    if (editBtn) { editBtn.disabled = false; editBtn.textContent = 'حفظ التعديل'; }
  }
}

async function deleteProductionRecord(recordId) {
  const r = ADMIN.records.find(x => x.recordId === recordId);
  const label = r ? `${r.worker} — ${r.line} — فترة ${r.slot} — ${r.production} قطعة` : 'هذا السجل';
  const ok = confirm(`هل أنت متأكد من حذف: ${label}؟ لا يمكن التراجع عن هذا الإجراء.`);
  if (!ok) return;

  const data = await postAction('deleteProduction', { recordId });
  if (handleActionResult(data, 'تم حذف السجل بنجاح')) {
    if (EDITING_RECORD_ID === recordId) cancelEditRecord();
    loadAdminData();
  }
}

async function saveDowntimeReason() {
  const date = document.getElementById('entryDate').value;
  const slot = document.getElementById('entrySlot').value;
  const line = document.getElementById('downtimeLine').value;
  const reason = document.getElementById('downtimeReason').value;
  const notes = document.getElementById('downtimeNotes').value.trim();
  if (!date || !slot || !line || !reason) { toast('اختر الخط والسبب قبل الحفظ', true); return; }
  const data = await postAction('saveDowntimeReason', { date, slot, line, reason, notes });
  if (handleActionResult(data, 'تم حفظ سبب التوقف')) {
    document.getElementById('downtimeReason').value = '';
    document.getElementById('downtimeNotes').value = '';
    loadAdminData();
  }
}

// ---------- WORKERS TAB ----------

function renderWorkersList() {
  const box = document.getElementById('workersList');
  if (!ADMIN.workers.length) { box.innerHTML = '<div class="empty-state">لا يوجد عمال بعد</div>'; return; }
  box.innerHTML = ADMIN.workers.map(w => `
    <div class="worker-row">
      <span class="name">${w.name}</span>
      <button class="btn-secondary" onclick="removeWorker('${w.id}')">إزالة</button>
    </div>`).join('');
}

async function addWorker() {
  const name = document.getElementById('newWorkerName').value.trim();
  if (!name) { toast('أدخل اسم العامل', true); return; }
  const data = await postAction('saveWorker', { name, active: true });
  if (handleActionResult(data, 'تمت إضافة العامل')) {
    document.getElementById('newWorkerName').value = '';
    loadAdminData();
  }
}

async function removeWorker(id) {
  const w = ADMIN.workers.find(x => x.id === id);
  const data = await postAction('saveWorker', { id, name: w.name, active: false });
  if (handleActionResult(data, 'تمت إزالة العامل')) loadAdminData();
}

// ---------- TARGETS TAB ----------

function renderTargetsList() {
  const today = Engine.fmtDate(new Date());
  document.getElementById('targetDate').value = document.getElementById('targetDate').value || today;
  const box = document.getElementById('targetsList');
  const todays = ADMIN.lines.filter(l => l.date === document.getElementById('targetDate').value);
  if (!todays.length) { box.innerHTML = '<div class="empty-state">لا توجد أهداف محددة لهذا اليوم</div>'; return; }
  box.innerHTML = todays.map(l => `
    <div class="worker-row"><span>${l.line}</span><span>الهدف: ${l.target}</span></div>`).join('');
}

async function saveTarget() {
  const date = document.getElementById('targetDate').value;
  const line = document.getElementById('targetLine').value.trim();
  const target = document.getElementById('targetValue').value;
  const plannedHours = document.getElementById('targetHours').value || 6;
  const hourlyTarget = document.getElementById('targetHourly').value || '';
  if (!date || !line || !target) { toast('أكمل جميع الحقول المطلوبة', true); return; }
  const data = await postAction('setTarget', { date, line, target, plannedHours, hourlyTarget });
  if (handleActionResult(data, 'تم حفظ الهدف')) loadAdminData();
}

// ---------- SLOTS TAB (read-only view) ----------

function renderSlotConfigTable() {
  const tbody = document.querySelector('#slotConfigTable tbody');
  const sorted = [...ADMIN.slotConfig].sort((a, b) => Engine.timeToMinutes(a.start) - Engine.timeToMinutes(b.start));
  tbody.innerHTML = sorted.map(s => `<tr><td>${s.slot}</td><td>${s.start}</td><td>${s.end}</td><td>${s.type === 'OVERTIME' ? 'أوفر تايم' : 'عادي'}</td></tr>`).join('');
}

function renderDataQualityReport() {
  const box = document.getElementById('dataQualityReport');
  const report = Engine.computeDataQualityReport(ADMIN.records, ADMIN.lines, ADMIN.allWorkers, ADMIN.slotConfig, CONFIG.DATA_QUALITY);
  const labels = { DUPLICATE_KEY: 'تكرار محتمل', INVALID_SLOT: 'فترة غير صالحة', UNKNOWN_WORKER: 'عامل غير معروف', MISSING_TARGET: 'هدف مفقود', ZERO_PRODUCTION: 'إنتاج صفري', HIGH_QUANTITY: 'كمية مرتفعة', MISSING_SLOTS: 'فترات ناقصة' };
  const severity = { critical: 'behind', warning: 'overtime', info: 'catchup' };
  const summary = `<div class="line-stats"><div class="cell"><div class="k">حرج</div><div class="v">${report.counts.critical}</div></div><div class="cell"><div class="k">يحتاج مراجعة</div><div class="v">${report.counts.warning}</div></div><div class="cell"><div class="k">معلومة</div><div class="v">${report.counts.info}</div></div></div>`;
  const rows = report.findings.length ? report.findings.map(f => `<div class="alert ${severity[f.severity]}"><b>${labels[f.type] || f.type}:</b> ${f.message}</div>`).join('') : '<div class="empty-state">لا توجد مؤشرات جودة حالياً</div>';
  box.innerHTML = summary + `<div class="muted" style="margin:10px 0;">وسيط الكمية المستخدمة لرصد القيم المرتفعة: ${report.medianProduction || '—'}</div><div class="alerts">${rows}</div>`;
}

// Auto-login if a key was already entered this session
window.addEventListener('load', () => {
  const saved = sessionStorage.getItem('adminKey');
  if (saved) {
    ADMIN.key = saved;
    document.getElementById('adminKeyInput').value = saved;
    loadAdminData();
  }
});
