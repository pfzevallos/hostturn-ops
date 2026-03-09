require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const path = require("path");
const { getDb } = require("./db");
const bw = require("./breezeway");
const sms = require("./sms");
const auto = require("./automation");
const closeout = require("./closeout");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve dashboard
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════════════════
// API ROUTES — Dashboard
// ═══════════════════════════════════════════════════════

// --- Jobs ---
app.get("/api/jobs", (req, res) => {
  const db = getDb();
  const date = req.query.date || new Date().toISOString().split("T")[0];
  const jobs = db.prepare("SELECT * FROM jobs WHERE date = ? ORDER BY expected_arrival").all(date);
  // Attach steps
  for (const job of jobs) {
    job.steps = {};
    const steps = db.prepare("SELECT step_key, status, sent_at FROM job_steps WHERE job_id = ?").all(job.id);
    for (const s of steps) job.steps[s.step_key] = { status: s.status, sent_at: s.sent_at };
  }
  res.json(jobs);
});

app.post("/api/jobs", (req, res) => {
  const db = getDb();
  const { date, property_name, group_name, cleaner_name, checkout_time, expected_arrival, finish_by, rate, task_notes, is_checkout_day } = req.body;
  const id = "j" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const ea = expected_arrival || (is_checkout_day === false ? "09:00" : "10:00");
  db.prepare(`INSERT INTO jobs (id, date, property_name, group_name, cleaner_name, checkout_time, expected_arrival, finish_by, rate, task_notes, is_checkout_day)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, date, property_name, group_name, cleaner_name, checkout_time, ea, finish_by, rate, task_notes, is_checkout_day ? 1 : 0);
  const STEPS = ["owner_confirm","cleaner_sched","morning","arrival","progress","end_verify","finishing","close_out"];
  for (const sk of STEPS) {
    db.prepare("INSERT OR IGNORE INTO job_steps (id, job_id, step_key, status) VALUES (?, ?, ?, 'pending')").run(id+"_"+sk, id, sk);
  }
  res.json({ id });
});

app.patch("/api/jobs/:id", (req, res) => {
  const db = getDb();
  const fields = req.body;
  const sets = Object.keys(fields).map(k => `${k} = ?`).join(", ");
  const vals = Object.values(fields);
  db.prepare(`UPDATE jobs SET ${sets}, updated_at = datetime('now') WHERE id = ?`).run(...vals, req.params.id);
  res.json({ ok: true });
});

app.delete("/api/jobs/:id", (req, res) => {
  const db = getDb();
  db.prepare("DELETE FROM job_steps WHERE job_id = ?").run(req.params.id);
  db.prepare("DELETE FROM jobs WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// --- Send message for a specific step ---
app.post("/api/jobs/:id/send/:step", async (req, res) => {
  try {
    const db = getDb();
    const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    const result = await sms.sendStepMessage(req.params.step, job, req.body.extras);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Bulk send a step for all pending jobs on a date ---
app.post("/api/bulk-send/:step", async (req, res) => {
  try {
    const db = getDb();
    const date = req.body.date || new Date().toISOString().split("T")[0];
    const jobs = db.prepare("SELECT j.* FROM jobs j JOIN job_steps js ON j.id = js.job_id WHERE j.date = ? AND js.step_key = ? AND js.status = 'pending'")
      .all(date, req.params.step);
    let sent = 0;
    for (const job of jobs) {
      const result = await sms.sendStepMessage(req.params.step, job);
      if (result?.success) sent++;
      await new Promise(r => setTimeout(r, 500)); // Rate limit
    }
    res.json({ sent, total: jobs.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Contacts ---
app.get("/api/contacts", (req, res) => {
  res.json(getDb().prepare("SELECT * FROM contacts ORDER BY role, name").all());
});

app.post("/api/contacts", (req, res) => {
  const db = getDb();
  const { name, phone, email, role, lang, properties, notes } = req.body;
  const id = "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  db.prepare("INSERT INTO contacts (id, name, phone, email, role, lang, properties, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, name, phone, email, role || "cleaner", lang || "en", properties, notes);
  res.json({ id });
});

app.patch("/api/contacts/:id", (req, res) => {
  const db = getDb();
  const fields = req.body;
  const sets = Object.keys(fields).map(k => `${k} = ?`).join(", ");
  db.prepare(`UPDATE contacts SET ${sets} WHERE id = ?`).run(...Object.values(fields), req.params.id);
  res.json({ ok: true });
});

app.delete("/api/contacts/:id", (req, res) => {
  getDb().prepare("DELETE FROM contacts WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// --- Templates ---
app.get("/api/templates", (req, res) => {
  res.json(getDb().prepare("SELECT * FROM templates").all());
});

app.put("/api/templates/:step/:lang", (req, res) => {
  getDb().prepare("INSERT OR REPLACE INTO templates (step_key, lang, body) VALUES (?, ?, ?)")
    .run(req.params.step, req.params.lang, req.body.body);
  res.json({ ok: true });
});

// --- Messages log ---
app.get("/api/messages", (req, res) => {
  const date = req.query.date || new Date().toISOString().split("T")[0];
  res.json(getDb().prepare("SELECT * FROM messages WHERE created_at LIKE ? ORDER BY created_at DESC").all(date + "%"));
});

app.get("/api/messages/escalations", (req, res) => {
  res.json(getDb().prepare("SELECT * FROM messages WHERE is_escalation = 1 AND is_resolved = 0 ORDER BY created_at DESC").all());
});

app.patch("/api/messages/:id/resolve", (req, res) => {
  getDb().prepare("UPDATE messages SET is_resolved = 1 WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// --- Payments ---
app.get("/api/payments", (req, res) => {
  const date = req.query.date || new Date().toISOString().split("T")[0];
  res.json(getDb().prepare("SELECT * FROM payments WHERE date = ? ORDER BY property_name").all(date));
});

app.patch("/api/payments/:id", (req, res) => {
  const fields = req.body;
  const sets = Object.keys(fields).map(k => `${k} = ?`).join(", ");
  getDb().prepare(`UPDATE payments SET ${sets}, updated_at = datetime('now') WHERE id = ?`).run(...Object.values(fields), req.params.id);
  res.json({ ok: true });
});

// --- Breezeway sync ---

// --- Close-Out Workflow ---
app.post("/api/jobs/:id/close-out", async (req, res) => {
  try {
    const db = getDb();
    const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    const result = await closeout.runCloseOut(job);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Send just the completion email (without full close-out)
app.post("/api/jobs/:id/send-completion-email", async (req, res) => {
  try {
    const db = getDb();
    const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    const photos = job.bw_task_id ? await closeout.getTaskPhotos(job.bw_task_id) : [];
    const result = await closeout.sendCompletionEmail(job, photos);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Send just the completion text
app.post("/api/jobs/:id/send-completion-text", async (req, res) => {
  try {
    const db = getDb();
    const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    const result = await closeout.sendCompletionText(job);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Mark payment received from owner
app.post("/api/payments/:jobId/received", (req, res) => {
  closeout.markPaymentReceived(req.params.jobId);
  res.json({ ok: true });
});

// Mark cleaner paid
app.post("/api/payments/:jobId/cleaner-paid", (req, res) => {
  closeout.markCleanerPaid(req.params.jobId);
  res.json({ ok: true });
});

// Get all open (unpaid) payments
app.get("/api/payments/open", (req, res) => {
  res.json(closeout.getOpenPayments());
});

// Get payment summary (totals by group)
app.get("/api/payments/summary", (req, res) => {
  res.json(closeout.getPaymentSummary());
});

// --- Breezeway sync ---
app.post("/api/sync/properties", async (req, res) => {
  try { const data = await bw.syncProperties(); res.json({ count: data.length }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Debug: see raw Breezeway property API response
app.get("/api/debug/bw-properties", async (req, res) => {
  try {
    const data = await bw.bwFetch("/property/");
    const isArr = Array.isArray(data);
    const keys = isArr ? ["(array)"] : Object.keys(data || {});
    const count = isArr ? data.length : (data.results?.length || data.data?.length || "unknown");
    const sample = isArr ? data[0] : (data.results?.[0] || data.data?.[0] || data[Object.keys(data)[0]]);
    res.json({ isArray: isArr, topLevelKeys: keys, count, sampleKeys: sample ? Object.keys(sample) : [], sample: sample ? JSON.stringify(sample).substring(0, 500) : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/sync/tasks", async (req, res) => {
  try {
    const date = req.body.date || new Date().toISOString().split("T")[0];
    const count = await bw.syncTasksForDate(date);
    res.json({ count, date });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/breezeway/subscribe-webhook", async (req, res) => {
  try {
    const url = `${process.env.BASE_URL}/webhook/breezeway`;
    const result = await bw.subscribeWebhook(url);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Automation log ---
app.get("/api/auto-log", (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json(getDb().prepare("SELECT * FROM auto_log ORDER BY created_at DESC LIMIT ?").all(limit));
});

// --- Stats ---
app.get("/api/stats", (req, res) => {
  const db = getDb();
  const date = req.query.date || new Date().toISOString().split("T")[0];
  const jobs = db.prepare("SELECT * FROM jobs WHERE date = ?").all(date);
  const msgs = db.prepare("SELECT * FROM messages WHERE created_at LIKE ? AND direction = 'out'").all(date + "%");
  const escalations = db.prepare("SELECT COUNT(*) as c FROM messages WHERE is_escalation = 1 AND is_resolved = 0").get();

  res.json({
    total_jobs: jobs.length,
    closed: jobs.filter(j => j.closed).length,
    started: jobs.filter(j => j.bw_started_at).length,
    completed: jobs.filter(j => j.bw_completed_at).length,
    revenue: jobs.reduce((s, j) => s + (j.rate || 0), 0),
    messages_sent: msgs.length,
    escalations: escalations.c,
  });
});

// ═══════════════════════════════════════════════════════
// WEBHOOKS — Breezeway & Twilio
// ═══════════════════════════════════════════════════════

// Breezeway task webhook
app.post("/webhook/breezeway", async (req, res) => {
  try {
    console.log("[WEBHOOK BW]", JSON.stringify(req.body).substring(0, 200));
    const event = req.body.event || req.body.type || "";
    const taskData = req.body.task || req.body.data || req.body;

    const result = bw.handleWebhook(event, taskData);
    if (result) {
      if (result.action === "task_started") await auto.onTaskStarted(result.job);
      if (result.action === "task_completed") await auto.onTaskCompleted(result.job);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("[WEBHOOK BW] Error:", e.message);
    res.status(200).json({ ok: true }); // Always 200 to avoid retries
  }
});

// Twilio incoming SMS webhook
app.post("/webhook/twilio", async (req, res) => {
  try {
    const from = req.body.From;
    const body = req.body.Body;
    console.log("[WEBHOOK TW] From:", from, "Body:", body);

    await sms.handleIncomingSMS(from, body, req.body);

    // Return empty TwiML (acknowledge receipt, no auto-reply)
    res.type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  } catch (e) {
    console.error("[WEBHOOK TW] Error:", e.message);
    res.type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  }
});

// ═══════════════════════════════════════════════════════
// CRON JOBS — The Automation Schedule
// ═══════════════════════════════════════════════════════

// Every 5 minutes: check arrival status + poll Breezeway
cron.schedule("*/5 * * * *", async () => {
  try {
    await auto.checkArrivals();
    await auto.pollBreezewayStatus();
  } catch (e) { console.error("[CRON] Arrival check error:", e.message); }
});

// Every 15 minutes: check progress on active cleans
cron.schedule("*/15 * * * *", async () => {
  try { await auto.checkProgress(); } catch (e) { console.error("[CRON] Progress check error:", e.message); }
});

// 6:00 AM: Sync today's tasks from Breezeway
cron.schedule("0 6 * * *", async () => {
  try {
    const date = new Date().toISOString().split("T")[0];
    console.log(`[CRON] Morning sync for ${date}`);
    await bw.syncTasksForDate(date);
  } catch (e) { console.error("[CRON] Morning sync error:", e.message); }
});

// 6:00 PM: Sync tomorrow's tasks and prepare next-day comms
cron.schedule("0 18 * * *", async () => {
  try {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const date = tomorrow.toISOString().split("T")[0];
    console.log(`[CRON] Evening sync for ${date}`);
    await bw.syncTasksForDate(date);
  } catch (e) { console.error("[CRON] Evening sync error:", e.message); }
});

// ═══════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════

// Initialize DB on startup
getDb();

app.listen(PORT, () => {
  console.log(`\n🏠 HostTurn Ops running on port ${PORT}`);
  console.log(`   Dashboard: http://localhost:${PORT}`);
  console.log(`   API: http://localhost:${PORT}/api/`);
  console.log(`   BW Webhook: ${process.env.BASE_URL || "http://localhost:" + PORT}/webhook/breezeway`);
  console.log(`   Twilio Webhook: ${process.env.BASE_URL || "http://localhost:" + PORT}/webhook/twilio`);
  console.log(`\n   Cron jobs active:`);
  console.log(`   - Every 5min: Arrival checks + Breezeway poll`);
  console.log(`   - Every 15min: Progress checks`);
  console.log(`   - 6:00 AM: Sync today's tasks`);
  console.log(`   - 6:00 PM: Sync tomorrow's tasks\n`);
});
