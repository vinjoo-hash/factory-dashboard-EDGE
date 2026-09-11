/**
 * reports.js — DAILY / WEEKLY / MONTHLY tabs.
 * Reuses STATE from app.js (same fetch, same data) and Engine for every
 * calculation. This file only renders; it never recomputes business logic
 * that already exists in engine.js.
 */

let REPORTS = {
  dailyDate: null,
  weekRefDate: null,   // any date inside the currently-viewed week
  monthlyMonth: null,  // 1-12
  monthlyYear: null,
  chartsR: {},
};

function destroyChartR(id) { if (REPORTS.chartsR[id]) REPORTS.chartsR[id].destroy(); }

const WEEKDAY_ORDER = ['السبت', 'الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة'];

function arabicWeekday(dateStr) {
  const idx = (new Date(dateStr + 'T00:00:00').getDay() + 1) % 7; // Sat=0
  return WEEKDAY_ORDER[idx];
}

function fmtShortDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' });
}

function statusBadgeAr(status) { return Engine.STATUS_LABELS_AR[status] || status; }

function changePill(value, unit) {
  if (value === null || value === undefined || isNaN(value)) return `<span class="change-pill flat">—</span>`;
  const rounded = Math.round(value * 10) / 10;
  const cls = rounded > 0.5 ? 'up' : (rounded < -0.5 ? 'down' : 'flat');
  const arrow = rounded > 0.5 ? '▲' : (rounded < -0.5 ? '▼' : '—');
  return `<span class="change-pill ${cls}">${arrow} ${rounded > 0 ? '+' : ''}${rounded}${unit || ''}</span>`;
}

/** Called by app.js right after main-tab navigation. */
function onMainTabShown(name) {
  if (name === 'executive') renderExecutiveTab();
  if (name === 'daily') renderDailyTab();
  if (name === 'weekly') renderWeeklyTab();
  if (name === 'monthly') renderMonthlyTab();
}

/** Called by app.js after every successful fetch, so an open reporting tab stays live too. */
function onDataLoaded() {
  const activeBtn = document.querySelector('.main-tabs .tab-btn.active');
  const active = activeBtn ? activeBtn.dataset.maintab : 'live';
  if (active === 'executive') renderExecutiveTab();
  if (active === 'daily') renderDailyTab();
  if (active === 'weekly') renderWeeklyTab();
  if (active === 'monthly') renderMonthlyTab();
}

// ==========================================================================
// DAILY TAB
// ==========================================================================

async function renderDailyTab() {
  const input = document.getElementById('dailyDate');
  if (!input.value) input.value = STATE.serverTime ? Engine.fmtDate(STATE.serverTime) : Engine.fmtDate(new Date());
  if (!input.dataset.wired) { input.dataset.wired = '1'; input.addEventListener('change', renderDailyTab); }

  const dateStr = input.value;
  // PERFORMANCE: the routine poll only carries a recent rolling window of
  // ProductionRecords; jumping to an older date fetches just that day's
  // records on demand (no-op if it's already within the loaded window).
  await fetchRecordsRange(dateStr, dateStr);
  renderDailyTabBody(dateStr);
}

function renderDailyTabBody(dateStr) {
  const targets = getTargetsForDate(dateStr);
  const lineNames = Object.keys(targets).length ? Object.keys(targets) : Engine.getLineNamesFromData(STATE.records, STATE.lines);
  const day = Engine.computeDaySummary(STATE.records, STATE.lines, dateStr, lineNames);

  document.getElementById('dailyEmptyState').style.display = day.hasData ? 'none' : 'block';
  document.getElementById('dailyContent').style.display = day.hasData ? 'block' : 'none';
  if (!day.hasData) return;

  // KPIs
  const cards = [
    { label: 'الهدف', value: day.target },
    { label: 'الفعلي', value: day.actual },
    { label: 'المتبقي', value: day.remaining, cls: day.remaining > 0 ? 'warn' : 'positive' },
    { label: 'الإنجاز', value: Math.round(day.achievement) + '%', cls: day.achievement >= 100 ? 'positive' : (day.achievement < 70 ? 'negative' : '') },
    { label: 'النقص', value: Math.round(day.shortage) + '%', cls: day.shortage > 30 ? 'negative' : '' },
    { label: 'عادي', value: day.normal },
    { label: 'أوفر تايم', value: day.overtime },
    { label: 'الحالة', value: statusBadgeAr(day.status) },
  ];
  document.getElementById('dailyKpiGrid').innerHTML = cards.map(c => `
    <div class="kpi-card ${c.cls || ''}"><div class="label">${c.label}</div><div class="num">${c.value}</div></div>`).join('');

  // Line cards
  document.getElementById('dailyLineGrid').innerHTML = day.lineBreakdown.map(lb => {
    const pct = lb.target > 0 ? Math.min((lb.actual / lb.target) * 100, 100) : 0;
    return `
    <div class="line-card">
      <div class="head"><h3>${lb.line}</h3><span class="badge ${lb.status}">${statusBadgeAr(lb.status)}</span></div>
      <div class="line-stats">
        <div class="cell"><div class="k">الهدف</div><div class="v">${lb.target}</div></div>
        <div class="cell"><div class="k">الفعلي</div><div class="v">${lb.actual}</div></div>
        <div class="cell"><div class="k">الإنجاز</div><div class="v">${Math.round(lb.achievement)}%</div></div>
      </div>
      <div class="progress-track"><div class="progress-fill ${lb.status === 'TARGET_ACHIEVED' ? 'achieved' : (lb.status === 'BEHIND' ? 'behind' : '')}" style="width:${pct}%"></div></div>
      <div class="split-row"><span>عادي: <b>${lb.normal}</b></span><span>أوفر تايم: <b>${lb.overtime}</b></span></div>
    </div>`;
  }).join('') || '<div class="empty-state">لا توجد خطوط لهذا اليوم</div>';

  // Slot table for the day
  const dayRecords = Engine.filterByDate(STATE.records, dateStr);
  const sortedSlots = [...STATE.slotConfig].sort((a, b) => Engine.timeToMinutes(a.start) - Engine.timeToMinutes(b.start));
  document.getElementById('dailySlotTableBody').innerHTML = sortedSlots.map(s => {
    const total = lineNames.reduce((sum, l) => sum + Engine.slotTotal(dayRecords, l, s.slot), 0);
    return `<tr class="${s.type === 'OVERTIME' ? 'overtime-slot' : ''}"><td>${s.slot}</td><td>${s.start}–${s.end}</td><td>${s.type === 'OVERTIME' ? 'أوفر تايم' : 'عادي'}</td><td>${total || '-'}</td></tr>`;
  }).join('');

  // Line chart: target vs actual
  destroyChartR('dailyLine');
  REPORTS.chartsR.dailyLine = new Chart(document.getElementById('dailyLineChart'), {
    type: 'bar',
    data: { labels: lineNames, datasets: [
      { label: 'الهدف', data: lineNames.map(l => (targets[l] && targets[l].target) || 0), backgroundColor: '#2c3540' },
      { label: 'الفعلي', data: lineNames.map(l => Engine.lineTotal(dayRecords, l)), backgroundColor: '#4a90d9' },
    ] },
    options: chartBaseOptions(''),
  });

  // Worker performance for that day
  renderWorkerPerformance(dayRecords, 'dailyWorkerPerformance');
}

// ==========================================================================
// WEEKLY TAB
// ==========================================================================

function shiftWeek(deltaWeeks) {
  const base = REPORTS.weekRefDate || Engine.fmtDate(STATE.serverTime || new Date());
  REPORTS.weekRefDate = Engine.addDays(base, deltaWeeks * 7);
  renderWeeklyTab();
}

function goToCurrentWeek() {
  REPORTS.weekRefDate = Engine.fmtDate(STATE.serverTime || new Date());
  renderWeeklyTab();
}

async function renderWeeklyTab() {
  if (!REPORTS.weekRefDate) REPORTS.weekRefDate = Engine.fmtDate(STATE.serverTime || new Date());
  const weekStart = Engine.getWeekStart(REPORTS.weekRefDate);
  const weekEnd = Engine.addDays(weekStart, 6);
  const prevStart = Engine.addDays(weekStart, -7); // comparison needs the previous week too

  // PERFORMANCE: fetch the full range this view needs (previous week through
  // this week) in one go if it isn't already loaded — no-op otherwise.
  await fetchRecordsRange(prevStart, weekEnd);

  const dateList = Engine.getDateRange(weekStart, weekEnd);
  const lineNames = Engine.getLineNamesFromData(STATE.records, STATE.lines);
  const daySummaries = dateList.map(d => Engine.computeDaySummary(STATE.records, STATE.lines, d, lineNames));
  const summary = Engine.computePeriodSummary(daySummaries);

  document.getElementById('weeklyRangeLabel').textContent = `${fmtShortDate(weekStart)} — ${fmtShortDate(weekEnd)}`;

  renderPeriodKpis('weeklyKpiGrid', summary);

  // comparison to previous week
  const prevDates = Engine.getDateRange(prevStart, Engine.addDays(prevStart, 6));
  const prevSummary = Engine.computePeriodSummary(prevDates.map(d => Engine.computeDaySummary(STATE.records, STATE.lines, d, lineNames)));
  renderComparisonCard('weeklyComparisonCard', summary, prevSummary, 'الأسبوع الماضي');

  renderTrendChart('weeklyTrendChart', daySummaries, d => arabicWeekday(d.date));
  renderBestWorst('weeklyBestWorst', summary);
  renderLinePerformanceTable('weeklyLineTableBody', Engine.computeLinePeriodPerformance(daySummaries, lineNames));
  renderDaysTable('weeklyDaysTableBody', daySummaries, true);
  renderOvertimeAnalysis('weeklyOvertimeSummary', 'weeklyOvertimeTableBody', Engine.computeOvertimeAnalysis(daySummaries, lineNames));
  renderWorkerPeriodTable('weeklyWorkerPerformance', Engine.computeWorkerPeriodAnalytics(STATE.records, dateList));
  renderPeriodAlerts('weeklyAlerts', Engine.generateManagementAlerts(daySummaries, lineNames, CONFIG.ALERT_THRESHOLDS));
  renderDowntimeAnalysis('weeklyDowntimeAnalysis', Engine.computeDowntimeAnalysis(STATE.downtimeLogs, dateList));
}

// ==========================================================================
// MONTHLY TAB
// ==========================================================================

function populateMonthlySelectors() {
  const monthSelect = document.getElementById('monthlyMonth');
  const yearSelect = document.getElementById('monthlyYear');
  if (monthSelect.dataset.wired) return;
  monthSelect.dataset.wired = '1';
  const monthNames = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
  monthSelect.innerHTML = monthNames.map((m, i) => `<option value="${i + 1}">${m}</option>`).join('');
  const nowYear = (STATE.serverTime || new Date()).getFullYear();
  const years = [nowYear - 1, nowYear, nowYear + 1];
  yearSelect.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join('');
  monthSelect.addEventListener('change', () => { REPORTS.monthlyMonth = Number(monthSelect.value); renderMonthlyTab(); });
  yearSelect.addEventListener('change', () => { REPORTS.monthlyYear = Number(yearSelect.value); renderMonthlyTab(); });
}

async function renderMonthlyTab() {
  populateMonthlySelectors();
  const now = STATE.serverTime || new Date();
  if (!REPORTS.monthlyMonth) REPORTS.monthlyMonth = now.getMonth() + 1;
  if (!REPORTS.monthlyYear) REPORTS.monthlyYear = now.getFullYear();
  document.getElementById('monthlyMonth').value = REPORTS.monthlyMonth;
  document.getElementById('monthlyYear').value = REPORTS.monthlyYear;

  const { start, end } = Engine.getMonthRange(REPORTS.monthlyYear, REPORTS.monthlyMonth);
  // clamp end to today if this is the current (incomplete) month
  const todayStr = Engine.fmtDate(now);
  const effectiveEnd = end > todayStr ? todayStr : end;

  // previous month's range, computed up front so we can fetch both months in one go
  const prevMonth = REPORTS.monthlyMonth === 1 ? 12 : REPORTS.monthlyMonth - 1;
  const prevYear = REPORTS.monthlyMonth === 1 ? REPORTS.monthlyYear - 1 : REPORTS.monthlyYear;
  const prevRange = Engine.getMonthRange(prevYear, prevMonth);

  // PERFORMANCE: fetch this month + previous month's ProductionRecords in one
  // request if not already loaded — no-op if the routine poll's rolling
  // window already covers it (true for the current/recent months; an older
  // year fetches on demand exactly once, here).
  await fetchRecordsRange(prevRange.start, effectiveEnd);

  const dateList = Engine.getDateRange(start, effectiveEnd > start ? effectiveEnd : start);
  const lineNames = Engine.getLineNamesFromData(STATE.records, STATE.lines);
  const daySummaries = dateList.map(d => Engine.computeDaySummary(STATE.records, STATE.lines, d, lineNames));
  const summary = Engine.computePeriodSummary(daySummaries);

  renderPeriodKpis('monthlyKpiGrid', summary);

  // previous month comparison
  const prevDates = Engine.getDateRange(prevRange.start, prevRange.end);
  const prevSummary = Engine.computePeriodSummary(prevDates.map(d => Engine.computeDaySummary(STATE.records, STATE.lines, d, lineNames)));
  renderComparisonCard('monthlyComparisonCard', summary, prevSummary, 'الشهر الماضي');

  renderTrendChart('monthlyTrendChart', daySummaries, d => fmtShortDate(d.date));
  renderBestWorst('monthlyBestWorst', summary);

  const linePerf = Engine.computeLinePeriodPerformance(daySummaries, lineNames);
  const rankedForTable = [...linePerf].sort((a, b) => (a.rank || 999) - (b.rank || 999));
  document.getElementById('monthlyLineTableBody').innerHTML = rankedForTable.map(l => `
    <tr>
      <td>${l.rank || '-'}</td><td>${l.line}</td><td>${l.target}</td><td>${l.actual}</td>
      <td>${Math.round(l.achievement)}%</td><td>${Math.round(l.shortage)}%</td><td>${l.overtime}</td>
      <td><span class="badge ${l.status}">${statusBadgeAr(l.status)}</span></td>
    </tr>`).join('') || `<tr><td colspan="8" class="muted">لا توجد بيانات كافية</td></tr>`;

  const consistency = Engine.computeConsistency(daySummaries, lineNames);
  document.getElementById('monthlyConsistencyTableBody').innerHTML = consistency.map(c => c.insufficientData
    ? `<tr><td>${c.line}</td><td colspan="6" class="muted">لا توجد بيانات كافية</td></tr>`
    : `<tr><td>${c.line}</td><td>${Math.round(c.avg)}%</td><td>${Math.round(c.best)}%</td><td>${Math.round(c.worst)}%</td><td>${c.daysBehind}</td><td>${c.daysAchieved}</td><td>${c.otFreq}/${c.totalDays}</td></tr>`
  ).join('');

  renderOvertimeAnalysis('monthlyOvertimeSummary', 'monthlyOvertimeTableBody', Engine.computeOvertimeAnalysis(daySummaries, lineNames));

  // Top performers
  const workerPeriod = Engine.computeWorkerPeriodAnalytics(STATE.records, dateList);
  const bestLineByAchievement = [...linePerf].filter(l => l.daysWithTarget > 0).sort((a, b) => b.achievement - a.achievement)[0];
  const lowestOTLine = [...linePerf].filter(l => l.daysWithTarget > 0).sort((a, b) => a.otDays - b.otDays)[0];
  const topWorker = workerPeriod[0];
  const mostTotalWorker = [...workerPeriod].sort((a, b) => b.total - a.total)[0];

  const perfCards = [];
  if (topWorker) perfCards.push({ title: 'أعلى إنتاجية عامل (لكل فترة نشطة)', name: topWorker.worker, value: `${Math.round(topWorker.avgPerSlot)} قطعة/فترة` });
  if (mostTotalWorker) perfCards.push({ title: 'أعلى إجمالي إنتاج عامل', name: mostTotalWorker.worker, value: `${mostTotalWorker.total} قطعة` });
  if (bestLineByAchievement) perfCards.push({ title: 'أفضل خط (نسبة إنجاز)', name: bestLineByAchievement.line, value: `${Math.round(bestLineByAchievement.achievement)}%` });
  if (lowestOTLine) perfCards.push({ title: 'أقل اعتماد على الأوفر تايم', name: lowestOTLine.line, value: `${lowestOTLine.otDays} أيام أوفر تايم` });

  document.getElementById('monthlyTopPerformers').innerHTML = perfCards.length ? perfCards.map(c => `
    <div class="line-card"><div class="head"><h3 style="font-size:13px;color:var(--text-dim);">${c.title}</h3></div>
      <div style="font-size:20px;font-weight:800;">${c.name}</div><div class="muted">${c.value}</div></div>`).join('')
    : '<div class="empty-state">لا توجد بيانات كافية</div>';

  renderWorkerPeriodTable('monthlyWorkerPerformance', workerPeriod);
  renderPeriodAlerts('monthlyAlerts', Engine.generateManagementAlerts(daySummaries, lineNames, CONFIG.ALERT_THRESHOLDS));
  renderDowntimeAnalysis('monthlyDowntimeAnalysis', Engine.computeDowntimeAnalysis(STATE.downtimeLogs, dateList));
}

// ==========================================================================
// SHARED RENDER HELPERS (used by both Weekly and Monthly)
// ==========================================================================

function renderPeriodKpis(containerId, summary) {
  if (summary.workingDaysCount === 0) {
    document.getElementById(containerId).innerHTML = `<div class="empty-state" style="grid-column:1/-1;">لا توجد بيانات كافية لهذه الفترة</div>`;
    return;
  }
  const cards = [
    { label: 'إجمالي الهدف', value: summary.totalTarget.toLocaleString('en-US') },
    { label: 'إجمالي الإنتاج', value: summary.totalActual.toLocaleString('en-US') },
    { label: 'المتبقي', value: summary.remaining.toLocaleString('en-US'), cls: summary.remaining > 0 ? 'warn' : 'positive' },
    { label: 'نسبة الإنجاز', value: Math.round(summary.achievement) + '%', cls: summary.achievement >= 100 ? 'positive' : (summary.achievement < 80 ? 'negative' : '') },
    { label: 'إجمالي النقص', value: Math.round(summary.shortage) + '%' },
    { label: 'إنتاج الأوفر تايم', value: summary.totalOvertime.toLocaleString('en-US') },
    { label: 'متوسط الإنتاج اليومي', value: Math.round(summary.avgDailyProduction).toLocaleString('en-US') },
    { label: 'متوسط الإنجاز اليومي', value: Math.round(summary.avgDailyAchievement) + '%' },
    { label: 'عدد أيام العمل', value: summary.workingDaysCount },
    { label: 'أيام تحقق الهدف', value: summary.daysAchieved, cls: 'positive' },
    { label: 'أيام بها نقص', value: summary.daysBehind, cls: summary.daysBehind > 0 ? 'negative' : '' },
  ];
  document.getElementById(containerId).innerHTML = cards.map(c => `
    <div class="kpi-card ${c.cls || ''}"><div class="label">${c.label}</div><div class="num">${c.value}</div></div>`).join('');
}

function renderComparisonCard(containerId, summary, prevSummary, prevLabel) {
  const box = document.getElementById(containerId);
  if (summary.workingDaysCount === 0) { box.innerHTML = ''; return; }
  const cmp = Engine.comparePeriods(summary, prevSummary);
  if (cmp.insufficientData) {
    box.innerHTML = `<div class="muted">لا توجد بيانات كافية للمقارنة مع ${prevLabel}</div>`;
    return;
  }
  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
      <b>مقارنة مع ${prevLabel}</b>
      <div style="display:flex;gap:14px;flex-wrap:wrap;">
        <span>الإنتاج ${changePill(cmp.productionChangePct, '%')}</span>
        <span>الإنجاز ${changePill(cmp.achievementChangePct, ' نقطة')}</span>
        <span>الأوفر تايم ${changePill(cmp.overtimeChangePct, '%')}</span>
      </div>
    </div>`;
}

function renderTrendChart(canvasId, daySummaries, labelFn) {
  destroyChartR(canvasId);
  const hasAny = daySummaries.some(d => d.hasData);
  const canvas = document.getElementById(canvasId);
  if (!hasAny) {
    canvas.parentElement.querySelector('.empty-state-trend')?.remove();
    const note = document.createElement('div');
    note.className = 'empty-state empty-state-trend';
    note.textContent = 'لا توجد بيانات كافية';
    canvas.style.display = 'none';
    canvas.parentElement.appendChild(note);
    return;
  }
  canvas.style.display = '';
  canvas.parentElement.querySelector('.empty-state-trend')?.remove();
  REPORTS.chartsR[canvasId] = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: daySummaries.map(labelFn),
      datasets: [
        { label: 'الهدف', data: daySummaries.map(d => d.target), backgroundColor: '#2c3540' },
        { label: 'الفعلي', data: daySummaries.map(d => d.actual), backgroundColor: daySummaries.map(d => d.status === 'BEHIND' ? '#e5484d' : '#4a90d9') },
      ],
    },
    options: chartBaseOptions(''),
  });
}

function renderBestWorst(containerId, summary) {
  const box = document.getElementById(containerId);
  if (!summary.bestDay || !summary.worstDay) { box.innerHTML = '<div class="empty-state">لا توجد بيانات كافية</div>'; return; }
  const dayCard = (label, day) => `
    <div class="line-card">
      <div class="head"><h3 style="font-size:14px;color:var(--text-dim);">${label}</h3><span class="badge ${day.status}">${statusBadgeAr(day.status)}</span></div>
      <div style="font-size:20px;font-weight:800;">${fmtShortDate(day.date)} (${arabicWeekday(day.date)})</div>
      <div class="muted">الإنجاز: ${Math.round(day.achievement)}% — الفعلي ${day.actual} من ${day.target}</div>
    </div>`;
  box.innerHTML = dayCard('أفضل يوم', summary.bestDay) + dayCard('أضعف يوم', summary.worstDay);
}

function renderLinePerformanceTable(tbodyId, linePerf) {
  document.getElementById(tbodyId).innerHTML = linePerf.map(l => l.daysWithTarget === 0
    ? `<tr><td>${l.line}</td><td colspan="7" class="muted">لا توجد بيانات كافية</td></tr>`
    : `<tr>
        <td>${l.line}</td><td>${l.target}</td><td>${l.actual}</td><td>${Engine.computeRemaining(l.target, l.actual)}</td>
        <td>${Math.round(l.achievement)}%</td><td>${Math.round(l.shortage)}%</td><td>${l.overtime}</td>
        <td><span class="badge ${l.status}">${statusBadgeAr(l.status)}</span></td>
      </tr>`
  ).join('');
}

function renderDaysTable(tbodyId, daySummaries, clickable) {
  document.getElementById(tbodyId).innerHTML = daySummaries.map(d => {
    const label = `${fmtShortDate(d.date)} (${arabicWeekday(d.date)})`;
    const rowAttr = clickable ? ` style="cursor:pointer" onclick="goToDailyFromReport('${d.date}')"` : '';
    return `<tr${rowAttr}>
      <td>${label}</td><td>${d.target || '-'}</td><td>${d.actual || (d.hasData ? 0 : '-')}</td>
      <td>${d.target > 0 ? Math.round(d.achievement) + '%' : '-'}</td>
      <td>${d.target > 0 ? Math.round(d.shortage) + '%' : '-'}</td><td>${d.overtime || '-'}</td>
      <td><span class="badge ${d.status}">${statusBadgeAr(d.status)}</span></td>
    </tr>`;
  }).join('');
}

function goToDailyFromReport(dateStr) {
  document.getElementById('dailyDate').value = dateStr;
  switchMainTab('daily');
  renderDailyTab();
}

function renderOvertimeAnalysis(summaryId, tbodyId, ot) {
  const box = document.getElementById(summaryId);
  if (ot.totalWorkingDays === 0) { box.innerHTML = '<div class="empty-state">لا توجد بيانات كافية</div>'; document.getElementById(tbodyId).innerHTML = ''; return; }
  box.innerHTML = `
    <div class="line-stats">
      <div class="cell"><div class="k">إجمالي الأوفر تايم</div><div class="v">${ot.totalOvertime}</div></div>
      <div class="cell"><div class="k">أيام استخدم فيها الأوفر تايم</div><div class="v">${ot.daysWithOT}</div></div>
      <div class="cell"><div class="k">متوسط الأوفر تايم/يوم</div><div class="v">${Math.round(ot.avgOTPerDay)}</div></div>
      <div class="cell"><div class="k">نسبة الأوفر تايم من الإجمالي</div><div class="v">${Math.round(ot.otShareOfTotal)}%</div></div>
    </div>`;
  document.getElementById(tbodyId).innerHTML = ot.perLine.map(l => l.daysWithTarget === 0
    ? `<tr><td>${l.line}</td><td colspan="5" class="muted">لا توجد بيانات كافية</td></tr>`
    : `<tr><td>${l.line}</td><td>${l.normalTotal}</td><td>${l.otTotal}</td><td>${l.otDays}</td><td>${l.recoveredDays}</td><td>${l.insufficientDays}</td></tr>`
  ).join('');
}

function renderWorkerPeriodTable(containerId, workerPeriod) {
  const box = document.getElementById(containerId);
  if (!workerPeriod.length) { box.innerHTML = '<div class="empty-state">لا يوجد إنتاج مسجل في هذه الفترة</div>'; return; }
  box.innerHTML = workerPeriod.map((w, i) => {
    const rankCls = i === 0 ? 'r1' : (i === 1 ? 'r2' : (i === 2 ? 'r3' : 'rn'));
    return `
    <div class="worker-row">
      <div><span class="rank-badge ${rankCls}">${i + 1}</span><span class="name">${w.worker}</span>
        <div class="lines">${w.lines.join('، ')} — ${w.activeSlots} فترة نشطة</div></div>
      <div style="text-align:left;"><div class="total">${Math.round(w.avgPerSlot)}</div><div class="muted" style="font-size:10.5px;">قطعة/فترة (إجمالي ${w.total})</div></div>
    </div>`;
  }).join('');
}

function renderPeriodAlerts(containerId, alerts) {
  const box = document.getElementById(containerId);
  if (!alerts.length) { box.innerHTML = '<div class="empty-state">لا توجد تنبيهات لهذه الفترة</div>'; return; }
  const clsMap = { warning: 'behind', overtime: 'overtime', achieved: 'achieved' };
  box.innerHTML = alerts.map(a => `<div class="alert ${clsMap[a.type] || 'catchup'}">${a.text}</div>`).join('');
}

function renderDowntimeAnalysis(containerId, analysis) {
  const box = document.getElementById(containerId);
  if (!analysis.totalLogs) { box.innerHTML = '<div class="empty-state">لا توجد أسباب توقف مسجلة لهذه الفترة</div>'; return; }
  const reasons = analysis.byReason.map(r => `<tr><td>${r.name}</td><td>${r.count}</td><td>${Math.round(r.pct)}%</td></tr>`).join('');
  const lines = analysis.byLine.map(r => `${r.name}: ${r.count}`).join(' — ');
  box.innerHTML = `<div class="line-stats"><div class="cell"><div class="k">إجمالي الحالات المسجلة</div><div class="v">${analysis.totalLogs}</div></div><div class="cell"><div class="k">الحالات حسب الخط</div><div class="v" style="font-size:13px;">${lines}</div></div></div><div class="table-wrap" style="margin-top:12px;"><table><thead><tr><th>السبب</th><th>عدد الحالات</th><th>النسبة من الحالات المسجلة</th></tr></thead><tbody>${reasons}</tbody></table></div><div class="muted" style="margin-top:8px;">النسب تخص أسباب التوقف المسجلة فقط، ولا تساوي بالضرورة نسبة العجز في القطع.</div>`;
}
