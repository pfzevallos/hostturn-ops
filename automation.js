const { getDb } = require("./db");
const { sendStepMessage, escalateToAdmin } = require("./sms");
const { syncTasksForDate, bwFetch } = require("./breezeway");

// ═══════════════════════════════════════════════════════
// AUTOMATION ENGINE
// Runs on cron intervals to check job states and trigger messages
// ═══════════════════════════════════════════════════════

function today() { return new Date().toISOString().split("T")[0]; }
function now() { return new Date(); }
function timeStr() { const n = now(); return `${String(n.getHours()).padStart(2,"0")}:${String(n.getMinutes()).padStart(2,"0")}`; }
function minutesDiff(t1, t2) {
  // t1, t2 are "HH:MM" strings. Returns minutes between them.
  if (!t1 || !t2) return Infinity;
  const [h1, m1] = t1.split(":").map(Number);
  const [h2, m2] = t2.split(":").map(Number);
  return (h2 * 60 + m2) - (h1 * 60 + m1);
}

// === SMART ARRIVAL CHECK (runs every 5 min) ===
async function checkArrivals() {
  const db = getDb();
  const date = today();
  const currentTime = timeStr();

  console.log(`[AUTO] Checking arrivals at ${currentTime}`);

  // Get all jobs for today that aren't closed
  const jobs = db.prepare("SELECT * FROM jobs WHERE date = ? AND closed = 0 ORDER BY cleaner_name, expected_arrival").all(date);

  for (const job of jobs) {
    const arrivalStep = db.prepare("SELECT * FROM job_steps WHERE job_id = ? AND step_key = 'arrival'").get(job.id);

    // Skip if arrival already handled
    if (arrivalStep && arrivalStep.status === "sent") continue;

    // === CASE 1: Cleaner pressed START in Breezeway ===
    if (job.bw_status === "started" && job.bw_started_at) {
      // Send Arrival Text 1 (confirmation + property reminders)
      console.log(`[AUTO] Task started for ${job.cleaner_name} at ${job.property_name} — sending arrival confirmation`);
      await sendStepMessage("arrival_started", job);

      // Mark arrival step as sent
      db.prepare("UPDATE job_steps SET status = 'sent', sent_at = datetime('now') WHERE job_id = ? AND step_key = 'arrival'")
        .run(job.id);

      // Also trigger progress text after a delay (will be picked up by progress check)
      db.prepare("INSERT INTO auto_log (event, job_id, detail) VALUES (?, ?, ?)")
        .run("arrival_confirmed", job.id, `Auto-sent arrival confirmation to ${job.cleaner_name}`);
      continue;
    }

    // === CASE 2: 10:30 AM check — first job not started ===
    // Only check the cleaner's FIRST job of the day, only between 10:30-11:30 AM
    const cleanerAllJobs = jobs.filter(j => j.cleaner_name === job.cleaner_name);
    const isFirstJob = cleanerAllJobs[0]?.id === job.id;
    
    if (isFirstJob && currentTime >= "10:30" && currentTime <= "11:30" && !job.bw_started_at) {
      // Check if we already sent the late text for this job
      const lateMsg = db.prepare("SELECT * FROM messages WHERE job_id = ? AND step_key = 'arrival_late'").get(job.id);
      if (lateMsg) continue; // Already sent

      console.log(`[AUTO] 10:30 check: ${job.cleaner_name} has not started first job ${job.property_name}`);
      
      // Build a custom message based on language
      // Fuzzy match contact name (trim extra spaces, try partial match)
      const cleanerNameTrimmed = job.cleaner_name.replace(/\s+/g, ' ').trim();
      let contact = db.prepare("SELECT * FROM contacts WHERE name = ?").get(cleanerNameTrimmed);
      if (!contact) contact = db.prepare("SELECT * FROM contacts WHERE name LIKE ?").get('%' + cleanerNameTrimmed.split(' ')[0] + '%');
      
      if (!contact || !contact.phone) {
        console.error(`[AUTO] No phone found for cleaner ${job.cleaner_name}`);
        continue;
      }
      
      const isSpanish = contact?.lang === "es";
      
      let msg;
      if (cleanerAllJobs.length === 1) {
        // Single job today
        if (isSpanish) {
          msg = `HostTurn: Hola ${job.cleaner_name}, vemos que aún no has iniciado el trabajo en ${job.property_name}. Si ya estás ahí, por favor presiona INICIAR en Breezeway. Si no, avísanos a qué hora planeas llegar. ¡Gracias!`;
        } else {
          msg = `HostTurn: Hi ${job.cleaner_name}, we see you haven't started ${job.property_name} yet. If you're already there, please hit START in Breezeway. If not, let us know when you plan to arrive. Thanks!`;
        }
      } else {
        // Multiple jobs — ask which unit they're heading to first
        const jobList = cleanerAllJobs.map(function(j, i) { return (i+1) + ". " + j.property_name; }).join("\n");
        if (isSpanish) {
          msg = `HostTurn: Hola ${job.cleaner_name}, vemos que aún no has iniciado ningún trabajo hoy. Si ya estás en una propiedad, por favor presiona INICIAR en Breezeway. Si no, avísanos a qué hora planeas llegar y a cuál unidad primero.\n\nTus trabajos de hoy:\n${jobList}`;
        } else {
          msg = `HostTurn: Hi ${job.cleaner_name}, we see you haven't started any jobs yet today. If you're already at a unit, please hit START in Breezeway. If not, let us know when you plan to arrive and which unit first.\n\nYour jobs today:\n${jobList}`;
        }
      }
      
      const sms = require("./sms");
      try {
        await sms.sendSMS(contact?.phone || "", msg, job.id, "arrival_late", isSpanish ? "es" : "en");
        db.prepare("INSERT INTO auto_log (event, job_id, detail) VALUES (?, ?, ?)")
          .run("arrival_late_sent", job.id, `Sent 10:30 arrival check to ${job.cleaner_name}`);
      } catch(e) {
        console.error(`[AUTO] Failed to send arrival check to ${job.cleaner_name}:`, e.message);
      }
    }

    // === CASE 3: Multi-job chaining ===
    // If this cleaner has a PREVIOUS job that was completed, and this job hasn't started...
    const cleanerJobs = jobs.filter(j => j.cleaner_name === job.cleaner_name);
    const jobIndex = cleanerJobs.findIndex(j => j.id === job.id);

    if (jobIndex > 0) {
      const prevJob = cleanerJobs[jobIndex - 1];
      if (prevJob.bw_status === "completed" && prevJob.bw_completed_at && !job.bw_started_at) {
        // Check: has it been more than 60 minutes since previous job completed?
        const completedTime = new Date(prevJob.bw_completed_at);
        const minutesSinceComplete = (now() - completedTime) / 60000;

        if (minutesSinceComplete < 10) {
          // Just completed — send "head to next job" message
          const nextJobMsg = db.prepare("SELECT * FROM messages WHERE job_id = ? AND step_key = 'arrival_next_job'").get(job.id);
          if (!nextJobMsg) {
            console.log(`[AUTO] ${job.cleaner_name} just finished ${prevJob.property_name}, sending next-job reminder for ${job.property_name}`);
            await sendStepMessage("arrival_next_job", job, { prevProperty: prevJob.property_name });

            db.prepare("INSERT INTO auto_log (event, job_id, detail) VALUES (?, ?, ?)")
              .run("next_job_sent", job.id, `Sent next-job reminder after completing ${prevJob.property_name}`);
          }
        } else if (minutesSinceComplete >= 60) {
          // Been over an hour — send "where are you?" for next job
          const lateNextMsg = db.prepare("SELECT * FROM messages WHERE job_id = ? AND step_key = 'arrival_next_late'").get(job.id);
          if (!lateNextMsg) {
            console.log(`[AUTO] ${job.cleaner_name} finished ${prevJob.property_name} ${Math.round(minutesSinceComplete)}min ago, hasn't started ${job.property_name}`);
            await sendStepMessage("arrival_next_late", job, { prevProperty: prevJob.property_name });

            // Also escalate to admin
            await escalateToAdmin(`⚠️ ${job.cleaner_name} completed ${prevJob.property_name} over 60min ago but hasn't started ${job.property_name} yet.`);

            db.prepare("INSERT INTO auto_log (event, job_id, detail) VALUES (?, ?, ?)")
              .run("next_job_late", job.id, `Escalated: ${job.cleaner_name} hasn't started next job after 60min`);
          }
        }
      }
    }
  }
}

// === PROGRESS CHECK (runs every 15 min) ===
async function checkProgress() {
  const db = getDb();
  const date = today();
  const currentTime = timeStr();

  const jobs = db.prepare(`
    SELECT j.*, js.status as progress_status
    FROM jobs j
    LEFT JOIN job_steps js ON j.id = js.job_id AND js.step_key = 'progress'
    WHERE j.date = ? AND j.closed = 0 AND j.bw_status = 'started'
  `).all(date);

  for (const job of jobs) {
    if (job.progress_status === "sent") continue;

    // Only send progress check if cleaner has been working for at least 30 minutes
    if (job.bw_started_at) {
      const startTime = new Date(job.bw_started_at);
      const minutesWorking = (now() - startTime) / 60000;

      if (minutesWorking >= 30) {
        console.log(`[AUTO] Progress check for ${job.cleaner_name} at ${job.property_name} (${Math.round(minutesWorking)}min in)`);
        await sendStepMessage("progress", job);
        db.prepare("UPDATE job_steps SET status = 'sent', sent_at = datetime('now') WHERE job_id = ? AND step_key = 'progress'")
          .run(job.id);
      }
    }
  }
}

// === BREEZEWAY STATUS POLL (supplements webhooks — runs every 5 min) ===
async function pollBreezewayStatus() {
  const db = getDb();
  const date = today();

  // Get jobs that might have status changes
  const jobs = db.prepare("SELECT * FROM jobs WHERE date = ? AND closed = 0 AND bw_task_id IS NOT NULL").all(date);

  for (const job of jobs) {
    try {
      const taskData = await bwFetch(`/task/${job.bw_task_id}`);
      if (!taskData) continue;

      const newStatus = taskData.status?.name || taskData.status?.code || "";
      const wasStarted = !!job.bw_started_at;
      const nowStarted = !!taskData.started_at;
      const wasCompleted = !!job.bw_completed_at;
      const nowCompleted = !!taskData.completed_at;

      // Update job
      db.prepare(`
        UPDATE jobs SET bw_status = ?, bw_started_at = COALESCE(?, bw_started_at),
        bw_completed_at = COALESCE(?, bw_completed_at), updated_at = datetime('now') WHERE id = ?
      `).run(newStatus, taskData.started_at, taskData.completed_at, job.id);

      // Trigger arrival logic if status changed to started
      if (!wasStarted && nowStarted) {
        console.log(`[POLL] Detected start for ${job.cleaner_name} at ${job.property_name}`);
        // The checkArrivals() function will handle sending the message
      }

      if (!wasCompleted && nowCompleted) {
        console.log(`[POLL] Detected completion for ${job.cleaner_name} at ${job.property_name}`);
        // Trigger end-of-clean verification
        const endStep = db.prepare("SELECT * FROM job_steps WHERE job_id = ? AND step_key = 'end_verify'").get(job.id);
        if (endStep && endStep.status === "pending") {
          await sendStepMessage("end_verify", job);
          db.prepare("UPDATE job_steps SET status = 'sent', sent_at = datetime('now') WHERE job_id = ? AND step_key = 'end_verify'")
            .run(job.id);
        }
      }
    } catch (e) {
      // Silently skip — individual task fetch failures are expected
    }
  }
}

// === WEBHOOK-TRIGGERED AUTOMATION ===
// Called when we receive a Breezeway webhook event

async function onTaskStarted(job) {
  console.log(`[WEBHOOK] Task started: ${job.cleaner_name} at ${job.property_name}`);
  // Immediately send Arrival Text 1
  await sendStepMessage("arrival_started", job);
  const db = getDb();
  db.prepare("UPDATE job_steps SET status = 'sent', sent_at = datetime('now') WHERE job_id = ? AND step_key = 'arrival'")
    .run(job.id);
}

async function onTaskCompleted(job) {
  console.log(`[WEBHOOK] Task completed: ${job.cleaner_name} at ${job.property_name}`);
  const db = getDb();
  const { runCloseOut } = require("./closeout");

  // Send end-of-clean verification to cleaner
  await sendStepMessage("end_verify", job);
  db.prepare("UPDATE job_steps SET status = 'sent', sent_at = datetime('now') WHERE job_id = ? AND step_key = 'end_verify'")
    .run(job.id);

  // Run the full close-out workflow:
  // 1. Download photos from Breezeway
  // 2. Send completion email to owner with photos
  // 3. Send completion text to owner
  // 4. Create payment record (open until paid)
  // 5. Mark job as closed
  await runCloseOut(job);

  // Check if cleaner has a next job today
  const nextJob = db.prepare(`
    SELECT * FROM jobs WHERE date = ? AND cleaner_name = ? AND closed = 0 AND bw_started_at IS NULL
    AND expected_arrival > ? ORDER BY expected_arrival LIMIT 1
  `).get(job.date, job.cleaner_name, job.expected_arrival || "00:00");

  if (nextJob) {
    // Send "head to next job" message
    await sendStepMessage("arrival_next_job", nextJob, { prevProperty: job.property_name });
    db.prepare("INSERT INTO auto_log (event, job_id, detail) VALUES (?, ?, ?)")
      .run("next_job_triggered", nextJob.id, `Auto-sent after ${job.property_name} completed`);
  }
}

module.exports = {
  checkArrivals,
  checkProgress,
  pollBreezewayStatus,
  onTaskStarted,
  onTaskCompleted,
};
