/**
 * config.js
 * Paste your deployed Google Apps Script Web App URL below, once.
 * Both index.html (public) and admin.html (admin) read from here.
 * See README.md step 4 for how to get this URL.
 */
const CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbzv-iL0podPyPvXanWVVWtVSG_R5EshhLRE8_7YGqz8OCX2OyTYX_Y_O6nbP5F3OJfQ7Q/exec',
  REFRESH_INTERVAL_MS: 45000,      // dashboard auto-refresh
  STALE_WARNING_MINUTES: 90,       // warn if no data update for this long

  // Thresholds used by Engine.generateManagementAlerts() (Weekly/Monthly tabs).
  // Adjust freely — nothing in engine.js/app.js hard-codes these numbers.
  ALERT_THRESHOLDS: {
    belowAchievementPct: 95,        // achievement% under this counts as "underperforming" for streaks
    consecutiveBehindDays: 3,       // consecutive underperforming days before a warning fires
    otDependencyDaysFraction: 0.5,  // fraction of working days needing OT before an overtime-dependency alert fires
  },

  // Minimum working days of data required before showing a trend/comparison statement.
  MIN_DAYS_FOR_TREND: 3,

  // Phase 1 upgrade: end-of-day forecast (Engine.forecastProduction).
  // MIN_MINUTES_FOR_FORECAST: how much active production time must have
  // elapsed today before a forecast is attempted at all — too little data
  // makes any rate-based projection meaningless (shows "insufficient data" instead).
  // FORECAST_CLOSE_PCT: forecast achievement% at/above this (but below 100%)
  // is labeled "likely close" rather than "likely shortage".
  MIN_MINUTES_FOR_FORECAST: 30,
  FORECAST_CLOSE_PCT: 95,

  // How many minutes AFTER a slot's clock end time it's given before that
  // slot's target share is counted toward "Expected production" (and thus
  // toward BEHIND/AHEAD alerts). This gives the admin time to physically
  // collect and enter a slot's production after it ends, instead of the
  // dashboard expecting output continuously, minute-by-minute, during a
  // slot that's still running.
  EXPECTED_GRACE_MINUTES: 15,

  DATA_QUALITY: {
    outlierMultiplier: 3,
  },
};
