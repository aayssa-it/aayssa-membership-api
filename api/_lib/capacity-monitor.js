import {
  getBaserowBaseUrl,
  getBaserowHeaders
} from "./aayssa.js";

const DEFAULT_ALERT_EMAIL = "aayssa.official@gmail.com";

export async function handleCapacityMonitor(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, message: "Method not allowed." });
  }

  if (!isAuthorizedCron(req)) {
    return res.status(401).json({ success: false, message: "Unauthorized." });
  }

  const snapshot = await getCapacitySnapshot();
  const { checks, severity } = snapshot;
  const actionable = checks.filter(({ status }) =>
    status === "warning" || status === "critical" || status === "error"
  );
  let alertSent = false;
  let alertError = "";

  if (actionable.length > 0) {
    try {
      await sendAlert(checks, severity);
      alertSent = true;
    } catch (error) {
      alertError = safeError(error);
      console.error("Capacity alert delivery failed:", alertError);
    }
  }

  return res.status(alertError ? 502 : 200).json({
    success: !alertError,
    checkedAt: new Date().toISOString(),
    severity,
    alertSent,
    alertError: alertError || undefined,
    checks
  });
}

export async function getCapacitySnapshot() {
  const warningPercent = readPercent("CAPACITY_WARNING_PERCENT", 70);
  const criticalPercent = readPercent("CAPACITY_CRITICAL_PERCENT", 90);
  const checks = [];

  checks.push(...await checkBaserow(warningPercent, criticalPercent));
  checks.push(...await checkResend(warningPercent, criticalPercent));
  checks.push(await checkSupabaseHealth());
  checks.push({
    provider: "Vercel",
    metric: "Hobby usage",
    status: "manual",
    detail: "Capacity percentages are not exposed to Hobby serverless functions; use the Vercel Usage dashboard."
  });

  const actionable = checks.filter(({ status }) =>
    status === "warning" || status === "critical" || status === "error"
  );
  const severity = actionable.some(({ status }) =>
    status === "critical" || status === "error"
  ) ? "critical" : actionable.length > 0 ? "warning" : "ok";

  return {
    checkedAt: new Date().toISOString(),
    severity,
    thresholds: {
      warning: warningPercent,
      critical: criticalPercent
    },
    checks
  };
}

function isAuthorizedCron(req) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret && req.headers.authorization === `Bearer ${secret}`);
}

async function checkBaserow(warningPercent, criticalPercent) {
  try {
    const tablesResponse = await fetch(
      `${getBaserowBaseUrl()}/api/database/tables/all-tables/`,
      { headers: getBaserowHeaders() }
    );
    if (!tablesResponse.ok) throw new Error(`table lookup returned ${tablesResponse.status}`);
    const payload = await tablesResponse.json();
    const tables = Array.isArray(payload) ? payload : (payload.results || []);
    const counts = await Promise.all(tables.map(async ({ id }) => {
      const response = await fetch(
        `${getBaserowBaseUrl()}/api/database/rows/table/${id}/?size=1`,
        { headers: getBaserowHeaders() }
      );
      if (!response.ok) throw new Error(`row count returned ${response.status}`);
      return Number((await response.json()).count || 0);
    }));
    return [metric("Baserow", "Workspace rows", counts.reduce((a, b) => a + b, 0),
      Number(process.env.BASEROW_FREE_ROW_LIMIT || 3000), warningPercent, criticalPercent)];
  } catch (error) {
    return [{ provider: "Baserow", metric: "Workspace rows", status: "error", detail: safeError(error) }];
  }
}

async function checkResend(warningPercent, criticalPercent) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return [{ provider: "Resend", metric: "Usage", status: "manual", detail: "RESEND_API_KEY is not configured." }];
  try {
    const response = await fetch("https://api.resend.com/usage", {
      headers: { Authorization: `Bearer ${key}` }
    });
    if (!response.ok) throw new Error(`usage lookup returned ${response.status}`);
    const usage = await response.json();
    const checks = [];
    for (const [name, value] of Object.entries(usage.emails || {})) {
      if (value && Number.isFinite(Number(value.used)) && Number(value.limit) > 0) {
        checks.push(metric("Resend", `Emails ${name}`, Number(value.used), Number(value.limit), warningPercent, criticalPercent));
      }
    }
    return checks.length ? checks : [{ provider: "Resend", metric: "Usage", status: "manual", detail: "Usage API returned no comparable limits." }];
  } catch (error) {
    return [{ provider: "Resend", metric: "Usage", status: "error", detail: safeError(error) }];
  }
}

async function checkSupabaseHealth() {
  const url = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return { provider: "Supabase", metric: "Project health", status: "error", detail: "Supabase configuration is missing." };
  try {
    const response = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } });
    if (!response.ok) throw new Error(`health lookup returned ${response.status}`);
    return { provider: "Supabase", metric: "Project health", status: "ok", detail: "Auth is reachable. Capacity percentages still require the Supabase Usage dashboard." };
  } catch (error) {
    return { provider: "Supabase", metric: "Project health", status: "error", detail: safeError(error) };
  }
}

function metric(provider, name, used, limit, warningPercent, criticalPercent) {
  const percent = limit > 0 ? (used / limit) * 100 : 0;
  const status = percent >= criticalPercent ? "critical" : percent >= warningPercent ? "warning" : "ok";
  return { provider, metric: name, status, used, limit, percent: Number(percent.toFixed(1)) };
}

async function sendAlert(checks, severity) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL || process.env.RESEND_FROM || process.env.EMAIL_FROM;
  if (!key || !from) throw new Error("Resend alert delivery is not configured.");
  const to = process.env.CAPACITY_ALERT_EMAIL || DEFAULT_ALERT_EMAIL;
  const lines = checks.map(check => {
    const usage = check.percent == null ? check.detail : `${check.used} / ${check.limit} (${check.percent}%)`;
    return `${check.provider} — ${check.metric}: ${check.status.toUpperCase()} — ${usage}`;
  });
  const period = severity === "critical" ? new Date().toISOString().slice(0, 10) : new Date().toISOString().slice(0, 7);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `aayssa-capacity-${severity}-${period}`
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: `[AAYSSA Capacity ${severity === "critical" ? "Critical" : "Warning"}] Service limits need attention`,
      text: `AAYSSA free-tier capacity monitor found items needing attention:\n\n${lines.join("\n")}\n\nReview the provider dashboards before changing plans.`
    })
  });
  if (!response.ok) throw new Error(`Resend alert returned ${response.status}`);
}

function readPercent(name, fallback) {
  const value = Number(process.env[name]);
  return value > 0 && value <= 100 ? value : fallback;
}

function safeError(error) {
  return String(error?.message || "Unknown monitoring error").slice(0, 180);
}
