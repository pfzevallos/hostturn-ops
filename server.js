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


// Gmail email helper - uses nodemailer with connection pooling and timeout
async function sendEmail({ to, cc, subject, text, html }) {
  const nodemailer = require("nodemailer");
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000
  });
  return transporter.sendMail({
    from: `"HostTurn" <${process.env.GMAIL_USER}>`,
    to,
    cc,
    subject,
    text,
    html
  });
}

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
  getDb().prepare("UPDATE jobs SET owner_paid_at = datetime('now') WHERE id = ?").run(req.params.jobId);
  res.json({ ok: true });
});

// Mark cleaner paid
app.post("/api/payments/:jobId/cleaner-paid", (req, res) => {
  getDb().prepare("UPDATE jobs SET cleaner_paid_at = datetime('now') WHERE id = ?").run(req.params.jobId);
  res.json({ ok: true });
});

// Undo owner payment
app.post("/api/payments/:jobId/undo-received", (req, res) => {
  getDb().prepare("UPDATE jobs SET owner_paid_at = NULL WHERE id = ?").run(req.params.jobId);
  res.json({ ok: true });
});

// Undo cleaner payment
app.post("/api/payments/:jobId/undo-cleaner-paid", (req, res) => {
  getDb().prepare("UPDATE jobs SET cleaner_paid_at = NULL WHERE id = ?").run(req.params.jobId);
  res.json({ ok: true });
});

// Update job rate manually
app.post("/api/jobs/:jobId/set-rate", (req, res) => {
  const db = getDb();
  const rate = parseFloat(req.body.rate) || 0;
  db.prepare("UPDATE jobs SET rate = ? WHERE id = ?").run(rate, req.params.jobId);
  res.json({ ok: true, rate });
});

// Update job cleaner_rate manually
app.post("/api/jobs/:jobId/set-cleaner-rate", (req, res) => {
  const db = getDb();
  const rate = parseFloat(req.body.rate) || 0;
  db.prepare("UPDATE jobs SET cleaner_rate = ? WHERE id = ?").run(rate, req.params.jobId);
  res.json({ ok: true, rate });
});

// Get payment tracker data (all finished jobs with payment status)
app.get("/api/payment-tracker", (req, res) => {
  const db = getDb();
  const startDate = req.query.start || "2026-01-01";
  const endDate = req.query.end || "2099-12-31";
  const jobs = db.prepare(`
    SELECT * FROM jobs 
    WHERE date >= ? AND date <= ? 
    AND (bw_status IN ('Finished','Closed','Completed','In Progress','Created') OR bw_status IS NOT NULL)
    ORDER BY date DESC, property_name
  `).all(startDate, endDate);
  
  // Filter out admin jobs (Pedro/Lizzy are company owners, not cleaners)
  const ADMIN_NAMES = ["pedro zevallos", "lizzy zevallos"];
  const finished = jobs.filter(j => {
    const isFinished = ['finished','closed','completed'].includes((j.bw_status||'').toLowerCase());
    const hasPaymentData = j.closeout_email_sent_at || j.owner_paid_at || j.cleaner_paid_at;
    const cleanerNorm = (j.cleaner_name||'').toLowerCase().replace(/\s+/g, ' ').trim();
    const isAdmin = ADMIN_NAMES.some(a => cleanerNorm.includes(a));
    return (isFinished || hasPaymentData) && !isAdmin;
  });
  const totalOwnerRevenue = finished.reduce((s,j) => s + (j.rate || 0), 0);
  const totalOwnerPaid = finished.filter(j => j.owner_paid_at).reduce((s,j) => s + (j.rate || 0), 0);
  const totalOwnerOpen = totalOwnerRevenue - totalOwnerPaid;
  const totalCleanerCost = finished.reduce((s,j) => s + (j.cleaner_rate || 0), 0);
  const totalCleanerPaid = finished.filter(j => j.cleaner_paid_at).reduce((s,j) => s + (j.cleaner_rate || 0), 0);
  const totalCleanerOwed = totalCleanerCost - totalCleanerPaid;
  
  res.json({ 
    jobs: finished, 
    summary: { totalOwnerRevenue, totalOwnerPaid, totalOwnerOpen, totalCleanerCost, totalCleanerPaid, totalCleanerOwed, profit: totalOwnerRevenue - totalCleanerCost }
  });
});

// Toggle owner paid/unpaid
app.post("/api/tracker/:jobId/owner-paid", (req, res) => {
  getDb().prepare("UPDATE jobs SET owner_paid_at = datetime('now') WHERE id = ?").run(req.params.jobId);
  getDb().prepare("INSERT INTO auto_log (event, job_id, detail) VALUES (?, ?, ?)").run("owner_paid", req.params.jobId, "Owner payment marked as received");
  res.json({ ok: true });
});
app.post("/api/tracker/:jobId/owner-unpaid", (req, res) => {
  getDb().prepare("UPDATE jobs SET owner_paid_at = NULL WHERE id = ?").run(req.params.jobId);
  res.json({ ok: true });
});

// Toggle cleaner paid/unpaid
app.post("/api/tracker/:jobId/cleaner-paid", (req, res) => {
  getDb().prepare("UPDATE jobs SET cleaner_paid_at = datetime('now') WHERE id = ?").run(req.params.jobId);
  getDb().prepare("INSERT INTO auto_log (event, job_id, detail) VALUES (?, ?, ?)").run("cleaner_paid", req.params.jobId, "Cleaner marked as paid");
  res.json({ ok: true });
});
app.post("/api/tracker/:jobId/cleaner-unpaid", (req, res) => {
  getDb().prepare("UPDATE jobs SET cleaner_paid_at = NULL WHERE id = ?").run(req.params.jobId);
  res.json({ ok: true });
});

// Toggle arrival confirmed
app.post("/api/jobs/:jobId/arrival-confirmed", (req, res) => {
  const db = getDb();
  const job = db.prepare("SELECT arrival_confirmed_at FROM jobs WHERE id = ?").get(req.params.jobId);
  if (job && job.arrival_confirmed_at) {
    db.prepare("UPDATE jobs SET arrival_confirmed_at = NULL WHERE id = ?").run(req.params.jobId);
  } else {
    db.prepare("UPDATE jobs SET arrival_confirmed_at = datetime('now') WHERE id = ?").run(req.params.jobId);
  }
  res.json({ ok: true });
});

// Toggle report verified
app.post("/api/jobs/:jobId/report-verified", (req, res) => {
  const db = getDb();
  const job = db.prepare("SELECT report_verified_at FROM jobs WHERE id = ?").get(req.params.jobId);
  if (job && job.report_verified_at) {
    db.prepare("UPDATE jobs SET report_verified_at = NULL WHERE id = ?").run(req.params.jobId);
  } else {
    db.prepare("UPDATE jobs SET report_verified_at = datetime('now') WHERE id = ?").run(req.params.jobId);
  }
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════
// PROPERTY MANAGEMENT (Homes)
// ═══════════════════════════════════════════════════════

// Get all properties with enhanced fields
app.get("/api/properties/all", (req, res) => {
  const db = getDb();
  const props = db.prepare("SELECT * FROM properties ORDER BY region, name").all();
  res.json(props);
});

// Update property details
app.post("/api/properties/:id/update", (req, res) => {
  const db = getDb();
  const p = req.body;
  db.prepare(`UPDATE properties SET 
    name=?, address=?, beds=?, baths=?, rate=?, deep_clean_rate=?,
    region=?, city=?, state=?, owner_manager=?, updated_at=datetime('now')
    WHERE id = ?`).run(
    p.name||'', p.address||'', p.beds||0, p.baths||0, p.rate||0, p.deep_clean_rate||0,
    p.region||'', p.city||'', p.state||'', p.owner_manager||'', req.params.id
  );
  res.json({ ok: true });
});

// Add a new manually-created property
app.post("/api/properties/add", (req, res) => {
  const db = getDb();
  const p = req.body;
  const id = "mp" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  db.prepare(`INSERT INTO properties (id, name, address, beds, baths, rate, deep_clean_rate,
    region, city, state, owner_manager, group_name, is_manual, bw_data, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, '{}', datetime('now'))`).run(
    id, p.name||'', p.address||'', p.beds||0, p.baths||0, p.rate||0, p.deep_clean_rate||0,
    p.region||'', p.city||'', p.state||'', p.owner_manager||'', p.group_name||''
  );
  res.json({ id });
});

// Delete a manually-created property
app.delete("/api/properties/:id", (req, res) => {
  const db = getDb();
  const prop = db.prepare("SELECT is_manual FROM properties WHERE id = ?").get(req.params.id);
  if (prop && prop.is_manual) {
    db.prepare("DELETE FROM properties WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } else {
    res.json({ ok: false, error: "Cannot delete Breezeway-synced properties" });
  }
});

// --- Breezeway sync ---
app.post("/api/sync/properties", async (req, res) => {
  try { const data = await bw.syncProperties(); res.json({ count: data.length }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Debug: see raw Breezeway property API response
app.get("/api/debug/bw-properties", async (req, res) => {
  try {
    const data = await bw.bwFetch("/property");
    const isArr = Array.isArray(data);
    const keys = isArr ? ["(array)"] : Object.keys(data || {});
    const count = isArr ? data.length : (data.results?.length || data.data?.length || "unknown");
    const sample = isArr ? data[0] : (data.results?.[0] || data.data?.[0] || data[Object.keys(data)[0]]);
    res.json({ isArray: isArr, topLevelKeys: keys, count, sampleKeys: sample ? Object.keys(sample) : [], sample: sample ? JSON.stringify(sample).substring(0, 500) : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get property count from local DB
app.get("/api/properties/count", (req, res) => {
  const db = getDb();
  const count = db.prepare("SELECT COUNT(*) as c FROM properties").get();
  res.json({ count: count.c });
});

// Update property rates by matching property name keywords
app.post("/api/properties/set-rates", (req, res) => {
  const db = getDb();
  const rates = req.body.rates; // { "keyword": rate, ... }
  if (!rates) return res.status(400).json({ error: "rates object required" });
  
  const props = db.prepare("SELECT * FROM properties").all();
  let updated = 0;
  
  for (const [keyword, rate] of Object.entries(rates)) {
    const kw = keyword.toLowerCase();
    for (const p of props) {
      if (p.name && p.name.toLowerCase().includes(kw)) {
        db.prepare("UPDATE properties SET rate = ? WHERE id = ?").run(rate, p.id);
        // Also update any existing jobs for this property
        db.prepare("UPDATE jobs SET rate = ? WHERE property_id = ? AND rate = 0").run(rate, p.id);
        updated++;
      }
    }
  }
  
  res.json({ updated, total_properties: props.length });
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

// --- Send schedule to cleaners ---
app.post("/api/send-schedule", async (req, res) => {
  try {
    const db = getDb();
    const date = req.body.date;
    if (!date) return res.status(400).json({ error: "date required" });
    
    // Get all jobs for the date
    const jobs = db.prepare("SELECT * FROM jobs WHERE date = ? ORDER BY cleaner_name, expected_arrival").all(date);
    if (!jobs.length) return res.json({ sent: 0, error: "No jobs for " + date });
    
    // Group by cleaner
    const byClean = {};
    for (const j of jobs) {
      const name = j.cleaner_name || "Unassigned";
      if (name === "Unassigned") continue;
      if (!byClean[name]) byClean[name] = [];
      byClean[name].push(j);
    }
    
    // Get cleaner contacts
    const contacts = db.prepare("SELECT * FROM contacts WHERE role = 'cleaner'").all();
    const results = [];
    
    for (const [cleanerName, cleanerJobs] of Object.entries(byClean)) {
      // Find contact - try exact match first, then partial
      let contact = contacts.find(c => c.name === cleanerName);
      if (!contact) contact = contacts.find(c => cleanerName.includes(c.name) || c.name.includes(cleanerName));
      
      if (!contact || !contact.phone) {
        results.push({ cleaner: cleanerName, status: "no_phone", error: "No phone number found" });
        continue;
      }
      
      // Build schedule message with friendly greeting
      const isSpanish = contact.lang === "es";
      const dateStr = new Date(date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
      
      // Get first name (use nickname if available)
      const nicknames = { "Byron Ramos": "David", "Magiber Duche": "Magiber", "Carlos Beb xol's Company": "Carlos" };
      const firstName = nicknames[cleanerName] || cleanerName.split(" ")[0];
      
      // Time-appropriate greeting
      const hour = new Date().getHours();
      let greetEn, greetEs;
      if (hour < 12) { greetEn = "Good morning"; greetEs = "Buenos días"; }
      else if (hour < 18) { greetEn = "Good afternoon"; greetEs = "Buenas tardes"; }
      else { greetEn = "Good evening"; greetEs = "Buenas noches"; }
      
      let msg;
      if (isSpanish) {
        const dateStrEs = new Date(date + "T12:00:00").toLocaleDateString("es", { weekday: "long", month: "short", day: "numeric" });
        msg = `${greetEs} ${firstName}! Tu horario de HostTurn para ${dateStrEs}:\n\n`;
        cleanerJobs.forEach((j, i) => {
          msg += `${i + 1}. ${j.property_name}\n`;
        });
        msg += `\nTotal: ${cleanerJobs.length} trabajo(s). Confirma con SI. Gracias!`;
      } else {
        msg = `${greetEn} ${firstName}! Here's your HostTurn schedule for ${dateStr}:\n\n`;
        cleanerJobs.forEach((j, i) => {
          msg += `${i + 1}. ${j.property_name}\n`;
        });
        msg += `\nTotal: ${cleanerJobs.length} job(s). Reply YES to confirm. Thanks!`;
      }
      
      try {
        await sms.sendSMS(contact.phone, msg, null, "cleaner_sched", contact.lang || "en");
        
        // Send to secondary contacts (e.g., Ines gets Carlos's schedule too)
        const SECONDARY_CONTACTS = {
          "carlos beb": "+18454077055"  // Ines (Carlos's wife)
        };
        const cleanerLower = cleanerName.toLowerCase().replace(/\s+/g, ' ').trim();
        for (const [key, secondaryPhone] of Object.entries(SECONDARY_CONTACTS)) {
          if (cleanerLower.includes(key)) {
            try {
              await sms.sendSMS(secondaryPhone, msg, null, "cleaner_sched", contact.lang || "en");
              console.log(`[SCHEDULE] Also sent to secondary contact ${secondaryPhone} for ${cleanerName}`);
            } catch (e2) {
              console.error(`[SCHEDULE] Failed to send to secondary ${secondaryPhone}:`, e2.message);
            }
          }
        }
        
        // Mark all jobs for this cleaner as schedule sent
        for (const j of cleanerJobs) {
          db.prepare("UPDATE jobs SET schedule_sent_at = datetime('now') WHERE id = ?").run(j.id);
        }
        results.push({ cleaner: cleanerName, status: "sent", phone: contact.phone, jobs: cleanerJobs.length });
      } catch (e) {
        results.push({ cleaner: cleanerName, status: "error", error: e.message });
      }
    }
    
    res.json({ sent: results.filter(r => r.status === "sent").length, total: results.length, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Send owner notifications for tomorrow's jobs ---
app.post("/api/send-owner-notifications", async (req, res) => {
  try {
    const db = getDb();
    const date = req.body.date;
    if (!date) return res.status(400).json({ error: "date required" });
    
    const jobs = db.prepare("SELECT * FROM jobs WHERE date = ? ORDER BY property_name").all(date);
    if (!jobs.length) return res.json({ sent: 0, error: "No jobs for " + date });
    
    const owners = db.prepare("SELECT * FROM contacts WHERE role = 'owner'").all();
    const results = [];
    
    for (const job of jobs) {
      if (job.owner_notified_at) {
        results.push({ property: job.property_name, status: "already_sent" });
        continue;
      }
      
      // Match owner to property using the properties field (check both property name and group name)
      let owner = null;
      for (const o of owners) {
        if (!o.properties) continue;
        const keywords = o.properties.split(",").map(function(k) { return k.trim().toLowerCase(); });
        const propLower = job.property_name.toLowerCase();
        const groupLower = (job.group_name || "").toLowerCase();
        if (keywords.some(function(k) { return propLower.includes(k) || groupLower.includes(k); })) {
          owner = o;
          break;
        }
      }
      
      if (!owner) {
        results.push({ property: job.property_name, status: "no_owner", error: "No owner matched" });
        continue;
      }
      
      const checkoutTime = job.checkout_time || "10:00 AM";
      const dateStr = new Date(date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
      const propShort = job.property_name.split(" - ")[0];
      
      // Determine if the unit is already vacant by checking task notes and Breezeway task name
      // Look for checkout dates in task_notes like "checkout March 15" or in the task name like "Out 3/15"
      const notes = (job.task_notes || "").toLowerCase();
      const taskName = (job.bw_task_name || "").toLowerCase();
      const combined = notes + " " + taskName;
      
      // Try to detect if checkout was before the cleaning date
      let isVacant = false;
      // Match patterns like "out 3/15", "checkout march 15", "check out 3/15", "out 10am 3/15"
      const datePatterns = combined.match(/(?:out|checkout|check out)[^0-9]*(\d{1,2})\/(\d{1,2})/i);
      if (datePatterns) {
        const checkoutMonth = parseInt(datePatterns[1]);
        const checkoutDay = parseInt(datePatterns[2]);
        const cleanMonth = parseInt(date.split("-")[1]);
        const cleanDay = parseInt(date.split("-")[2]);
        // If checkout date is before cleaning date, the unit is vacant
        if (checkoutMonth < cleanMonth || (checkoutMonth === cleanMonth && checkoutDay < cleanDay)) {
          isVacant = true;
        }
      }
      // Also check task_notes for "checkout March 15" style dates
      const monthNames = {"jan":1,"january":1,"feb":2,"february":2,"mar":3,"march":3,"apr":4,"april":4,"may":5,"jun":6,"june":6,"jul":7,"july":7,"aug":8,"august":8,"sep":9,"september":9,"oct":10,"october":10,"nov":11,"november":11,"dec":12,"december":12};
      const monthPattern = combined.match(/checkout\s+(\w+)\s+(\d{1,2})/i);
      if (monthPattern && monthNames[monthPattern[1].toLowerCase()]) {
        const coMonth = monthNames[monthPattern[1].toLowerCase()];
        const coDay = parseInt(monthPattern[2]);
        const cleanMonth = parseInt(date.split("-")[1]);
        const cleanDay = parseInt(date.split("-")[2]);
        if (coMonth < cleanMonth || (coMonth === cleanMonth && coDay < cleanDay)) {
          isVacant = true;
        }
      }
      // If task name contains "STANDARD CLEAN" or "DEEP CLEAN" without a date, assume it could be vacant
      if (/standard clean|deep clean|general clean/i.test(combined) && !datePatterns && !monthPattern) {
        isVacant = true; // No checkout date found, likely a maintenance/vacant clean
      }
      
      let emailSubject, emailText, emailHtml, smsMsg;
      const firstName = owner.name.split(" ")[0];
      
      if (isVacant) {
        // Vacant unit — simple notification, no ask for special instructions
        emailSubject = `HostTurn Cleaning Scheduled - ${propShort} - ${dateStr}`;
        emailText = `Hi ${firstName},\n\nJust a heads up — we have ${propShort} scheduled for cleaning on ${dateStr}.\n\nThank you!\nHostTurn Team\nhostturn.com`;
        emailHtml = `<p>Hi ${firstName},</p><p>Just a heads up — we have <strong>${propShort}</strong> scheduled for cleaning on <strong>${dateStr}</strong>.</p><p>Thank you!<br>HostTurn Team<br><a href="https://hostturn.com">hostturn.com</a></p>`;
        smsMsg = `HostTurn: Hi ${firstName}, just a heads up — we have ${propShort} scheduled for cleaning on ${dateStr}. Thank you!`;
      } else {
        // Same-day checkout — ask to confirm checkout time
        emailSubject = `HostTurn Cleaning Scheduled - ${propShort} - ${dateStr}`;
        emailText = `Hi ${firstName},\n\nWe have ${propShort} scheduled for cleaning on ${dateStr}.\n\nCan you please confirm the checkout time? If checkout is at ${checkoutTime}, no action needed.\n\nIf the checkout time is different, please reply to this email with the correct time.\n\nThank you!\nHostTurn Team\nhostturn.com`;
        emailHtml = `<p>Hi ${firstName},</p><p>We have <strong>${propShort}</strong> scheduled for cleaning on <strong>${dateStr}</strong>.</p><p>Can you please confirm the checkout time? If checkout is at <strong>${checkoutTime}</strong>, no action needed.</p><p>If the checkout time is different, please reply to this email with the correct time.</p><p>Thank you!<br>HostTurn Team<br><a href="https://hostturn.com">hostturn.com</a></p>`;
        smsMsg = `HostTurn: Hi ${firstName}, we have ${propShort} scheduled for cleaning on ${dateStr}. Can you confirm the checkout time? Reply with the time or YES if checkout is at ${checkoutTime}. Thank you!`;
      }
      
      let sentVia = [];
      
      // Send email if owner has email
      if (owner.email) {
        try {
          const ccList = [owner.cc_email, "lizzy@hostturn.com"].filter(Boolean).join(",");
          await sendEmail({
            to: owner.email,
            cc: ccList,
            subject: emailSubject,
            text: emailText,
            html: emailHtml
          });
          sentVia.push("email");
        } catch (e) {
          console.error(`[OWNER] Email failed for ${owner.name}:`, e.message);
        }
      }
      
      // Send SMS if owner has phone
      if (owner.phone) {
        try {
          await sms.sendSMS(owner.phone, smsMsg, job.id, "owner_confirm", "en");
          sentVia.push("sms");
        } catch (e) {
          console.error(`[OWNER] SMS failed for ${owner.name}:`, e.message);
        }
      }
      
      if (sentVia.length) {
        db.prepare("UPDATE jobs SET owner_notified_at = datetime('now') WHERE id = ?").run(job.id);
        db.prepare("INSERT INTO auto_log (event, job_id, detail) VALUES (?, ?, ?)")
          .run("owner_notified", job.id, `Notified ${owner.name} via ${sentVia.join("+")} about ${job.property_name}`);
        results.push({ property: job.property_name, owner: owner.name, status: "sent", via: sentVia });
      } else {
        results.push({ property: job.property_name, owner: owner.name, status: "no_contact", error: "No email or phone" });
      }
    }
    
    res.json({ sent: results.filter(function(r) { return r.status === "sent"; }).length, total: results.length, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Send close-out / completion email to owner ---
app.post("/api/send-closeout-email", async (req, res) => {
  try {
    const db = getDb();
    const jobId = req.body.job_id;
    if (!jobId) return res.status(400).json({ error: "job_id required" });
    
    const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
    if (!job) return res.status(404).json({ error: "Job not found" });
    
    // Match owner
    const owners = db.prepare("SELECT * FROM contacts WHERE role = 'owner'").all();
    let owner = null;
    for (const o of owners) {
      if (!o.properties) continue;
      const keywords = o.properties.split(",").map(function(k) { return k.trim().toLowerCase(); });
      const propLower = job.property_name.toLowerCase();
      const groupLower = (job.group_name || "").toLowerCase();
      if (keywords.some(function(k) { return propLower.includes(k) || groupLower.includes(k); })) {
        owner = o;
        break;
      }
    }
    
    if (!owner || !owner.email) {
      return res.json({ status: "no_owner_email", error: "No owner email matched for " + job.property_name });
    }
    
    const propShort = job.property_name.split(" - ")[0];
    const dateStr = new Date(job.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    const rate = job.rate || 0;
    const reportUrl = job.bw_report_url || null;
    
    const ccList = [owner.cc_email, "lizzy@hostturn.com"].filter(Boolean).join(",");
    
    let photosSection = "";
    if (reportUrl) {
      photosSection = `<p><strong>Completion Photos & Report:</strong><br><a href="${reportUrl}" style="color:#22c55e;font-weight:bold;">View Cleaning Report & Photos in Breezeway</a></p>`;
    }
    
    let paymentHtml = "";
    let paymentText = "";
    if (rate > 0) {
      paymentHtml = `
          <p><strong>Cleaning Fee: $${rate.toFixed(2)}</strong></p>
          <hr style="border:none;border-top:1px solid #ddd;margin:20px 0;">
          <p><strong>Payment Options:</strong></p>
          <p>
            <strong>Zelle:</strong> pedro@hostturn.com<br>
            <strong>Venmo:</strong> @Pedro-Zevallos
          </p>
          <p>Please remit payment at your earliest opportunity.</p>`;
      paymentText = `\nCleaning Fee: $${rate.toFixed(2)}\n\nPayment Options:\nZelle: pedro@hostturn.com\nVenmo: @Pedro-Zevallos\n\nPlease remit payment at your earliest opportunity.`;
    }
    
    const htmlBody = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#1a1d27;padding:20px;border-radius:8px 8px 0 0;">
          <h2 style="color:#22c55e;margin:0;">HostTurn — Cleaning Complete ✅</h2>
        </div>
        <div style="background:#f9f9f9;padding:24px;border-radius:0 0 8px 8px;">
          <p>Hi ${owner.name.split(" ")[0]},</p>
          <p>Great news! <strong>${propShort}</strong> has been cleaned and is guest-ready.</p>
          <p><strong>Date:</strong> ${dateStr}</p>
          ${photosSection}
          ${paymentHtml}
          <p>Thank you for the opportunity to service your home!</p>
          <p style="color:#888;font-size:12px;margin-top:24px;">
            HostTurn — Short-Term Rental Cleaning<br>
            <a href="https://hostturn.com" style="color:#22c55e;">hostturn.com</a>
          </p>
        </div>
      </div>`;
    
    const textBody = `Hi ${owner.name.split(" ")[0]},\n\nGreat news! ${propShort} has been cleaned and is guest-ready.\n\nDate: ${dateStr}\n${reportUrl ? "\nCompletion Photos & Report:\n" + reportUrl + "\n" : ""}${paymentText}\n\nThank you for the opportunity to service your home!\n\nhostturn.com`;
    
    await sendEmail({
      to: owner.email,
      cc: ccList,
      subject: `HostTurn — Cleaning Complete: ${propShort} — ${dateStr}`,
      text: textBody,
      html: htmlBody
    });
    
    db.prepare("UPDATE jobs SET closeout_email_sent_at = datetime('now') WHERE id = ?").run(job.id);
    db.prepare("INSERT INTO auto_log (event, job_id, detail) VALUES (?, ?, ?)")
      .run("closeout_email_sent", job.id, `Sent close-out email to ${owner.name} (${owner.email}) for ${job.property_name}`);
    
    res.json({ status: "sent", owner: owner.name, email: owner.email, property: job.property_name, hasReport: !!reportUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Batch send all pending close-out emails for finished jobs
app.post("/api/send-closeout-emails-batch", async (req, res) => {
  try {
    const db = getDb();
    const date = req.body.date;
    if (!date) return res.status(400).json({ error: "date required" });
    
    const jobs = db.prepare("SELECT * FROM jobs WHERE date = ? AND closeout_email_sent_at IS NULL ORDER BY property_name").all(date);
    const finishedJobs = jobs.filter(function(j) {
      var s = (j.bw_status || "").toLowerCase();
      return s === "finished" || s === "closed" || s === "completed";
    });
    
    if (!finishedJobs.length) return res.json({ sent: 0, total: 0, message: "No finished jobs without close-out emails" });
    
    const results = [];
    for (const job of finishedJobs) {
      try {
        // Match owner
        const owners = db.prepare("SELECT * FROM contacts WHERE role = 'owner'").all();
        let owner = null;
        for (const o of owners) {
          if (!o.properties) continue;
          const keywords = o.properties.split(",").map(function(k) { return k.trim().toLowerCase(); });
          const propLower = job.property_name.toLowerCase();
          const groupLower = (job.group_name || "").toLowerCase();
          if (keywords.some(function(k) { return propLower.includes(k) || groupLower.includes(k); })) { owner = o; break; }
        }
        
        if (!owner || !owner.email) {
          results.push({ property: job.property_name, status: "no_owner_email", error: "No owner email matched" });
          continue;
        }
        
        const propShort = job.property_name.split(" - ")[0];
        const dateStr = new Date(job.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
        const rate = job.rate || 0;
        const reportUrl = job.bw_report_url || null;
        
        const nodemailer = require("nodemailer");
        const ccList = [owner.cc_email, "lizzy@hostturn.com"].filter(Boolean).join(",");
        
        let photosSection = reportUrl ? `<p><strong>Completion Photos & Report:</strong><br><a href="${reportUrl}" style="color:#22c55e;font-weight:bold;">View Cleaning Report & Photos in Breezeway</a></p>` : "";
        let paymentHtml = "";
        let paymentText = "";
        if (rate > 0) {
          paymentHtml = `<p><strong>Cleaning Fee: $${rate.toFixed(2)}</strong></p><hr style="border:none;border-top:1px solid #ddd;margin:20px 0;"><p><strong>Payment Options:</strong></p><p><strong>Zelle:</strong> pedro@hostturn.com<br><strong>Venmo:</strong> @Pedro-Zevallos</p><p>Please remit payment at your earliest opportunity.</p>`;
          paymentText = `\nCleaning Fee: $${rate.toFixed(2)}\n\nPayment Options:\nZelle: pedro@hostturn.com\nVenmo: @Pedro-Zevallos\n\nPlease remit payment at your earliest opportunity.`;
        }
        
        const htmlBody = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;"><div style="background:#1a1d27;padding:20px;border-radius:8px 8px 0 0;"><h2 style="color:#22c55e;margin:0;">HostTurn — Cleaning Complete ✅</h2></div><div style="background:#f9f9f9;padding:24px;border-radius:0 0 8px 8px;"><p>Hi ${owner.name.split(" ")[0]},</p><p>Great news! <strong>${propShort}</strong> has been cleaned and is guest-ready.</p><p><strong>Date:</strong> ${dateStr}</p>${photosSection}${paymentHtml}<p>Thank you for the opportunity to service your home!</p><p style="color:#888;font-size:12px;margin-top:24px;">HostTurn — Short-Term Rental Cleaning<br><a href="https://hostturn.com" style="color:#22c55e;">hostturn.com</a></p></div></div>`;
        const textBody = `Hi ${owner.name.split(" ")[0]},\n\nGreat news! ${propShort} has been cleaned and is guest-ready.\n\nDate: ${dateStr}\n${reportUrl ? "\nCompletion Photos & Report:\n" + reportUrl + "\n" : ""}${paymentText}\n\nThank you for the opportunity to service your home!\n\nhostturn.com`;
        
        await sendEmail({
          to: owner.email,
          cc: ccList,
          subject: `HostTurn — Cleaning Complete: ${propShort} — ${dateStr}`,
          text: textBody,
          html: htmlBody
        });
        
        db.prepare("UPDATE jobs SET closeout_email_sent_at = datetime('now') WHERE id = ?").run(job.id);
        db.prepare("INSERT INTO auto_log (event, job_id, detail) VALUES (?, ?, ?)")
          .run("closeout_email_sent", job.id, `Sent close-out email to ${owner.name} (${owner.email}) for ${job.property_name}`);
        results.push({ property: job.property_name, status: "sent", owner: owner.name });
      } catch (e) {
        results.push({ property: job.property_name, status: "error", error: e.message });
      }
    }
    
    res.json({ sent: results.filter(function(r) { return r.status === "sent"; }).length, total: results.length, results });
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
// PROPERTY MANAGEMENT
// ═══════════════════════════════════════════════════════

// Get all properties with full details
app.get("/api/properties/all", (req, res) => {
  const db = getDb();
  const props = db.prepare("SELECT * FROM properties ORDER BY name").all();
  // Extract city/state from bw_data if not set
  const result = props.map(p => {
    let bw = {};
    try { bw = JSON.parse(p.bw_data || '{}'); } catch(e) {}
    return {
      ...p,
      city: p.city || bw.city || '',
      state: p.state || bw.state || '',
      beds: p.beds || bw.bedrooms || 0,
      baths: p.baths || bw.bathrooms || 0,
      address: p.address || bw.address1 || '',
      bw_data: undefined // don't send full JSON to frontend
    };
  });
  res.json(result);
});

// ═══════════════════════════════════════════════════════
// RATE CALCULATOR & PROSPECTS
// ═══════════════════════════════════════════════════════

// Get all prospects
app.get("/api/prospects", (req, res) => {
  const db = getDb();
  const prospects = db.prepare("SELECT * FROM prospects ORDER BY created_at DESC").all();
  res.json(prospects);
});

// Get single prospect
app.get("/api/prospects/:id", (req, res) => {
  const db = getDb();
  const prospect = db.prepare("SELECT * FROM prospects WHERE id = ?").get(req.params.id);
  if (!prospect) return res.status(404).json({ error: "Not found" });
  res.json(prospect);
});

// Create/update prospect
app.post("/api/prospects", (req, res) => {
  const db = getDb();
  const p = req.body;
  const id = p.id || "pr" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  
  db.prepare(`
    INSERT INTO prospects (id, property_name, total_sf, full_baths, half_baths, bedrooms, beds,
      linen_delivery, pets_allowed, adjustments, calculated_rate, deep_clean_rate, proposed_rate, status, notes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      property_name=?, total_sf=?, full_baths=?, half_baths=?, bedrooms=?, beds=?,
      linen_delivery=?, pets_allowed=?, adjustments=?, calculated_rate=?, deep_clean_rate=?,
      proposed_rate=?, status=?, notes=?, updated_at=datetime('now')
  `).run(
    id, p.property_name, p.total_sf||0, p.full_baths||0, p.half_baths||0, p.bedrooms||0, p.beds||0,
    p.linen_delivery||0, p.pets_allowed||0, p.adjustments||0, p.calculated_rate||0, p.deep_clean_rate||0,
    p.proposed_rate||0, p.status||'prospect', p.notes||'',
    // ON CONFLICT updates:
    p.property_name, p.total_sf||0, p.full_baths||0, p.half_baths||0, p.bedrooms||0, p.beds||0,
    p.linen_delivery||0, p.pets_allowed||0, p.adjustments||0, p.calculated_rate||0, p.deep_clean_rate||0,
    p.proposed_rate||0, p.status||'prospect', p.notes||''
  );
  res.json({ id });
});

// Update prospect status (won/lost)
app.post("/api/prospects/:id/status", (req, res) => {
  const db = getDb();
  db.prepare("UPDATE prospects SET status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(req.body.status, req.params.id);
  res.json({ ok: true });
});

// Delete prospect
app.delete("/api/prospects/:id", (req, res) => {
  const db = getDb();
  db.prepare("DELETE FROM prospects WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
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
