/**
 * app.js — Public dashboard. READ ONLY. No write calls ever happen here.
 */

let STATE = { records: [], lines: [], workers: [], allWorkers: [], slotConfig: [], downtimeLogs: [], serverTime: null, lastFetch: null };
let charts = {};

const AR_MONTHS_WEEKDAY = { hour12: true };

async function fetchData() {
  try {
    const res = await fetch(`${CONFIG.API_URL}?action=getData`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'خطأ غير معروف');
    STATE.records = data.records;
    STATE.lines = data.lines;
    STATE.workers = data.workers;
    STATE.allWorkers = data.allWorkers || data.workers;
    STATE.downtimeLogs = data.downtimeLogs || [];
    STATE.slotConfig = data.slotConfig.map(s => ({ ...s, slot: String(s.slot) }));
    STATE.serverTime = new Date(data.serverTime);
    STATE.lastFetch = new Date();
    render();
    if (typeof onDataLoaded === 'function') onDataLoaded(); // hook for reports.js (daily/weekly/monthly tabs)
  } catch (err) {
    document.getElementById('statusPill').textContent = 'تعذر الاتصال بالخادم';
    console.error(err);
  }
}

function todayStr(now) { return Engine.fmtDate(now); }

function getLineNames() {
  const names = new Set();
  STATE.lines.forEach(l => names.add(l.line));
  STATE.records.forEach(r => names.add(r.line));
  return [...names].sort();
}

function getTargetsForDate(dateStr) {
  const map = {};
  STATE.lines.filter(l => l.date === dateStr).forEach(l => { map[l.line] = l; });
  return map;
}

function render() {
  const now = STATE.serverTime || new Date();
  const dateStr = todayStr(now);
  const todayRecords = Engine.filterByDate(STATE.records, dateStr);
  const targets = getTargetsForDate(dateStr);
  const lineNames = Object.keys(targets).length ? Object.keys(targets) : getLineNames();
  const statusInfo = Engine.getStatus(STATE.slotConfig, now);

  renderHeader(now, statusInfo);
  renderKPIs(todayRecords, targets, lineNames, now, statusInfo);
  renderFactoryStatus(todayRecords, targets, lineNames, now);
  renderAlerts(todayRecords, targets, lineNames, now);
  renderLineCards(todayRecords, targets, lineNames, now, statusInfo);
  renderOvertimeSection(todayRecords, targets, lineNames, now, statusInfo);
  renderSlotTable(todayRecords, lineNames, now, statusInfo);
  renderCumulativeChart(todayRecords, targets, lineNames, now);
  renderLineCompareChart(todayRecords, targets, lineNames);
  renderHourlyChart(todayRecords, lineNames, now);
  renderWorkerPerformance(todayRecords);
}

function renderHeader(now, statusInfo) {
  document.getElementById('todayDate').textContent = now.toLocaleDateString('ar-EG', { year: 'numeric', month: 'long', day: 'numeric' });
  document.getElementById('nowTime').textContent = Engine.fmtTime(now);
  document.getElementById('lastUpdate').textContent = STATE.lastFetch ? Engine.fmtTime(STATE.lastFetch) : '--';

  const pill = document.getElementById('statusPill');
  const dot = document.getElementById('statusDot');
  const map = {
    NOT_STARTED: ['ended', ''], NORMAL_WORK: ['working', 'green'], BREAK: ['break', 'blue'],
    OVERTIME: ['overtime', 'overtime'], OVERTIME_BREAK: ['overtime', 'overtime'], SHIFT_ENDED: ['ended', ''],
  };
  const [cls] = map[statusInfo.status] || ['working', ''];
  pill.className = 'status-pill ' + cls;
  pill.textContent = 'الحالة: ' + Engine.STATUS_LABELS_AR[statusInfo.status] + (statusInfo.slot ? ` (فترة ${statusInfo.slot})` : '');
  dot.className = 'dot' + (statusInfo.status.includes('OVERTIME') ? ' overtime' : '');

  const staleBox = document.getElementById('staleWarning');
  if (STATE.lastFetch) {
    const minsSinceFetch = (now - STATE.lastFetch) / 60000;
    staleBox.style.display = minsSinceFetch > CONFIG.STALE_WARNING_MINUTES ? 'block' : 'none';
  }
}

function totalsFor(records, targets, lineNames) {
  let target = 0, actual = 0, expected = 0;
  lineNames.forEach(line => {
    const t = (targets[line] && targets[line].target) || 0;
    target += t;
    actual += Engine.lineTotal(records, line);
    expected += Engine.computeExpected(STATE.slotConfig, STATE.serverTime, t, CONFIG.EXPECTED_GRACE_MINUTES);
  });
  return { target, actual, expected };
}

/**
 * Single source of per-line LIVE figures — used by renderLineCards(), the
 * live alerts, AND the Executive tab (executive.js), so "best line" / "line
 * requiring attention" / smart alerts all agree with what the line cards show.
 */
function computeLiveLineData(records, targets, lineNames, now) {
  return lineNames.map(line => {
    const target = (targets[line] && targets[line].target) || 0;
    const normal = Engine.lineTotal(records, line, 'NORMAL');
    const overtime = Engine.lineTotal(records, line, 'OVERTIME');
    const actual = normal + overtime;
    const expected = Engine.computeExpected(STATE.slotConfig, now, target, CONFIG.EXPECTED_GRACE_MINUTES);
    const achievement = Engine.computeAchievement(actual, target);
    const badge = Engine.lineStatusBadge(actual, expected, target);
    const activeWorkers = new Set(records.filter(r => r.line === line).map(r => r.worker)).size;
    return { line, target, normal, overtime, actual, expected, achievement, badge, activeWorkers, diff: actual - expected };
  });
}

function renderKPIs(records, targets, lineNames, now) {
  const { target, actual, expected } = totalsFor(records, targets, lineNames);
  const remaining = Engine.computeRemaining(target, actual);
  const achievement = Engine.computeAchievement(actual, target);
  const shortage = Engine.computeShortage(achievement);
  const diff = actual - expected;

  const currentSlot = Engine.getStatus(STATE.slotConfig, now).slot;
  const currentSlotProd = currentSlot ? lineNames.reduce((s, l) => s + Engine.slotTotal(records, l, currentSlot), 0) : 0;

  const cards = [
    { label: 'الهدف الكلي', value: target.toLocaleString('en-US') },
    { label: 'الإنتاج الفعلي', value: actual.toLocaleString('en-US') },
    { label: 'المتبقي', value: remaining.toLocaleString('en-US'), cls: remaining > 0 ? 'warn' : 'positive' },
    { label: 'نسبة الإنجاز', value: Math.round(achievement) + '%', cls: achievement >= 100 ? 'positive' : (achievement < 70 ? 'negative' : '') },
    { label: 'نسبة النقص', value: Math.round(shortage) + '%', cls: shortage > 30 ? 'negative' : '' },
    { label: 'إنتاج الفترة الحالية', value: currentSlotProd.toLocaleString('en-US'), sub: currentSlot ? `فترة ${currentSlot}` : '—' },
    { label: 'المتوقع حتى الآن', value: Math.round(expected).toLocaleString('en-US') },
    { label: 'الفارق', value: (diff >= 0 ? '+' : '') + Math.round(diff).toLocaleString('en-US'), cls: diff >= 0 ? 'positive' : 'negative' },
  ];

  document.getElementById('kpiGrid').innerHTML = cards.map(c => `
    <div class="kpi-card ${c.cls || ''}">
      <div class="label">${c.label}</div>
      <div class="num">${c.value}</div>
      ${c.sub ? `<div class="sub">${c.sub}</div>` : ''}
    </div>`).join('');
}

function renderFactoryStatus(records, targets, lineNames, now) {
  const { target, actual, expected } = totalsFor(records, targets, lineNames);
  const diff = Math.round(actual - expected);
  let msg, cls;
  if (Math.abs(diff) <= expected * 0.03 || expected === 0) { msg = 'المصنع يعمل وفق الجدول المخطط'; cls = 'ON_TRACK'; }
  else if (diff > 0) { msg = `المصنع متقدم عن المتوقع بمقدار ${diff} قطعة`; cls = 'AHEAD'; }
  else { msg = `إنتاج المصنع متأخر عن المتوقع بمقدار ${Math.abs(diff)} قطعة`; cls = 'BEHIND'; }
  if (actual >= target && target > 0) { msg = 'تم تحقيق الهدف الكلي لليوم ✓'; cls = 'TARGET_ACHIEVED'; }

  document.getElementById('factoryStatusCard').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <div><b>الحالة العامة للمصنع</b><div class="muted" style="margin-top:4px;">${msg}</div></div>
      <span class="badge ${cls}">${Engine.STATUS_LABELS_AR[cls]}</span>
    </div>`;
}

function renderAlerts(records, targets, lineNames, now) {
  const statusInfo = Engine.getStatus(STATE.slotConfig, now);
  const lineData = computeLiveLineData(records, targets, lineNames, now);

  const { target, actual } = totalsFor(records, targets, lineNames);
  const forecast = Engine.forecastProduction(
    target, actual,
    Engine.elapsedActiveMinutes(STATE.slotConfig, now),
    Engine.remainingWorkMinutes(STATE.slotConfig, now),
    { minMinutesForForecast: CONFIG.MIN_MINUTES_FOR_FORECAST, forecastClosePct: CONFIG.FORECAST_CLOSE_PCT }
  );
  const staleMinutes = STATE.lastFetch ? (now - STATE.lastFetch) / 60000 : null;

  const alerts = Engine.generateLiveAlerts({
    lineData, forecast, isOvertimeNow: statusInfo.status.startsWith('OVERTIME'),
    staleMinutes, staleThresholdMinutes: CONFIG.STALE_WARNING_MINUTES,
  });

  const severityClass = { CRITICAL: 'behind', WARNING: 'overtime', SUCCESS: 'achieved', INFO: 'catchup' };
  const box = document.getElementById('alertsList');
  document.getElementById('alertsSection').style.display = alerts.length ? '' : 'none';
  box.innerHTML = alerts.map(a => `<div class="alert ${severityClass[a.severity] || 'catchup'}">${a.text}</div>`).join('');
}

function renderLineCards(records, targets, lineNames, now, statusInfo) {
  const grid = document.getElementById('lineGrid');
  const lineData = computeLiveLineData(records, targets, lineNames, now);
  const isOT = statusInfo.status.startsWith('OVERTIME');

  grid.innerHTML = lineData.map(lb => {
    const remaining = Engine.computeRemaining(lb.target, lb.actual);
    const shortage = Engine.computeShortage(lb.achievement);
    const diff = Math.round(lb.diff);
    const pct = lb.target > 0 ? Math.min((lb.actual / lb.target) * 100, 100) : 0;

    return `
    <div class="line-card">
      <div class="head">
        <h3>${lb.line}</h3>
        <span class="badge ${lb.badge}">${Engine.STATUS_LABELS_AR[lb.badge]}</span>
      </div>
      <div class="line-stats">
        <div class="cell"><div class="k">الهدف</div><div class="v">${lb.target}</div></div>
        <div class="cell"><div class="k">الفعلي</div><div class="v">${lb.actual}</div></div>
        <div class="cell"><div class="k">المتبقي</div><div class="v">${remaining}</div></div>
        <div class="cell"><div class="k">الإنجاز</div><div class="v">${Math.round(lb.achievement)}%</div></div>
        <div class="cell"><div class="k">النقص</div><div class="v">${Math.round(shortage)}%</div></div>
        <div class="cell"><div class="k">الفارق</div><div class="v ${diff < 0 ? 'neg' : 'pos'}">${diff >= 0 ? '+' : ''}${diff}</div></div>
      </div>
      <div class="progress-track">
        <div class="progress-fill ${lb.badge === 'TARGET_ACHIEVED' ? 'achieved' : (lb.badge === 'BEHIND' ? 'behind' : '')} ${isOT ? 'overtime-stripe' : ''}" style="width:${pct}%"></div>
      </div>
      <div class="split-row">
        <span>عادي: <b>${lb.normal}</b></span>
        <span>أوفر تايم: <b>${lb.overtime}</b></span>
        <span>العمال: <b>${lb.activeWorkers}</b></span>
      </div>
    </div>`;
  }).join('');
}

function renderOvertimeSection(records, targets, lineNames, now, statusInfo) {
  const box = document.getElementById('overtimeSection');
  if (!statusInfo.status.startsWith('OVERTIME') && statusInfo.status !== 'SHIFT_ENDED') {
    box.innerHTML = `<div class="card muted">الأوفر تايم يبدأ الساعة ${STATE.slotConfig.find(s=>s.type==='OVERTIME')?.start || '03:00 م'} — سيظهر هنا تفصيل عند بدايته.</div>`;
    return;
  }
  box.innerHTML = lineNames.map(line => {
    const target = (targets[line] && targets[line].target) || 0;
    if (!target) return '';
    const actualNormal = Engine.lineTotal(records, line, 'NORMAL');
    const actualOT = Engine.lineTotal(records, line, 'OVERTIME');
    const m = Engine.computeOvertimeMetrics(target, actualNormal, actualOT);
    const est = Engine.estimateCompletion(STATE.slotConfig, now, m.remainingNow, actualOT);

    let etaText;
    if (m.remainingNow <= 0) etaText = m.exceeded > 0 ? `تم تجاوز الهدف بمقدار ${m.exceeded} قطعة ✓` : 'تم تحقيق الهدف ✓';
    else if (est.insufficientData) etaText = 'بيانات غير كافية بعد لتقدير وقت الإنجاز';
    else etaText = est.achievable
      ? `الوقت المتوقع لإنجاز الهدف: ${Engine.fmtTime(est.eta)}`
      : `بمعدل الإنتاج الحالي، قد لا يتم إنجاز الهدف قبل انتهاء الأوفر تايم`;

    return `
    <div class="card">
      <div style="display:flex;justify-content:space-between;"><b>${line}</b><span class="muted">${m.remainingNow<=0?'مكتمل':`متبقي ${m.remainingNow}`}</span></div>
      <div class="line-stats" style="margin-top:8px;">
        <div class="cell"><div class="k">إنتاج الأوفر تايم</div><div class="v">${actualOT}</div></div>
        <div class="cell"><div class="k">المطلوب لإتمام الهدف</div><div class="v">${m.remainingAtOTStart}</div></div>
        <div class="cell"><div class="k">تقدم الأوفر تايم</div><div class="v">${Math.round(m.otProgressPct)}%</div></div>
      </div>
      <div class="progress-track"><div class="progress-fill overtime-stripe" style="width:${Math.min(m.otProgressPct,100)}%"></div></div>
      <div class="muted" style="margin-top:8px;">${etaText}</div>
    </div>`;
  }).join('');
}

function renderSlotTable(records, lineNames, now, statusInfo) {
  document.getElementById('slotTableHeadRow').innerHTML =
    `<th>الفترة</th><th>الوقت</th><th>الحالة</th><th>متوقع</th>` +
    lineNames.map(l => `<th>${l}</th>`).join('') +
    `<th>الإجمالي</th><th>الفارق</th>`;
  const sorted = [...STATE.slotConfig].sort((a, b) => Engine.timeToMinutes(a.start) - Engine.timeToMinutes(b.start));
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const todayStr = Engine.fmtDate(now);

  const rows = [];
  sorted.forEach((s, i) => {
    const perLine = lineNames.map(l => Engine.slotTotal(records, l, s.slot));
    const total = perLine.reduce((a, b) => a + b, 0);
    // rough per-slot expected: even split of normal/OT target across slots of same type — informational only
    const isCurrent = String(s.slot) === String(statusInfo.slot);
    const isPast = Engine.timeToMinutes(s.end) <= nowMin;
    const rowClass = isCurrent ? 'current-slot' : (isPast ? 'past-slot' : '');
    // Effective type accounts for the Friday-is-overtime rule, not just SlotConfig.
    const isOT = Engine.getEffectiveSlotType(STATE.slotConfig, todayStr, s.slot) === 'OVERTIME';
    const typeClass = isOT ? ' overtime-slot' : '';
    rows.push(`
      <tr class="${rowClass}${typeClass}">
        <td>${s.slot}</td><td>${s.start}–${s.end}</td>
        <td>${isOT ? 'أوفر تايم' : 'عادي'}</td>
        <td>—</td>
        ${perLine.map(v => `<td>${v || '-'}</td>`).join('')}
        <td><b>${total || '-'}</b></td>
        <td>—</td>
      </tr>`);
    // insert a break row if there's a gap to the next slot
    const next = sorted[i + 1];
    if (next && Engine.timeToMinutes(s.end) < Engine.timeToMinutes(next.start)) {
      rows.push(`<tr class="break-row"><td colspan="${4 + lineNames.length + 2}">راحة ${s.end}–${next.start}</td></tr>`);
    }
  });
  document.getElementById('slotTableBody').innerHTML = rows.join('');
}

function destroyChart(id) { if (charts[id]) { charts[id].destroy(); } }

function renderCumulativeChart(records, targets, lineNames, now) {
  const sorted = [...STATE.slotConfig].sort((a, b) => Engine.timeToMinutes(a.start) - Engine.timeToMinutes(b.start));
  const totalTarget = lineNames.reduce((s, l) => s + ((targets[l] && targets[l].target) || 0), 0);
  const totalNormalMin = Engine.totalMinutesOfType(STATE.slotConfig, 'NORMAL');
  const todayStr = Engine.fmtDate(now);

  let cumActual = 0;
  const labels = [], expectedData = [], actualData = [];

  sorted.forEach(s => {
    labels.push(s.slot);
    const slotSum = lineNames.reduce((sum, l) => sum + Engine.slotTotal(records, l, s.slot), 0);
    cumActual += slotSum;
    actualData.push(cumActual);
    // expected at the END of this slot — Friday-is-overtime override applies
    // here too: on a Friday, every slot behaves like OVERTIME (expected
    // frozen at 100% of target), matching Engine.computeExpected's own rule.
    const fakeNow = new Date(now); fakeNow.setHours(0, Engine.timeToMinutes(s.end), 0, 0);
    const effectiveType = Engine.getEffectiveSlotType(STATE.slotConfig, todayStr, s.slot);
    let expected;
    if (effectiveType === 'NORMAL') {
      const elapsed = Engine.elapsedMinutesOfType(STATE.slotConfig, fakeNow, 'NORMAL');
      expected = totalTarget * (totalNormalMin > 0 ? elapsed / totalNormalMin : 0);
    } else {
      expected = totalTarget;
    }
    expectedData.push(Math.round(expected));
  });

  destroyChart('cumulative');
  charts.cumulative = new Chart(document.getElementById('cumulativeChart'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'متوقع', data: expectedData, borderColor: '#4a90d9', borderDash: [6, 4], tension: 0.2, pointRadius: 0 },
        { label: 'فعلي', data: actualData, borderColor: '#2fb17a', backgroundColor: 'rgba(47,177,122,0.15)', fill: true, tension: 0.2, pointRadius: 2 },
      ],
    },
    options: chartBaseOptions('فترة الإنتاج'),
  });
}

function renderLineCompareChart(records, targets, lineNames) {
  destroyChart('lineCompare');
  charts.lineCompare = new Chart(document.getElementById('lineCompareChart'), {
    type: 'bar',
    data: {
      labels: lineNames,
      datasets: [
        { label: 'الهدف', data: lineNames.map(l => (targets[l] && targets[l].target) || 0), backgroundColor: '#2c3540' },
        { label: 'الفعلي', data: lineNames.map(l => Engine.lineTotal(records, l)), backgroundColor: '#4a90d9' },
      ],
    },
    options: chartBaseOptions(''),
  });
}

function renderHourlyChart(records, lineNames, now) {
  const sorted = [...STATE.slotConfig].sort((a, b) => Engine.timeToMinutes(a.start) - Engine.timeToMinutes(b.start));
  const todayStr = Engine.fmtDate(now);
  const labels = sorted.map(s => s.slot);
  const actual = sorted.map(s => lineNames.reduce((sum, l) => sum + Engine.slotTotal(records, l, s.slot), 0));
  destroyChart('hourly');
  charts.hourly = new Chart(document.getElementById('hourlyChart'), {
    type: 'bar',
    data: { labels, datasets: [{ label: 'إنتاج الفترة', data: actual, backgroundColor: sorted.map(s => Engine.getEffectiveSlotType(STATE.slotConfig, todayStr, s.slot) === 'OVERTIME' ? '#f0a93a' : '#4a90d9') }] },
    options: chartBaseOptions('فترة الإنتاج'),
  });
}

function chartBaseOptions(xTitle) {
  return {
    responsive: true,
    plugins: { legend: { labels: { color: '#edeff2' } } },
    scales: {
      x: { ticks: { color: '#8a96a3' }, grid: { color: '#2c3540' }, title: { display: !!xTitle, text: xTitle, color: '#8a96a3' } },
      y: { ticks: { color: '#8a96a3' }, grid: { color: '#2c3540' }, beginAtZero: true },
    },
  };
}

function renderWorkerPerformance(records, containerId) {
  const workers = [...new Set(records.map(r => r.worker))];
  const rows = workers.map(w => ({
    name: w,
    total: Engine.workerTotal(records, w),
    lines: Engine.workerLines(records, w),
  })).sort((a, b) => b.total - a.total);

  const box = document.getElementById(containerId || 'workerPerformance');
  if (!rows.length) { box.innerHTML = '<div class="empty-state">لا يوجد إنتاج مسجل اليوم بعد</div>'; return; }
  box.innerHTML = rows.map((r, i) => `
    <div class="worker-row">
      <div><span class="rank">${i + 1}</span><span class="name">${r.name}</span><div class="lines">${r.lines.join('، ')}</div></div>
      <div class="total">${r.total}</div>
    </div>`).join('');
}

/**
 * Top-level LIVE / DAILY / WEEKLY / MONTHLY navigation (Req #1, #24).
 * The LIVE tab's own render() above is untouched; this only shows/hides panels
 * and, the first time a reporting tab is opened, asks reports.js to draw it.
 */
function switchMainTab(name) {
  document.querySelectorAll('.main-tabs .tab-btn').forEach(b => b.classList.toggle('active', b.dataset.maintab === name));
  document.querySelectorAll('.maintab-panel').forEach(p => p.style.display = 'none');
  document.getElementById('maintab-' + name).style.display = 'block';
  if (typeof onMainTabShown === 'function') onMainTabShown(name);
}

fetchData();
setInterval(fetchData, CONFIG.REFRESH_INTERVAL_MS);
// Lightweight per-second clock tick (does not touch charts/tables to avoid flicker)
setInterval(() => {
  if (!STATE.serverTime) return;
  STATE.serverTime = new Date(STATE.serverTime.getTime() + 1000);
  document.getElementById('nowTime').textContent = Engine.fmtTime(STATE.serverTime);
}, 1000);
