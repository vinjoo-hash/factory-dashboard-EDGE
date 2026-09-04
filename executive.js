/**
 * executive.js — "تنفيذي" tab: a ~30-second factory summary for management.
 * Deliberately does ZERO new math: every number here is produced by
 * engine.js / app.js functions the other tabs already use and trust.
 */

function renderExecutiveTab() {
  const now = STATE.serverTime || new Date();
  const todayStr = Engine.fmtDate(now);

  // ---- Today (reuses the exact same figures the Live tab shows) ----
  const todayRecords = Engine.filterByDate(STATE.records, todayStr);
  const todayTargets = getTargetsForDate(todayStr);
  const todayLineNames = Object.keys(todayTargets).length ? Object.keys(todayTargets) : Engine.getLineNamesFromData(STATE.records, STATE.lines);
  const lineData = computeLiveLineData(todayRecords, todayTargets, todayLineNames, now);
  const { target: todayTarget, actual: todayActual } = totalsFor(todayRecords, todayTargets, todayLineNames);
  const todayAchievement = Engine.computeAchievement(todayActual, todayTarget);
  const todayShortagePct = Engine.computeShortage(todayAchievement);

  const normalToday = todayLineNames.reduce((s, l) => s + Engine.lineTotal(todayRecords, l, 'NORMAL'), 0);
  const overtimeToday = todayLineNames.reduce((s, l) => s + Engine.lineTotal(todayRecords, l, 'OVERTIME'), 0);
  const overtimeSharePct = todayActual > 0 ? (overtimeToday / todayActual) * 100 : 0;

  // ---- Week-to-date and Month-to-date (reuses the exact Weekly/Monthly engine calls) ----
  const weekStart = Engine.getWeekStart(todayStr);
  const weekDates = Engine.getDateRange(weekStart, Engine.addDays(weekStart, 6));
  const allLineNames = Engine.getLineNamesFromData(STATE.records, STATE.lines);
  const weekSummary = Engine.computePeriodSummary(weekDates.map(d => Engine.computeDaySummary(STATE.records, STATE.lines, d, allLineNames)));

  const monthRange = Engine.getMonthRange(now.getFullYear(), now.getMonth() + 1);
  const monthEnd = monthRange.end > todayStr ? todayStr : monthRange.end;
  const monthDates = Engine.getDateRange(monthRange.start, monthEnd > monthRange.start ? monthEnd : monthRange.start);
  const monthSummary = Engine.computePeriodSummary(monthDates.map(d => Engine.computeDaySummary(STATE.records, STATE.lines, d, allLineNames)));

  // ---- Best line / line requiring attention (today, based on the same badges as the Live cards) ----
  const linesWithTarget = lineData.filter(l => l.target > 0);
  const bestLine = linesWithTarget.length ? [...linesWithTarget].sort((a, b) => b.achievement - a.achievement)[0] : null;
  const attentionLine = linesWithTarget.filter(l => l.badge === 'BEHIND').sort((a, b) => a.achievement - b.achievement)[0]
    || (linesWithTarget.length ? [...linesWithTarget].sort((a, b) => a.achievement - b.achievement)[0] : null);

  // ---- Forecast (Phase 6 — clearly separate from ACTUAL) ----
  const forecast = Engine.forecastProduction(
    todayTarget, todayActual,
    Engine.elapsedActiveMinutes(STATE.slotConfig, now),
    Engine.remainingWorkMinutes(STATE.slotConfig, now),
    { minMinutesForForecast: CONFIG.MIN_MINUTES_FOR_FORECAST, forecastClosePct: CONFIG.FORECAST_CLOSE_PCT }
  );

  // ---- Critical alerts only (Phase 4, filtered to what an executive needs to see first) ----
  const staleMinutes = STATE.lastFetch ? (now - STATE.lastFetch) / 60000 : null;
  const allAlerts = Engine.generateLiveAlerts({
    lineData, forecast, isOvertimeNow: Engine.getStatus(STATE.slotConfig, now).status.startsWith('OVERTIME'),
    staleMinutes, staleThresholdMinutes: CONFIG.STALE_WARNING_MINUTES,
  });
  const criticalAlerts = allAlerts.filter(a => a.severity === 'CRITICAL' || a.severity === 'WARNING');

  renderExecutiveKpis({ todayAchievement, todayTarget, weekSummary, monthSummary, todayShortagePct, overtimeSharePct });
  renderExecutiveHighlights({ bestLine, attentionLine });
  renderExecutiveForecast(forecast, todayTarget, todayActual);
  renderExecutiveAlerts(criticalAlerts);
}

function renderExecutiveKpis({ todayAchievement, todayTarget, weekSummary, monthSummary, todayShortagePct, overtimeSharePct }) {
  const weekCell = weekSummary.workingDaysCount > 0
    ? `${Math.round(weekSummary.achievement)}%`
    : 'لا توجد بيانات كافية';
  const monthCell = monthSummary.workingDaysCount > 0
    ? `${Math.round(monthSummary.achievement)}%`
    : 'لا توجد بيانات كافية';

  const cards = [
    { label: 'إنجاز اليوم', value: todayTarget > 0 ? Math.round(todayAchievement) + '%' : 'لا يوجد هدف اليوم', cls: todayAchievement >= 100 ? 'positive' : (todayAchievement < 70 ? 'negative' : '') },
    { label: 'إنجاز الأسبوع حتى الآن', value: weekCell },
    { label: 'إنجاز الشهر حتى الآن', value: monthCell },
    { label: 'نسبة النقص اليوم', value: todayTarget > 0 ? Math.round(todayShortagePct) + '%' : '—', cls: todayShortagePct > 30 ? 'negative' : '' },
    { label: 'نسبة الأوفر تايم اليوم', value: Math.round(overtimeSharePct) + '%', cls: overtimeSharePct >= 15 ? 'warn' : '' },
  ];
  document.getElementById('executiveKpiGrid').innerHTML = cards.map(c => `
    <div class="kpi-card ${c.cls || ''}"><div class="label">${c.label}</div><div class="num">${c.value}</div></div>`).join('');
}

function renderExecutiveHighlights({ bestLine, attentionLine }) {
  const box = document.getElementById('executiveHighlights');
  if (!bestLine && !attentionLine) { box.innerHTML = '<div class="empty-state">لا توجد أهداف محددة اليوم</div>'; return; }
  const card = (title, lb) => !lb ? '' : `
    <div class="line-card">
      <div class="head"><h3 style="font-size:13px;color:var(--text-dim);">${title}</h3><span class="badge ${lb.badge}">${Engine.STATUS_LABELS_AR[lb.badge]}</span></div>
      <div style="font-size:22px;font-weight:800;">${lb.line}</div>
      <div class="muted">الإنجاز: ${Math.round(lb.achievement)}% — الفعلي ${lb.actual} من ${lb.target}</div>
    </div>`;
  box.innerHTML = card('أفضل خط اليوم', bestLine) + card('يحتاج انتباه', attentionLine);
}

function renderExecutiveForecast(forecast, target, actual) {
  const box = document.getElementById('executiveForecast');
  if (target <= 0) { box.innerHTML = '<div class="empty-state">لا يوجد هدف اليوم لعمل توقع</div>'; return; }
  if (forecast.insufficientData) {
    box.innerHTML = `<div class="muted">لا توجد بيانات كافية لتوقع موثوق حتى الآن (يحتاج إنتاج فعلي وبعض الوقت المنقضي من اليوم أولًا).</div>`;
    return;
  }
  if (forecast.status === 'ACHIEVED') {
    box.innerHTML = `<div class="line-stats"><div class="cell"><div class="k">الحالة</div><div class="v" style="color:var(--green);">تم تحقيق الهدف بالفعل ✓</div></div><div class="cell"><div class="k">الفائض الحالي</div><div class="v">+${forecast.remainingOrSurplus}</div></div></div>`;
    return;
  }
  const statusLabel = { LIKELY_ACHIEVED: 'من المتوقع تحقيق الهدف', LIKELY_CLOSE: 'من المتوقع الاقتراب من الهدف', LIKELY_SHORTAGE: 'من المتوقع عدم تحقيق الهدف' }[forecast.status];
  const statusColor = { LIKELY_ACHIEVED: 'var(--green)', LIKELY_CLOSE: 'var(--amber)', LIKELY_SHORTAGE: 'var(--red)' }[forecast.status];
  box.innerHTML = `
    <div class="line-stats">
      <div class="cell"><div class="k">الهدف</div><div class="v">${target}</div></div>
      <div class="cell"><div class="k">الفعلي حتى الآن</div><div class="v">${actual}</div></div>
      <div class="cell"><div class="k">التوقع بنهاية اليوم *</div><div class="v">${Math.round(forecast.forecastTotal)}</div></div>
      <div class="cell"><div class="k">نسبة الإنجاز المتوقعة</div><div class="v">${Math.round(forecast.forecastAchievement)}%</div></div>
      <div class="cell"><div class="k">${forecast.remainingOrSurplus >= 0 ? 'فائض متوقع' : 'عجز متوقع'}</div><div class="v">${Math.abs(Math.round(forecast.remainingOrSurplus))}</div></div>
    </div>
    <div style="margin-top:10px;font-weight:700;color:${statusColor};">${statusLabel}</div>
    <div class="muted" style="margin-top:6px;">* توقع تقديري بناءً على معدل الإنتاج الحالي — ليس رقمًا فعليًا مؤكدًا.</div>`;
}

function renderExecutiveAlerts(alerts) {
  const box = document.getElementById('executiveAlerts');
  if (!alerts.length) { box.innerHTML = '<div class="empty-state">لا توجد تنبيهات حرجة الآن</div>'; return; }
  const cls = { CRITICAL: 'behind', WARNING: 'overtime' };
  box.innerHTML = alerts.map(a => `<div class="alert ${cls[a.severity] || 'behind'}">${a.text}</div>`).join('');
}
