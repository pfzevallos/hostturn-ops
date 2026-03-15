const { getDb } = require("./db");

// === SEND SMS ===

async function sendSMS(to, body, jobId, stepKey, lang) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const auth = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;

  if (!sid || !auth || !from) throw new Error("Twilio credentials not configured");
  if (!to) throw new Error("No recipient phone number");

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${sid}:${auth}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
  });

  const data = await res.json();
  const db = getDb();

  const msgId = "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  db.prepare(`
    INSERT INTO messages (id, job_id, step_key, direction, to_phone, from_phone, body, lang_sent, twilio_sid, twilio_status, created_at)
    VALUES (?, ?, ?, 'out', ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(msgId, jobId || null, stepKey || null, to, from, body, lang || "en", data.sid || null, data.status || "failed");

  if (data.sid) {
    console.log(`[SMS] Sent to ${to}: ${body.substring(0, 50)}...`);
    // Update job step if applicable
    if (jobId && stepKey) {
      db.prepare("UPDATE job_steps SET status = 'sent', sent_at = datetime('now'), message_id = ? WHERE job_id = ? AND step_key = ?")
        .run(msgId, jobId, stepKey);
    }
    return { success: true, sid: data.sid, msgId };
  } else {
    console.error(`[SMS] Failed to ${to}:`, data.message);
    return { success: false, error: data.message };
  }
}

// === TEMPLATE FILL ===

function fillTemplate(stepKey, job, lang, extras) {
  const db = getDb();
  const tpl = db.prepare("SELECT body FROM templates WHERE step_key = ? AND lang = ?").get(stepKey, lang || "en");
  if (!tpl) return null;

  let text = tpl.body;
  text = text.replace(/\{\{property\}\}/g, job.property_name || "");
  text = text.replace(/\{\{cleaner\}\}/g, job.cleaner_name || "");
  text = text.replace(/\{\{owner\}\}/g, extras?.ownerName || job.group_name || "");
  text = text.replace(/\{\{checkout_time\}\}/g, formatTime(job.checkout_time));
  text = text.replace(/\{\{expected_arrival\}\}/g, formatTime(job.expected_arrival));
  text = text.replace(/\{\{finish_by\}\}/g, formatTime(job.finish_by) || "4:00 PM");
  text = text.replace(/\{\{rate\}\}/g, String(job.rate || 0));
  text = text.replace(/\{\{property_notes\}\}/g, job.property_notes || job.task_notes || "No special notes");
  text = text.replace(/\{\{prev_property\}\}/g, extras?.prevProperty || "");

  // Job list for cleaner schedule
  if (text.includes("{{job_list}}")) {
    const cleanerJobs = db.prepare("SELECT * FROM jobs WHERE date = ? AND cleaner_name = ? ORDER BY expected_arrival")
      .all(job.date, job.cleaner_name);
    const list = cleanerJobs.map((j, i) =>
      `${i + 1}. ${j.property_name} — CO: ${formatTime(j.checkout_time)} — $${j.rate || 0}`
    ).join("\n");
    text = text.replace(/\{\{job_list\}\}/g, list);
  }

  return text;
}

// Send bilingual message: sends in cleaner's preferred language
async function sendStepMessage(stepKey, job, extras) {
  const db = getDb();
  const step = STEPS_CONFIG[stepKey];
  if (!step) return { success: false, error: "Unknown step" };

  // Find contact to determine language and phone
  let contact;
  if (step.audience === "cleaner") {
    contact = db.prepare("SELECT * FROM contacts WHERE name = ? AND role = 'cleaner'").get(job.cleaner_name);
  } else if (step.audience === "owner") {
    // Match owner by property keywords
    const owners = db.prepare("SELECT * FROM contacts WHERE role = 'owner'").all();
    contact = owners.find(o => (o.properties || "").split(",").some(p => p.trim() && (job.property_name || "").includes(p.trim())));
  } else {
    // admin — send to admin phones
    return sendToAdmin(stepKey, job, extras);
  }

  if (!contact || !contact.phone) {
    return { success: false, error: `No phone for ${step.audience}: ${step.audience === "cleaner" ? job.cleaner_name : job.group_name}` };
  }

  // Determine language
  const lang = contact.lang || "en";
  let body;
  if (lang === "both") {
    // Send English + Spanish in one message
    const en = fillTemplate(stepKey, job, "en", extras);
    const es = fillTemplate(stepKey, job, "es", extras);
    body = en + "\n\n---\n\n" + es;
  } else {
    body = fillTemplate(stepKey, job, lang, extras);
  }

  if (!body) return { success: false, error: `No template for ${stepKey}/${lang}` };

  return sendSMS(contact.phone, body, job.id, stepKey, lang);
}

async function sendToAdmin(stepKey, job, extras) {
  const body = fillTemplate(stepKey, job, "en", extras);
  const results = [];
  for (const envKey of ["ADMIN_PHONE", "ADMIN_PHONE_2"]) {
    const phone = process.env[envKey];
    if (phone) {
      results.push(await sendSMS(phone, body, job.id, stepKey, "en"));
    }
  }
  return results;
}

// === INCOMING SMS HANDLER ===

async function handleIncomingSMS(from, body, twilioData) {
  const db = getDb();
  console.log(`[SMS IN] From ${from}: ${body}`);

  // Log the incoming message
  const msgId = "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  db.prepare(`
    INSERT INTO messages (id, direction, from_phone, to_phone, body, twilio_sid, twilio_status, created_at)
    VALUES (?, 'in', ?, ?, ?, ?, 'received', datetime('now'))
  `).run(msgId, from, process.env.TWILIO_PHONE_NUMBER, body, twilioData?.MessageSid || null);

  // Find which cleaner/owner this is
  const contact = db.prepare("SELECT * FROM contacts WHERE phone = ?").get(from);
  if (!contact) {
    console.log(`[SMS IN] Unknown sender: ${from}`);
    // Forward to admin
    await escalateToAdmin(`Unknown number ${from} texted: "${body}"`);
    return { action: "unknown_sender" };
  }

  // Find their active job(s) today
  const today = new Date().toISOString().split("T")[0];
  const activeJobs = db.prepare(`
    SELECT * FROM jobs WHERE date = ? AND cleaner_name = ? AND closed = 0 ORDER BY expected_arrival
  `).all(today, contact.name);

  // Analyze the reply
  const analysis = await analyzeReply(body, contact, activeJobs);

  db.prepare("INSERT INTO auto_log (event, detail) VALUES (?, ?)")
    .run("sms_received", JSON.stringify({ from, body, contact: contact.name, analysis }));

  // If it's a problem/delay, escalate
  if (analysis.isIssue || analysis.isDelay) {
    const activeJob = activeJobs.find(j => j.bw_status === "started") || activeJobs[0];
    const escalationMsg = `⚠️ ${contact.name} (${contact.role}) replied about ${activeJob?.property_name || "unknown property"}:\n\n"${body}"\n\nAnalysis: ${analysis.summary}`;
    await escalateToAdmin(escalationMsg);

    // Update the incoming message as escalation
    db.prepare("UPDATE messages SET is_escalation = 1, job_id = ? WHERE id = ?")
      .run(activeJob?.id || null, msgId);

    return { action: "escalated", analysis };
  }

  // If it's a confirmation, mark their upcoming jobs as confirmed
  if (analysis.isConfirmation) {
    console.log(`[SMS IN] Confirmation from ${contact.name}: ${body}`);
    // Check tomorrow's jobs first, then today's
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowDate = tomorrow.toISOString().split("T")[0];
    const tomorrowJobs = db.prepare(
      "SELECT * FROM jobs WHERE date = ? AND cleaner_name = ? AND schedule_sent_at IS NOT NULL AND confirmed_at IS NULL"
    ).all(tomorrowDate, contact.name);
    
    if (tomorrowJobs.length) {
      for (const j of tomorrowJobs) {
        db.prepare("UPDATE jobs SET confirmed_at = datetime('now') WHERE id = ?").run(j.id);
      }
      console.log(`[SMS IN] Marked ${tomorrowJobs.length} tomorrow jobs as confirmed for ${contact.name}`);
    } else {
      // Check today's jobs
      const todayJobs2 = db.prepare(
        "SELECT * FROM jobs WHERE date = ? AND cleaner_name = ? AND schedule_sent_at IS NOT NULL AND confirmed_at IS NULL"
      ).all(today, contact.name);
      for (const j of todayJobs2) {
        db.prepare("UPDATE jobs SET confirmed_at = datetime('now') WHERE id = ?").run(j.id);
      }
    }
    return { action: "confirmed", analysis };
  }

  return { action: "logged", analysis };
}

// Analyze reply using Claude API (or simple keyword matching as fallback)
async function analyzeReply(body, contact, activeJobs) {
  const lowerBody = body.toLowerCase().trim();

  // Simple keyword matching (works without Claude API)
  const confirmWords = ["yes", "ok", "confirmed", "on my way", "heading out", "ready", "sí", "si", "listo", "lista", "confirmado", "en camino", "👍", "10-4", "copy"];
  const delayWords = ["late", "delay", "running late", "traffic", "stuck", "problem", "can't", "cannot", "issue", "tarde", "retraso", "problema", "no puedo", "tráfico"];
  const issueWords = ["broken", "damage", "water", "leak", "emergency", "pipe", "flood", "roto", "daño", "agua", "fuga", "emergencia", "inundación"];

  const isConfirmation = confirmWords.some(w => lowerBody.includes(w));
  const isDelay = delayWords.some(w => lowerBody.includes(w));
  const isIssue = issueWords.some(w => lowerBody.includes(w));

  let summary = isConfirmation ? "Cleaner confirmed" : isDelay ? "Possible delay reported" : isIssue ? "Issue reported at property" : "General message";

  // Try Claude API for more nuanced analysis
  if (process.env.ANTHROPIC_API_KEY && (isDelay || isIssue || (!isConfirmation && body.length > 20))) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 200,
          messages: [{ role: "user", content: `You are analyzing an SMS reply from a cleaning crew member. Classify this reply and respond with JSON only: {"isConfirmation": bool, "isDelay": bool, "isIssue": bool, "severity": "low"|"medium"|"high", "summary": "brief description"}\n\nContext: ${contact.name} is a ${contact.role}. They have ${activeJobs.length} jobs today.\n\nTheir reply: "${body}"` }],
        }),
      });
      const d = await res.json();
      const text = d.content?.[0]?.text || "";
      try {
        const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
        return parsed;
      } catch (e) { /* fall through to simple analysis */ }
    } catch (e) {
      console.error("[Claude API] Analysis failed:", e.message);
    }
  }

  return { isConfirmation, isDelay, isIssue, severity: isIssue ? "high" : isDelay ? "medium" : "low", summary };
}

async function escalateToAdmin(message) {
  const phones = [process.env.ADMIN_PHONE, process.env.ADMIN_PHONE_2].filter(Boolean);
  for (const phone of phones) {
    await sendSMS(phone, message, null, null, "en");
  }
  console.log("[ESCALATION]", message);
}

// === STEP CONFIG ===
const STEPS_CONFIG = {
  owner_confirm: { audience: "owner", phase: "prep" },
  cleaner_sched: { audience: "cleaner", phase: "prep" },
  morning: { audience: "cleaner", phase: "morning" },
  arrival: { audience: "cleaner", phase: "active" },
  arrival_started: { audience: "cleaner", phase: "active" },
  arrival_late: { audience: "cleaner", phase: "active" },
  arrival_next_job: { audience: "cleaner", phase: "active" },
  arrival_next_late: { audience: "cleaner", phase: "active" },
  progress: { audience: "cleaner", phase: "active" },
  end_verify: { audience: "cleaner", phase: "active" },
  finishing: { audience: "admin", phase: "closeout" },
  close_out: { audience: "owner", phase: "closeout" },
};

function formatTime(t) {
  if (!t) return "TBD";
  const [h, m] = t.split(":");
  const hr = +h;
  return `${hr > 12 ? hr - 12 : hr || 12}:${m} ${hr >= 12 ? "PM" : "AM"}`;
}

module.exports = { sendSMS, sendStepMessage, fillTemplate, handleIncomingSMS, escalateToAdmin, STEPS_CONFIG };
