/**
 * admin.js — Admin panel. Every write goes through saveXxx() -> POST with adminKey.
 * Nothing here duplicates schedule/calculation logic — that all lives in engine.js.
 */

let ADMIN = { key: '', slotConfig: [], workers: [], allWorkers: [], lines: [], records: [], downtimeLogs: [] };
let rowCounter = 0;

function toast(msg, isError) {
  const host = document.getElementById('toastHost');
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), 2600);
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
  const rows = [...document.querySelectorAll('.entry-row')];
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
    const res = await fetch(CONFIG.API_URL, {
      method: 'POST',
      body: JSON.stringify({ action: 'saveProduction', adminKey: ADMIN.key, entries }),
    });
    const data = await res.json();
    if (data.error === 'SERVER_BUSY_TRY_AGAIN') { toast('الخادم مشغول بحفظ سابق، حاول مرة أخرى بعد ثانية', true); return; }
    if (!data.ok) throw new Error(data.error);
    toast('تم حفظ الإنتاج بنجاح ✓');
    loadAdminData();
  } catch (err) {
    toast('فشل الحفظ: ' + err.message, true);
  } finally {
    SAVE_IN_PROGRESS = false;
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'حفظ الإنتاج'; }
  }
}

async function saveDowntimeReason() {
  const date = document.getElementById('entryDate').value;
  const slot = document.getElementById('entrySlot').value;
  const line = document.getElementById('downtimeLine').value;
  const reason = document.getElementById('downtimeReason').value;
  const notes = document.getElementById('downtimeNotes').value.trim();
  if (!date || !slot || !line || !reason) { toast('اختر الخط والسبب قبل الحفظ', true); return; }
  try {
    const res = await fetch(CONFIG.API_URL, { method: 'POST', body: JSON.stringify({ action: 'saveDowntimeReason', adminKey: ADMIN.key, date, slot, line, reason, notes }) });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    toast('تم حفظ سبب التوقف');
    document.getElementById('downtimeReason').value = '';
    document.getElementById('downtimeNotes').value = '';
    loadAdminData();
  } catch (err) { toast('فشل حفظ السبب: ' + err.message, true); }
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
  try {
    const res = await fetch(CONFIG.API_URL, { method: 'POST', body: JSON.stringify({ action: 'saveWorker', adminKey: ADMIN.key, name, active: true }) });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    document.getElementById('newWorkerName').value = '';
    toast('تمت إضافة العامل');
    loadAdminData();
  } catch (err) { toast('فشل: ' + err.message, true); }
}

async function removeWorker(id) {
  const w = ADMIN.workers.find(x => x.id === id);
  try {
    const res = await fetch(CONFIG.API_URL, { method: 'POST', body: JSON.stringify({ action: 'saveWorker', adminKey: ADMIN.key, id, name: w.name, active: false }) });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    toast('تمت إزالة العامل');
    loadAdminData();
  } catch (err) { toast('فشل: ' + err.message, true); }
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
  try {
    const res = await fetch(CONFIG.API_URL, { method: 'POST', body: JSON.stringify({ action: 'setTarget', adminKey: ADMIN.key, date, line, target, plannedHours, hourlyTarget }) });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    toast('تم حفظ الهدف');
    loadAdminData();
  } catch (err) { toast('فشل: ' + err.message, true); }
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
