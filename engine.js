/**
 * engine.js
 * ---------
 * The ONE place where schedule logic and production math live.
 * Both index.html (public dashboard) and admin.html (admin panel) load this
 * file and must never re-implement any of this logic locally.
 *
 * Everything here is a pure function: given raw data (slotConfig, records,
 * lineTargets, now), it returns computed numbers. No DOM, no fetch.
 */

const Engine = (function () {

  // ---------- Status engine (Req #43) ----------
  // Possible statuses: NOT_STARTED, NORMAL_WORK, BREAK, OVERTIME, OVERTIME_BREAK, SHIFT_ENDED

  function timeToMinutes(hhmm) {
    // "08:30" -> 510
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  }

  function nowMinutes(now) {
    return now.getHours() * 60 + now.getMinutes();
  }

  /**
   * slotConfig: array of { slot, start: "08:30", end: "09:30", type: "NORMAL"|"OVERTIME" }
   * Gaps between consecutive slots (or before the first / after the last) are BREAK / NOT_STARTED / SHIFT_ENDED.
   */
  function getStatus(slotConfig, now) {
    const nm = nowMinutes(now);
    const sorted = [...slotConfig].sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start));
    if (sorted.length === 0) return { status: 'NOT_STARTED', slot: null };

    const dayStart = timeToMinutes(sorted[0].start);
    const dayEnd = timeToMinutes(sorted[sorted.length - 1].end);

    if (nm < dayStart) return { status: 'NOT_STARTED', slot: null };
    if (nm >= dayEnd) return { status: 'SHIFT_ENDED', slot: null };

    for (let i = 0; i < sorted.length; i++) {
      const s = sorted[i];
      const st = timeToMinutes(s.start), en = timeToMinutes(s.end);
      if (nm >= st && nm < en) {
        return { status: s.type === 'OVERTIME' ? 'OVERTIME' : 'NORMAL_WORK', slot: s.slot };
      }
      // gap before the next slot = break
      const next = sorted[i + 1];
      if (next && nm >= en && nm < timeToMinutes(next.start)) {
        const inOvertimeZone = s.type === 'OVERTIME' || next.type === 'OVERTIME';
        return { status: inOvertimeZone ? 'OVERTIME_BREAK' : 'BREAK', slot: null };
      }
    }
    return { status: 'SHIFT_ENDED', slot: null };
  }

  // ---------- Elapsed-time helpers ----------

  function totalMinutesOfType(slotConfig, type) {
    return slotConfig
      .filter(s => s.type === type)
      .reduce((sum, s) => sum + (timeToMinutes(s.end) - timeToMinutes(s.start)), 0);
  }

  /** Minutes of NORMAL working time that have fully or partially elapsed by `now`. */
  function elapsedMinutesOfType(slotConfig, now, type) {
    const nm = nowMinutes(now);
    let total = 0;
    for (const s of slotConfig.filter(s => s.type === type)) {
      const st = timeToMinutes(s.start), en = timeToMinutes(s.end);
      if (nm >= en) total += (en - st);
      else if (nm > st && nm < en) total += (nm - st);
    }
    return total;
  }

  // ---------- Core calculations (Req #41) ----------

  function safeDiv(a, b) { return b > 0 ? a / b : 0; }

  function computeAchievement(actual, target) {
    if (!target || target <= 0) return 0;
    return Math.min((actual / target) * 100, 999); // don't hard-cap display, UI caps the bar itself
  }

  function computeShortage(achievementPct) {
    return Math.max(100 - achievementPct, 0);
  }

  function computeRemaining(target, actual) {
    return Math.max(target - actual, 0);
  }

  /**
   * Sum of minutes for slots of `type` that have FULLY closed AND whose
   * "data-entry grace period" has also passed — i.e. slot.end + graceMinutes
   * <= now. A slot currently in progress contributes NOTHING, even if it's
   * 59 minutes in; its contribution appears all at once, `graceMinutes`
   * after it ends. This intentionally replaces continuous minute-by-minute
   * counting with discrete per-slot jumps, because production is recorded
   * in batches after each slot ends, not continuously during it.
   */
  function elapsedGraceAdjustedMinutes(slotConfig, now, type, graceMinutes) {
    const nm = now.getHours() * 60 + now.getMinutes();
    let total = 0;
    slotConfig.filter(s => s.type === type).forEach(s => {
      const st = timeToMinutes(s.start), en = timeToMinutes(s.end);
      if (nm >= en + graceMinutes) total += (en - st);
    });
    return total;
  }

  /**
   * Expected production "by now" for a single line.
   * - During/after NORMAL hours: proportional to FULLY-CLOSED normal slots
   *   only (see elapsedGraceAdjustedMinutes) — a slot's full target share
   *   appears `graceMinutes` after that slot's clock end, never gradually
   *   during the slot itself. `graceMinutes` defaults to 0 (old continuous
   *   behavior) for any caller that doesn't explicitly opt in; the live
   *   dashboard passes CONFIG.EXPECTED_GRACE_MINUTES.
   * - Once OVERTIME starts: expected freezes at 100% of target (normal hours
   *   were supposed to finish the order); overtime is tracked separately as
   *   "closing the gap", not as extra expected production (Req #8).
   */
  function computeExpected(slotConfig, now, target, graceMinutes) {
    graceMinutes = graceMinutes || 0;
    const totalNormalMin = totalMinutesOfType(slotConfig, 'NORMAL');
    const status = getStatus(slotConfig, now).status;
    if (status === 'NOT_STARTED') return 0;
    if (status === 'NORMAL_WORK' || status === 'BREAK') {
      const elapsed = graceMinutes > 0
        ? elapsedGraceAdjustedMinutes(slotConfig, now, 'NORMAL', graceMinutes)
        : elapsedMinutesOfType(slotConfig, now, 'NORMAL');
      return target * safeDiv(elapsed, totalNormalMin);
    }
    // OVERTIME, OVERTIME_BREAK, SHIFT_ENDED -> normal period is over
    return target;
  }

  /**
   * Overtime-specific metrics (Req #9).
   * remainingAtOTStart = target - actualNormalProduction (frozen the moment OT starts)
   * otProgressPct = otActual / remainingAtOTStart * 100
   */
  function computeOvertimeMetrics(target, actualNormal, actualOvertime) {
    const remainingAtOTStart = computeRemaining(target, actualNormal);
    const totalActual = actualNormal + actualOvertime;
    const remainingNow = computeRemaining(target, totalActual);
    const otProgressPct = remainingAtOTStart > 0
      ? Math.min((actualOvertime / remainingAtOTStart) * 100, 100)
      : 100;
    const exceeded = totalActual > target ? totalActual - target : 0;
    return { remainingAtOTStart, remainingNow, otProgressPct, exceeded };
  }

  /**
   * Estimate completion time from current overtime rate (Req #28).
   * rate = pieces per minute observed during elapsed overtime.
   * Returns a Date or null if not enough data / rate is 0.
   */
  function estimateCompletion(slotConfig, now, remainingNow, actualOvertimeSoFar) {
    if (remainingNow <= 0) return { done: true };
    const elapsedOT = elapsedMinutesOfType(slotConfig, now, 'OVERTIME');
    if (elapsedOT < 15 || actualOvertimeSoFar <= 0) return { done: false, eta: null, insufficientData: true };
    const rate = actualOvertimeSoFar / elapsedOT; // pieces/min
    if (rate <= 0) return { done: false, eta: null, insufficientData: true };
    const minutesNeeded = remainingNow / rate;
    const eta = new Date(now.getTime() + minutesNeeded * 60000);
    const otEndMin = Math.max(...slotConfig.filter(s => s.type === 'OVERTIME').map(s => timeToMinutes(s.end)));
    const etaMinutes = eta.getHours() * 60 + eta.getMinutes();
    return { done: false, eta, insufficientData: false, achievable: etaMinutes <= otEndMin };
  }

  // ---------- Aggregation from raw records (Req #10, #25, #44) ----------
  // records: [{date, slot, worker, line, production, type}]

  function filterByDate(records, dateStr) {
    return records.filter(r => r.date === dateStr);
  }

  function lineTotal(records, line, type) {
    return records
      .filter(r => r.line === line && (!type || r.type === type))
      .reduce((s, r) => s + Number(r.production || 0), 0);
  }

  function slotTotal(records, line, slot) {
    return records
      .filter(r => r.line === line && String(r.slot) === String(slot))
      .reduce((s, r) => s + Number(r.production || 0), 0);
  }

  function workerTotal(records, worker) {
    return records
      .filter(r => r.worker === worker)
      .reduce((s, r) => s + Number(r.production || 0), 0);
  }

  function workerLines(records, worker) {
    return [...new Set(records.filter(r => r.worker === worker).map(r => r.line))];
  }

  function factoryTotal(records, type) {
    return records
      .filter(r => !type || r.type === type)
      .reduce((s, r) => s + Number(r.production || 0), 0);
  }

  // ---------- Status label / badge helpers ----------

  function lineStatusBadge(actual, expected, target) {
    if (actual >= target) return 'TARGET_ACHIEVED';
    if (expected <= 0) return 'ON_TRACK';
    const diff = actual - expected;
    const tolerance = expected * 0.03; // within 3% counts as on-track
    if (diff > tolerance) return 'AHEAD';
    if (diff < -tolerance) return 'BEHIND';
    return 'ON_TRACK';
  }

  const STATUS_LABELS_AR = {
    NOT_STARTED: 'لم يبدأ العمل',
    NORMAL_WORK: 'جاري العمل',
    BREAK: 'فترة راحة',
    OVERTIME: 'أوفر تايم',
    OVERTIME_BREAK: 'راحة (أوفر تايم)',
    SHIFT_ENDED: 'انتهى اليوم',
    AHEAD: 'متقدم عن الهدف',
    ON_TRACK: 'على المسار',
    BEHIND: 'متأخر عن الهدف',
    TARGET_ACHIEVED: 'تم تحقيق الهدف',
  };

  function fmtDate(d) {
    const yyyy = d.getFullYear(), mm = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  function fmtTime(d) {
    return d.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
  }

  // ==========================================================================
  // PERIOD ANALYTICS (Weekly / Monthly reporting layer)
  // Everything below is built ONLY from the same records/lines/slotConfig the
  // live/daily view already uses (Req #19, #26). No separate dataset, no
  // duplicated math — computeDaySummary reuses lineTotal/computeAchievement/etc.
  // ==========================================================================

  function parseDateStr(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function addDays(dateStr, n) {
    const d = parseDateStr(dateStr);
    d.setDate(d.getDate() + n);
    return fmtDate(d);
  }

  /** Egypt work-week convention: Saturday -> Friday. Returns the Saturday on/before dateStr. */
  function getWeekStart(dateStr) {
    const d = parseDateStr(dateStr);
    const day = d.getDay(); // 0=Sun..6=Sat
    const diffFromSat = (day + 1) % 7; // Sat->0, Sun->1, Mon->2 ... Fri->6
    d.setDate(d.getDate() - diffFromSat);
    return fmtDate(d);
  }

  function getDateRange(startStr, endStr) {
    const dates = [];
    let cur = parseDateStr(startStr);
    const end = parseDateStr(endStr);
    while (cur <= end) { dates.push(fmtDate(cur)); cur.setDate(cur.getDate() + 1); }
    return dates;
  }

  function getMonthRange(year, month) {
    const start = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const end = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    return { start, end };
  }

  function getLineNamesFromData(records, lines) {
    const names = new Set();
    lines.forEach(l => names.add(l.line));
    records.forEach(r => names.add(r.line));
    return [...names].sort();
  }

  function getTargetsForDate(lines, dateStr) {
    const map = {};
    lines.filter(l => l.date === dateStr).forEach(l => { map[l.line] = l; });
    return map;
  }

  /**
   * Full summary for ONE calendar day — the building block for weekly/monthly.
   * Not "live": treats the day as closed. hasData=false means no target AND no
   * records exist for that date (distinguishes a real gap from a 0-production day).
   */
  function computeDaySummary(records, lines, dateStr, lineNamesOverride) {
    const dayRecords = filterByDate(records, dateStr);
    const targets = getTargetsForDate(lines, dateStr);
    const lineNames = lineNamesOverride || Object.keys(targets);

    let totalTarget = 0, totalActual = 0, totalNormal = 0, totalOvertime = 0;
    const lineBreakdown = lineNames.map(line => {
      const target = (targets[line] && targets[line].target) || 0;
      const normal = lineTotal(dayRecords, line, 'NORMAL');
      const overtime = lineTotal(dayRecords, line, 'OVERTIME');
      const actual = normal + overtime;
      totalTarget += target; totalActual += actual; totalNormal += normal; totalOvertime += overtime;
      const achievement = computeAchievement(actual, target);
      let status;
      if (target <= 0) status = 'NO_TARGET';
      else if (actual >= target) status = 'TARGET_ACHIEVED';
      else if (achievement >= 90) status = 'ON_TRACK';
      else status = 'BEHIND';
      return { line, target, normal, overtime, actual, achievement, status, usedOvertime: overtime > 0 };
    });

    const hasData = dayRecords.length > 0 || Object.keys(targets).length > 0;
    const achievement = computeAchievement(totalActual, totalTarget);
    const shortage = computeShortage(achievement);
    const remaining = computeRemaining(totalTarget, totalActual);
    let status;
    if (!hasData) status = 'NO_DATA';
    else if (totalTarget <= 0) status = 'NO_TARGET';
    else if (totalActual >= totalTarget) status = 'TARGET_ACHIEVED';
    else if (achievement >= 90) status = 'ON_TRACK';
    else status = 'BEHIND';

    return { date: dateStr, target: totalTarget, actual: totalActual, normal: totalNormal, overtime: totalOvertime, achievement, shortage, remaining, status, hasData, lineBreakdown };
  }

  /** Aggregates an array of computeDaySummary() results into period-level KPIs (Req #2, #9). */
  function computePeriodSummary(daySummaries) {
    const workingDays = daySummaries.filter(d => d.hasData && d.target > 0);
    const totalTarget = workingDays.reduce((s, d) => s + d.target, 0);
    const totalActual = workingDays.reduce((s, d) => s + d.actual, 0);
    const totalOvertime = workingDays.reduce((s, d) => s + d.overtime, 0);
    const totalNormal = workingDays.reduce((s, d) => s + d.normal, 0);
    const achievement = computeAchievement(totalActual, totalTarget);
    const shortage = computeShortage(achievement);
    const remaining = computeRemaining(totalTarget, totalActual);
    const daysAchieved = workingDays.filter(d => d.status === 'TARGET_ACHIEVED').length;
    const daysBehind = workingDays.filter(d => d.status === 'BEHIND').length;
    const avgDailyProduction = workingDays.length ? totalActual / workingDays.length : 0;
    const avgDailyAchievement = workingDays.length ? workingDays.reduce((s, d) => s + d.achievement, 0) / workingDays.length : 0;

    let bestDay = null, worstDay = null;
    workingDays.forEach(d => {
      if (!bestDay || d.achievement > bestDay.achievement) bestDay = d;
      if (!worstDay || d.achievement < worstDay.achievement) worstDay = d;
    });

    return {
      totalTarget, totalActual, totalNormal, totalOvertime, achievement, shortage, remaining,
      workingDaysCount: workingDays.length, daysAchieved, daysBehind, avgDailyProduction, avgDailyAchievement,
      bestDay, worstDay, workingDays,
    };
  }

  /** Per-line totals across a period, ranked by achievement% (Req #3, #11 — not raw quantity). */
  function computeLinePeriodPerformance(daySummaries, lineNames) {
    const perLine = lineNames.map(line => {
      let target = 0, actual = 0, normal = 0, overtime = 0, otDays = 0, daysWithTarget = 0;
      daySummaries.forEach(d => {
        const lb = d.lineBreakdown.find(x => x.line === line);
        if (lb && lb.target > 0) {
          target += lb.target; actual += lb.actual; normal += lb.normal; overtime += lb.overtime; daysWithTarget++;
          if (lb.usedOvertime) otDays++;
        }
      });
      const achievement = computeAchievement(actual, target);
      const shortage = computeShortage(achievement);
      let status;
      if (target <= 0) status = 'NO_DATA';
      else if (actual >= target) status = 'TARGET_ACHIEVED';
      else if (achievement >= 90) status = 'ON_TRACK';
      else status = 'BEHIND';
      return { line, target, actual, normal, overtime, achievement, shortage, status, otDays, daysWithTarget };
    });
    const ranked = perLine.filter(l => l.daysWithTarget > 0).sort((a, b) => b.achievement - a.achievement);
    ranked.forEach((l, i) => { l.rank = i + 1; });
    return perLine.map(l => ({ ...l, rank: l.daysWithTarget > 0 ? ranked.find(r => r.line === l.line).rank : null }));
  }

  /** Dedicated overtime-dependency analysis (Req #7, #8). */
  function computeOvertimeAnalysis(daySummaries, lineNames) {
    const workingDays = daySummaries.filter(d => d.hasData && d.target > 0);
    const totalOvertime = workingDays.reduce((s, d) => s + d.overtime, 0);
    const totalActual = workingDays.reduce((s, d) => s + d.actual, 0);
    const daysWithOT = workingDays.filter(d => d.overtime > 0).length;
    const avgOTPerDay = daysWithOT ? totalOvertime / daysWithOT : 0;
    const otShareOfTotal = totalActual > 0 ? (totalOvertime / totalActual) * 100 : 0;

    const perLine = lineNames.map(line => {
      let otDays = 0, otTotal = 0, normalTotal = 0, target = 0, actual = 0, recoveredDays = 0, insufficientDays = 0, daysWithTarget = 0;
      workingDays.forEach(d => {
        const lb = d.lineBreakdown.find(x => x.line === line);
        if (lb && lb.target > 0) {
          daysWithTarget++;
          target += lb.target; actual += lb.actual; normalTotal += lb.normal; otTotal += lb.overtime;
          if (lb.overtime > 0) {
            otDays++;
            if (lb.actual >= lb.target) recoveredDays++; else insufficientDays++;
          }
        }
      });
      return {
        line, otDays, otTotal, normalTotal, target, actual,
        achievement: computeAchievement(actual, target), recoveredDays, insufficientDays, daysWithTarget,
        otFrequencyPct: daysWithTarget ? (otDays / daysWithTarget) * 100 : 0,
      };
    });

    return { totalOvertime, daysWithOT, avgOTPerDay, otShareOfTotal, perLine, totalWorkingDays: workingDays.length };
  }

  /**
   * Worker analytics for a period (Req #13). Ranked by production-per-active-slot,
   * NOT raw total — a worker active 3 slots isn't penalized against one active 10.
   */
  function computeWorkerPeriodAnalytics(records, dateList) {
    const periodRecords = records.filter(r => dateList.includes(r.date));
    const workers = [...new Set(periodRecords.map(r => r.worker))];
    return workers.map(w => {
      const wRecords = periodRecords.filter(r => r.worker === w);
      const total = wRecords.reduce((s, r) => s + Number(r.production || 0), 0);
      const activeSlots = new Set(wRecords.map(r => r.date + '|' + r.slot)).size;
      const lines = [...new Set(wRecords.map(r => r.line))];
      const avgPerSlot = activeSlots > 0 ? total / activeSlots : 0;
      return { worker: w, total, activeSlots, lines, avgPerSlot };
    }).sort((a, b) => b.avgPerSlot - a.avgPerSlot);
  }

  /** Line consistency across a period (Req #15). */
  function computeConsistency(daySummaries, lineNames) {
    const workingDays = daySummaries.filter(d => d.hasData && d.target > 0);
    return lineNames.map(line => {
      const points = [];
      workingDays.forEach(d => {
        const lb = d.lineBreakdown.find(x => x.line === line);
        if (lb && lb.target > 0) points.push(lb);
      });
      if (!points.length) return { line, insufficientData: true };
      const achievements = points.map(p => p.achievement);
      const avg = achievements.reduce((a, b) => a + b, 0) / achievements.length;
      const best = Math.max(...achievements);
      const worst = Math.min(...achievements);
      const daysBehind = points.filter(p => p.status === 'BEHIND').length;
      const daysAchieved = points.filter(p => p.status === 'TARGET_ACHIEVED').length;
      const otFreq = points.filter(p => p.usedOvertime).length;
      return { line, avg, best, worst, daysBehind, daysAchieved, otFreq, totalDays: points.length, insufficientData: false };
    });
  }

  function computeDowntimeAnalysis(downtimeLogs, dateList) {
    const logs = (downtimeLogs || []).filter(log => dateList.includes(log.date));
    const byReason = {}, byLine = {};
    logs.forEach(log => {
      const reason = log.reason || 'غير محدد';
      byReason[reason] = (byReason[reason] || 0) + 1;
      byLine[log.line] = (byLine[log.line] || 0) + 1;
    });
    const ranked = values => Object.entries(values).map(([name, count]) => ({ name, count, pct: logs.length ? count / logs.length * 100 : 0 })).sort((a, b) => b.count - a.count);
    return { totalLogs: logs.length, byReason: ranked(byReason), byLine: ranked(byLine), logs };
  }

  function computeDataQualityReport(records, lines, allWorkers, slotConfig, options) {
    const multiplier = (options && options.outlierMultiplier) || 3;
    const findings = [], activeSlots = new Set((slotConfig || []).map(s => String(s.slot)));
    const knownWorkers = new Set((allWorkers || []).map(w => w.name));
    const targetKeys = new Set((lines || []).map(l => `${l.date}|${l.line}`));
    const keys = {};
    (records || []).forEach(r => { const key = [r.date, r.slot, r.worker, r.line].map(String).join('|'); (keys[key] ||= []).push(r); });
    Object.entries(keys).filter(([, rows]) => rows.length > 1).forEach(([key, rows]) => findings.push({ severity: 'critical', type: 'DUPLICATE_KEY', message: `سجل إنتاج مكرر محتمل للمفتاح ${key}`, count: rows.length }));
    (records || []).forEach(r => {
      if (!activeSlots.has(String(r.slot))) findings.push({ severity: 'warning', type: 'INVALID_SLOT', message: `الفترة ${r.slot} غير موجودة في جدول الفترات` });
      if (knownWorkers.size && !knownWorkers.has(r.worker)) findings.push({ severity: 'warning', type: 'UNKNOWN_WORKER', message: `العامل «${r.worker}» غير موجود في قائمة العمال` });
      if (!targetKeys.has(`${r.date}|${r.line}`)) findings.push({ severity: 'warning', type: 'MISSING_TARGET', message: `لا يوجد هدف للخط ${r.line} بتاريخ ${r.date}` });
      if (Number(r.production) === 0) findings.push({ severity: 'info', type: 'ZERO_PRODUCTION', message: `إدخال إنتاج صفر للعامل ${r.worker} في ${r.date} / فترة ${r.slot}` });
    });
    const values = (records || []).map(r => Number(r.production)).filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
    const median = values.length ? values[Math.floor(values.length / 2)] : 0;
    if (median > 0) (records || []).filter(r => Number(r.production) > median * multiplier).forEach(r => findings.push({ severity: 'warning', type: 'HIGH_QUANTITY', message: `كمية مرتفعة تحتاج مراجعة: ${r.production} (أكبر من ${multiplier}× وسيط الإدخالات)` }));
    const lineDays = new Set([...(lines || []).map(l => `${l.date}|${l.line}`), ...(records || []).map(r => `${r.date}|${r.line}`)]);
    lineDays.forEach(key => {
      const [date, line] = key.split('|');
      const recorded = new Set((records || []).filter(r => r.date === date && r.line === line).map(r => String(r.slot)));
      const missing = [...activeSlots].filter(slot => !recorded.has(slot));
      if (missing.length) findings.push({ severity: 'info', type: 'MISSING_SLOTS', message: `فترات بلا إدخال للخط ${line} بتاريخ ${date}: ${missing.join('، ')}` });
    });
    const counts = findings.reduce((all, finding) => { all[finding.severity] = (all[finding.severity] || 0) + 1; return all; }, { critical: 0, warning: 0, info: 0 });
    return { findings, counts, medianProduction: median };
  }

  /**
   * Management alerts generated purely from computed data (Req #8, #16).
   * Thresholds come from CONFIG (config.js), never hard-coded here.
   */
  function generateManagementAlerts(daySummaries, lineNames, thresholds) {
    thresholds = thresholds || {};
    const belowPct = thresholds.belowAchievementPct || 95;
    const consecutiveDays = thresholds.consecutiveBehindDays || 3;
    const otDependencyFraction = thresholds.otDependencyDaysFraction || 0.5;
    const alerts = [];
    const workingDays = [...daySummaries].filter(d => d.hasData && d.target > 0).sort((a, b) => a.date < b.date ? -1 : 1);

    lineNames.forEach(line => {
      let streak = 0;
      for (let i = workingDays.length - 1; i >= 0; i--) {
        const lb = workingDays[i].lineBreakdown.find(x => x.line === line);
        if (lb && lb.target > 0 && lb.achievement < belowPct) streak++;
        else break;
      }
      if (streak >= consecutiveDays) {
        alerts.push({ type: 'warning', text: `⚠ ${line} أقل من ${belowPct}% إنجاز لمدة ${streak} أيام عمل متتالية` });
      }

      const daysWithTarget = workingDays.filter(d => { const lb = d.lineBreakdown.find(x => x.line === line); return lb && lb.target > 0; });
      const otDays = daysWithTarget.filter(d => d.lineBreakdown.find(x => x.line === line).usedOvertime);
      if (daysWithTarget.length >= 3 && otDays.length / daysWithTarget.length >= otDependencyFraction) {
        alerts.push({ type: 'overtime', text: `⚠ ${line} احتاج أوفر تايم في ${otDays.length} من ${daysWithTarget.length} أيام عمل` });
      }

      const achievedDays = daysWithTarget.filter(d => d.lineBreakdown.find(x => x.line === line).status === 'TARGET_ACHIEVED');
      if (daysWithTarget.length >= 3 && achievedDays.length / daysWithTarget.length >= 0.8) {
        alerts.push({ type: 'achieved', text: `✓ ${line} حقق الهدف في ${achievedDays.length} من ${daysWithTarget.length} أيام عمل` });
      }
    });

    const totalActual = workingDays.reduce((s, d) => s + d.actual, 0);
    const totalOT = workingDays.reduce((s, d) => s + d.overtime, 0);
    if (totalActual > 0) {
      const sharePct = (totalOT / totalActual) * 100;
      if (sharePct >= 15) alerts.push({ type: 'overtime', text: `⚠ الأوفر تايم ساهم بـ ${Math.round(sharePct)}% من إجمالي إنتاج هذه الفترة` });
    }
    return alerts;
  }

  /** Neutral current-vs-previous-period comparison (Req #25). */
  function comparePeriods(currentSummary, previousSummary) {
    if (!previousSummary || previousSummary.workingDaysCount === 0) return { insufficientData: true };
    const pctChange = (curr, prev) => prev > 0 ? ((curr - prev) / prev) * 100 : null;
    return {
      insufficientData: false,
      productionChangePct: pctChange(currentSummary.totalActual, previousSummary.totalActual),
      achievementChangePct: currentSummary.achievement - previousSummary.achievement,
      overtimeChangePct: pctChange(currentSummary.totalOvertime, previousSummary.totalOvertime),
    };
  }

  Object.assign(STATUS_LABELS_AR, {
    NO_DATA: 'لا توجد بيانات',
    NO_TARGET: 'بدون هدف محدد',
  });

  // ==========================================================================
  // PHASE 1 UPGRADE: FORECAST + SMART ALERTS (executive/live decision-support)
  // Reuses totalMinutesOfType/elapsedMinutesOfType/computeAchievement already
  // defined above — no separate calculation path.
  // ==========================================================================

  /** Minutes of NORMAL+OVERTIME work still ahead of `now` today (excludes breaks). */
  function remainingWorkMinutes(slotConfig, now) {
    const nm = now.getHours() * 60 + now.getMinutes();
    let total = 0;
    slotConfig.forEach(s => {
      const st = timeToMinutes(s.start), en = timeToMinutes(s.end);
      if (nm >= en) return;            // slot already fully over
      if (nm <= st) total += (en - st); // slot entirely ahead
      else total += (en - nm);          // currently inside this slot
    });
    return total;
  }

  /** Minutes of NORMAL+OVERTIME work already elapsed by `now` today. */
  function elapsedActiveMinutes(slotConfig, now) {
    return elapsedMinutesOfType(slotConfig, now, 'NORMAL') + elapsedMinutesOfType(slotConfig, now, 'OVERTIME');
  }

  /**
   * TARGET vs ACTUAL vs EXPECTED vs FORECAST are four distinct concepts (kept
   * separate per spec): this function ONLY produces the FORECAST — an estimate
   * of end-of-day production based on the observed production rate so far,
   * clearly never presented as ACTUAL.
   * Requires a minimum amount of elapsed active time before forecasting at all
   * (config.MIN_MINUTES_FOR_FORECAST) — otherwise returns insufficientData.
   */
  function forecastProduction(target, actualSoFar, elapsedActiveMin, remainingActiveMin, thresholds) {
    thresholds = thresholds || {};
    const minMinutes = thresholds.minMinutesForForecast || 30;
    const closePct = thresholds.forecastClosePct || 95;

    if (target <= 0) return { insufficientData: true };
    if (actualSoFar >= target) {
      return { insufficientData: false, forecastTotal: actualSoFar, forecastAchievement: computeAchievement(actualSoFar, target), status: 'ACHIEVED', remainingOrSurplus: actualSoFar - target };
    }
    if (elapsedActiveMin < minMinutes || actualSoFar <= 0) {
      return { insufficientData: true };
    }
    const rate = actualSoFar / elapsedActiveMin; // pieces per active minute
    const forecastTotal = actualSoFar + rate * remainingActiveMin;
    const forecastAchievement = computeAchievement(forecastTotal, target);
    let status;
    if (forecastAchievement >= 100) status = 'LIKELY_ACHIEVED';
    else if (forecastAchievement >= closePct) status = 'LIKELY_CLOSE';
    else status = 'LIKELY_SHORTAGE';
    return { insufficientData: false, forecastTotal, forecastAchievement, status, remainingOrSurplus: forecastTotal - target };
  }

  const ALERT_SEVERITY_LABELS_AR = { SUCCESS: 'إيجابي', WARNING: 'تنبيه', CRITICAL: 'حرج', INFO: 'معلومة' };

  /**
   * Centralized LIVE alert generation (Phase 4). Takes already-computed
   * per-line live figures (target/actual/expected/achievement/badge/isOvertime)
   * — the same figures the Live tab's line cards already show — so nothing is
   * invented here, only interpreted. Returns alerts tagged with a severity
   * (INFO/WARNING/CRITICAL/SUCCESS) instead of an ad-hoc CSS class.
   */
  function generateLiveAlerts(params) {
    const alerts = [];
    const lineData = params.lineData || [];
    const isOvertimeNow = !!params.isOvertimeNow;

    lineData.forEach(lb => {
      if (!lb.target) return;
      if (lb.badge === 'TARGET_ACHIEVED') {
        const exceeded = lb.actual - lb.target;
        alerts.push({ severity: 'SUCCESS', text: exceeded > 0 ? `✓ ${lb.line} تجاوز الهدف بمقدار ${exceeded} قطعة` : `✓ ${lb.line} حقق هدف اليوم` });
      } else if (lb.badge === 'BEHIND') {
        const gap = Math.round(lb.expected - lb.actual);
        const severity = lb.achievement < 70 ? 'CRITICAL' : 'WARNING';
        alerts.push({ severity, text: `${severity === 'CRITICAL' ? '🔴' : '⚠'} ${lb.line} متأخر ${gap} قطعة عن الإنتاج المتوقع` });
        if (isOvertimeNow) {
          alerts.push({ severity: 'WARNING', text: `⚠ ${lb.line} دخل الأوفر تايم وبه عجز ${Math.round(lb.target - lb.actual)} قطعة` });
        }
      } else if (lb.badge === 'AHEAD' && isOvertimeNow) {
        alerts.push({ severity: 'INFO', text: `↑ ${lb.line} يعمل على تعويض النقص المتراكم` });
      }
    });

    if (params.forecast && !params.forecast.insufficientData) {
      if (params.forecast.status === 'LIKELY_SHORTAGE') {
        alerts.push({ severity: 'WARNING', text: `⚠ بمعدل الإنتاج الحالي، التوقع أن الهدف الكلي لن يتحقق (نسبة متوقعة ${Math.round(params.forecast.forecastAchievement)}%)` });
      } else if (params.forecast.status === 'LIKELY_ACHIEVED') {
        alerts.push({ severity: 'SUCCESS', text: `✓ بمعدل الإنتاج الحالي، من المتوقع تحقيق الهدف الكلي` });
      }
    }

    if (params.staleMinutes != null && params.staleThresholdMinutes && params.staleMinutes > params.staleThresholdMinutes) {
      alerts.push({ severity: 'WARNING', text: `⚠ لم يتم استلام أي تحديث إنتاج منذ ${Math.round(params.staleMinutes)} دقيقة` });
    }

    return alerts;
  }

  return {
    getStatus, totalMinutesOfType, elapsedMinutesOfType,
    computeAchievement, computeShortage, computeRemaining, computeExpected, elapsedGraceAdjustedMinutes,
    computeOvertimeMetrics, estimateCompletion,
    filterByDate, lineTotal, slotTotal, workerTotal, workerLines, factoryTotal,
    lineStatusBadge, STATUS_LABELS_AR, fmtDate, fmtTime, timeToMinutes,
    // period analytics
    addDays, getWeekStart, getDateRange, getMonthRange, getLineNamesFromData, getTargetsForDate,
    computeDaySummary, computePeriodSummary, computeLinePeriodPerformance, computeOvertimeAnalysis,
    computeWorkerPeriodAnalytics, computeConsistency, generateManagementAlerts, comparePeriods,
    computeDowntimeAnalysis, computeDataQualityReport,
    // Phase 1: forecast + smart alerts
    remainingWorkMinutes, elapsedActiveMinutes, forecastProduction, generateLiveAlerts, ALERT_SEVERITY_LABELS_AR,
  };
})();
