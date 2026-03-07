// ═══════════════════════════════════════════════════════
// CLOSE-OUT WORKFLOW
// Handles the full job close-out process:
// 1. Detect task completion in Breezeway
// 2. Download completion photos from Breezeway
// 3. Send completion email to owner with photos
// 4. Send completion text to owner
// 5. Track payment (open until received)
// ═══════════════════════════════════════════════════════

const { getDb } = require("./db");
const { sendStepMessage, sendSMS, fillTemplate } = require("./sms");
const { bwFetch } = require("./breezeway");

// === EMAIL CONFIG ===
// Uses Gmail SMTP via nodemailer
// Requires: GMAIL_USER and GMAIL_APP_PASSWORD in .env
// To get an App Password: Google Account → Security → 2-Step Verification → App Passwords

async function sendCompletionEmail(job, photoUrls) {
  const db = getDb();

  // Find the owner contact
  const owners = db.prepare("SELECT * FROM contacts WHERE role = 'owner'").all();
  const owner = owners.find(o =>
    (o.properties || "").split(",").some(p => p.trim() && (job.property_name || "").includes(p.trim()))
  );

  if (!owner) {
    console.error(`[CLOSE-OUT] No owner contact found for ${job.property_name}`);
    return { success: false, error: "No owner contact found" };
  }

  const ownerEmail = owner.email || owner.phone; // Fall back to phone if no email
  if (!ownerEmail || !ownerEmail.includes("@")) {
    console.error(`[CLOSE-OUT] No email for owner ${owner.name}`);
    return { success: false, error: "No email for owner" };
  }

  // Build the short address (first part of property name, e.g., "Dover, 17J Snow Tree Ln" → "17J Snow Tree Ln")
  const shortAddress = getShortAddress(job.property_name);
  const cleanDate = formatDate(job.date);
  const rate = job.rate || 0;

  // Subject line
  const subject = `Completed Clean - ${shortAddress} - ${cleanDate}`;

  // Email body (HTML)
  const htmlBody = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <p>Hi ${owner.name},</p>

      <p>We completed the clean at your lovely home today — see attached photos. All turned out well!</p>

      <p>Please send <strong>$${rate}</strong> to our Zelle account at your earliest opportunity.</p>

      <p><strong>Our Zelle account is under: pedro@hostturn.com</strong></p>

      <p>Thank you again for the opportunity to service your home.</p>

      <p>Warm regards,<br>
      <strong>HostTurn</strong><br>
      Pedro & Lizzy</p>

      ${photoUrls && photoUrls.length > 0 ? `
        <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 20px 0;">
        <p style="color: #666; font-size: 14px;"><strong>Completion Photos (${photoUrls.length}):</strong></p>
        ${photoUrls.map((url, i) => `
          <div style="margin-bottom: 10px;">
            <img src="${url}" alt="Cleaning photo ${i + 1}" style="max-width: 100%; border-radius: 8px; border: 1px solid #ddd;">
          </div>
        `).join("")}
      ` : ""}
    </div>
  `;

  // Plain text version
  const textBody = `Hi ${owner.name},

We completed the clean at your lovely home today. All turned out well!

Please send $${rate} to our Zelle account at your earliest opportunity.

Our Zelle account is under: pedro@hostturn.com

Thank you again for the opportunity to service your home.

Warm regards,
HostTurn
Pedro & Lizzy`;

  try {
    // Try sending via Gmail API through the server
    const emailResult = await sendEmailViaGmail({
      to: ownerEmail,
      subject: subject,
      html: htmlBody,
      text: textBody,
      photoUrls: photoUrls,
    });

    // Log the email
    const msgId = "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    db.prepare(`
      INSERT INTO messages (id, job_id, step_key, direction, to_phone, body, twilio_status, created_at)
      VALUES (?, ?, 'close_out_email', 'out', ?, ?, ?, datetime('now'))
    `).run(msgId, job.id, ownerEmail, `Email: ${subject}`, emailResult.success ? "sent" : "failed");

    // Update job step
    if (emailResult.success) {
      db.prepare("UPDATE job_steps SET status = 'sent', sent_at = datetime('now') WHERE job_id = ? AND step_key = 'close_out'")
        .run(job.id);

      // Mark invoice as sent in payments
      db.prepare(`
        INSERT INTO payments (id, job_id, date, property_name, group_name, rate, cleaner_name, invoice_sent, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
        ON CONFLICT(job_id) DO UPDATE SET invoice_sent = 1, updated_at = datetime('now')
      `).run("p" + Date.now().toString(36), job.id, job.date, job.property_name, job.group_name, rate, job.cleaner_name);

      db.prepare("INSERT INTO auto_log (event, job_id, detail) VALUES (?, ?, ?)")
        .run("close_out_email_sent", job.id, `Sent completion email to ${owner.name} (${ownerEmail}) for ${job.property_name}`);
    }

    console.log(`[CLOSE-OUT] Email ${emailResult.success ? "sent" : "failed"} to ${ownerEmail} for ${job.property_name}`);
    return emailResult;

  } catch (e) {
    console.error(`[CLOSE-OUT] Email error:`, e.message);
    return { success: false, error: e.message };
  }
}

// === SEND COMPLETION TEXT TO OWNER ===
async function sendCompletionText(job) {
  const db = getDb();

  const owners = db.prepare("SELECT * FROM contacts WHERE role = 'owner'").all();
  const owner = owners.find(o =>
    (o.properties || "").split(",").some(p => p.trim() && (job.property_name || "").includes(p.trim()))
  );

  if (!owner || !owner.phone) {
    console.error(`[CLOSE-OUT] No phone for owner of ${job.property_name}`);
    return { success: false, error: "No owner phone" };
  }

  const shortAddress = getShortAddress(job.property_name);
  const rate = job.rate || 0;
  const lang = owner.lang || "en";

  let body;
  if (lang === "es" || lang === "both") {
    const esBody = `Hola ${owner.name}, completamos la limpieza de su hermosa casa hoy. ¡Todo salió bien! Por favor envíe $${rate} a nuestra cuenta Zelle: pedro@hostturn.com. ¡Gracias! — HostTurn`;
    const enBody = `Hi ${owner.name}, we completed the clean at ${shortAddress} today. All turned out well! Please send $${rate} to our Zelle: pedro@hostturn.com. Thank you! — HostTurn`;
    body = lang === "both" ? enBody + "\n\n---\n\n" + esBody : esBody;
  } else {
    body = `Hi ${owner.name}, we completed the clean at ${shortAddress} today. All turned out well! Please send $${rate} to our Zelle: pedro@hostturn.com. Thank you! — HostTurn`;
  }

  const result = await sendSMS(owner.phone, body, job.id, "close_out_text", lang);

  if (result.success) {
    db.prepare("INSERT INTO auto_log (event, job_id, detail) VALUES (?, ?, ?)")
      .run("close_out_text_sent", job.id, `Sent completion text to ${owner.name} (${owner.phone})`);
  }

  return result;
}

// === GET PHOTOS FROM BREEZEWAY TASK ===
async function getTaskPhotos(bwTaskId) {
  if (!bwTaskId) return [];

  try {
    // Fetch the full task detail which includes photos
    const task = await bwFetch(`/task/${bwTaskId}`);
    if (!task) return [];

    // Photos can be in task.photos, task.requirement_photos, or task.checklist items
    const photos = [];

    // Direct task photos
    if (task.photos && Array.isArray(task.photos)) {
      for (const photo of task.photos) {
        if (photo.url || photo.photo_url || photo.image_url) {
          photos.push(photo.url || photo.photo_url || photo.image_url);
        }
      }
    }

    // Check requirement photos (from checklist items)
    if (task.requirements && Array.isArray(task.requirements)) {
      for (const req of task.requirements) {
        if (req.photos && Array.isArray(req.photos)) {
          for (const photo of req.photos) {
            if (photo.url || photo.photo_url || photo.image_url) {
              photos.push(photo.url || photo.photo_url || photo.image_url);
            }
          }
        }
      }
    }

    console.log(`[CLOSE-OUT] Found ${photos.length} photos for task ${bwTaskId}`);
    return photos;
  } catch (e) {
    console.error(`[CLOSE-OUT] Error fetching photos for task ${bwTaskId}:`, e.message);
    return [];
  }
}

// === FULL CLOSE-OUT WORKFLOW ===
// Called when a task is completed in Breezeway
async function runCloseOut(job) {
  const db = getDb();
  console.log(`[CLOSE-OUT] Starting close-out for ${job.property_name} (${job.cleaner_name})`);

  // Step 1: Get photos from Breezeway
  let photoUrls = [];
  if (job.bw_task_id) {
    photoUrls = await getTaskPhotos(job.bw_task_id);
  }

  // Step 2: Send completion email to owner with photos
  const emailResult = await sendCompletionEmail(job, photoUrls);

  // Step 3: Send completion text to owner (no photos)
  const textResult = await sendCompletionText(job);

  // Step 4: Create/update payment record (open until payment received)
  const prop = db.prepare("SELECT * FROM properties WHERE id = ?").get(job.property_id);
  db.prepare(`
    INSERT INTO payments (id, job_id, date, property_name, group_name, rate, cleaner_name, invoice_sent, owner_paid, cleaner_paid, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0, datetime('now'))
    ON CONFLICT(job_id) DO UPDATE SET invoice_sent = 1, updated_at = datetime('now')
  `).run("p" + Date.now().toString(36), job.id, job.date, job.property_name, job.group_name, job.rate || 0, job.cleaner_name);

  // Step 5: Mark the job as closed
  db.prepare("UPDATE jobs SET closed = 1, updated_at = datetime('now') WHERE id = ?").run(job.id);

  db.prepare("INSERT INTO auto_log (event, job_id, detail) VALUES (?, ?, ?)")
    .run("close_out_complete", job.id, `Close-out complete for ${job.property_name}. Email: ${emailResult.success}, Text: ${textResult.success}, Photos: ${photoUrls.length}`);

  console.log(`[CLOSE-OUT] Complete for ${job.property_name}. Email: ${emailResult.success}, Text: ${textResult.success}`);

  return {
    emailSent: emailResult.success,
    textSent: textResult.success,
    photoCount: photoUrls.length,
    paymentStatus: "open",
  };
}

// === PAYMENT TRACKING ===

function markPaymentReceived(jobId) {
  const db = getDb();
  db.prepare("UPDATE payments SET owner_paid = 1, updated_at = datetime('now') WHERE job_id = ?").run(jobId);
  db.prepare("INSERT INTO auto_log (event, job_id, detail) VALUES (?, ?, ?)").run("payment_received", jobId, "Owner payment received");
  console.log(`[PAYMENT] Marked received for job ${jobId}`);
}

function markCleanerPaid(jobId) {
  const db = getDb();
  db.prepare("UPDATE payments SET cleaner_paid = 1, updated_at = datetime('now') WHERE job_id = ?").run(jobId);
  db.prepare("INSERT INTO auto_log (event, job_id, detail) VALUES (?, ?, ?)").run("cleaner_paid", jobId, "Cleaner paid");
}

function getOpenPayments() {
  const db = getDb();
  return db.prepare("SELECT * FROM payments WHERE owner_paid = 0 ORDER BY date DESC").all();
}

function getPaymentsByDate(date) {
  const db = getDb();
  return db.prepare("SELECT * FROM payments WHERE date = ? ORDER BY property_name").all(date);
}

function getPaymentSummary() {
  const db = getDb();
  const total = db.prepare("SELECT COUNT(*) as c, SUM(rate) as total FROM payments WHERE owner_paid = 0").get();
  const byGroup = db.prepare(`
    SELECT group_name, COUNT(*) as jobs, SUM(rate) as total
    FROM payments WHERE owner_paid = 0
    GROUP BY group_name ORDER BY total DESC
  `).all();
  return { totalOwed: total.total || 0, openJobs: total.c || 0, byGroup };
}

// === GMAIL SENDING ===
// Uses Gmail SMTP via fetch to Google's API
// Requires GMAIL_USER and GMAIL_APP_PASSWORD in .env

async function sendEmailViaGmail({ to, subject, html, text, photoUrls }) {
  const user = process.env.GMAIL_USER;
  const appPassword = process.env.GMAIL_APP_PASSWORD;

  if (!user || !appPassword) {
    // Fallback: use nodemailer if available, otherwise log and skip
    console.log(`[EMAIL] Gmail not configured. Would send to ${to}: ${subject}`);
    return { success: false, error: "Gmail not configured. Set GMAIL_USER and GMAIL_APP_PASSWORD in .env" };
  }

  try {
    // Build email with MIME format
    const boundary = "boundary_" + Date.now().toString(36);

    let emailParts = [];
    emailParts.push(`From: HostTurn <${user}>`);
    emailParts.push(`To: ${to}`);
    emailParts.push(`Subject: ${subject}`);
    emailParts.push(`MIME-Version: 1.0`);

    if (photoUrls && photoUrls.length > 0) {
      // Multipart email with inline images
      emailParts.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
      emailParts.push("");

      // HTML body part
      emailParts.push(`--${boundary}`);
      emailParts.push(`Content-Type: text/html; charset="UTF-8"`);
      emailParts.push("");
      emailParts.push(html);

      // Photo attachments
      for (let i = 0; i < photoUrls.length; i++) {
        try {
          const photoRes = await fetch(photoUrls[i]);
          if (photoRes.ok) {
            const photoBuffer = await photoRes.arrayBuffer();
            const base64Photo = Buffer.from(photoBuffer).toString("base64");
            const contentType = photoRes.headers.get("content-type") || "image/jpeg";
            const ext = contentType.includes("png") ? "png" : "jpg";

            emailParts.push(`--${boundary}`);
            emailParts.push(`Content-Type: ${contentType}; name="photo_${i + 1}.${ext}"`);
            emailParts.push(`Content-Disposition: attachment; filename="photo_${i + 1}.${ext}"`);
            emailParts.push(`Content-Transfer-Encoding: base64`);
            emailParts.push("");
            // Split base64 into 76-char lines
            emailParts.push(base64Photo.match(/.{1,76}/g).join("\n"));
          }
        } catch (e) {
          console.error(`[EMAIL] Failed to download photo ${i + 1}:`, e.message);
        }
      }

      emailParts.push(`--${boundary}--`);
    } else {
      // Simple HTML email
      emailParts.push(`Content-Type: text/html; charset="UTF-8"`);
      emailParts.push("");
      emailParts.push(html);
    }

    const rawEmail = emailParts.join("\r\n");
    const encodedEmail = Buffer.from(rawEmail).toString("base64url");

    // Send via Gmail API
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${appPassword}`, // If using OAuth; for App Password, use SMTP instead
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw: encodedEmail }),
    });

    if (res.ok) {
      const data = await res.json();
      console.log(`[EMAIL] Sent to ${to}: ${subject} (ID: ${data.id})`);
      return { success: true, messageId: data.id };
    } else {
      // If Gmail API fails, try SMTP fallback
      return await sendEmailViaSMTP({ to, subject, html, text, photoUrls, user, appPassword });
    }
  } catch (e) {
    console.error(`[EMAIL] Error:`, e.message);
    // Try SMTP fallback
    return await sendEmailViaSMTP({ to, subject, html, text, photoUrls, user: user, appPassword });
  }
}

// SMTP fallback using basic SMTP (no external dependency)
async function sendEmailViaSMTP({ to, subject, html, text, photoUrls, user, appPassword }) {
  try {
    // Use dynamic import for nodemailer if installed
    const nodemailer = require("nodemailer");

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: user, pass: appPassword },
    });

    const attachments = [];
    if (photoUrls && photoUrls.length > 0) {
      for (let i = 0; i < photoUrls.length; i++) {
        try {
          const photoRes = await fetch(photoUrls[i]);
          if (photoRes.ok) {
            const buffer = Buffer.from(await photoRes.arrayBuffer());
            const ext = (photoRes.headers.get("content-type") || "").includes("png") ? "png" : "jpg";
            attachments.push({
              filename: `cleaning_photo_${i + 1}.${ext}`,
              content: buffer,
            });
          }
        } catch (e) {
          console.error(`[EMAIL] Failed to download photo ${i}:`, e.message);
        }
      }
    }

    const info = await transporter.sendMail({
      from: `"HostTurn" <${user}>`,
      to: to,
      subject: subject,
      text: text,
      html: html,
      attachments: attachments,
    });

    console.log(`[EMAIL SMTP] Sent to ${to}: ${subject} (ID: ${info.messageId})`);
    return { success: true, messageId: info.messageId };
  } catch (e) {
    console.error(`[EMAIL SMTP] Error:`, e.message);
    return { success: false, error: e.message };
  }
}

// === HELPERS ===

function getShortAddress(propertyName) {
  if (!propertyName) return "Property";
  // "Dover, 17J Snow Tree Ln - Venture" → "17J Snow Tree Ln"
  // "Ludlow, Kettlebrook B6 - Open Door" → "Kettlebrook B6"
  const parts = propertyName.split(",");
  if (parts.length > 1) {
    let addr = parts.slice(1).join(",").trim();
    // Remove group suffix after " - "
    const dashIdx = addr.lastIndexOf(" - ");
    if (dashIdx > 0) addr = addr.substring(0, dashIdx).trim();
    return addr || propertyName;
  }
  return propertyName;
}

function formatDate(dateStr) {
  if (!dateStr) return new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return new Date(dateStr + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

module.exports = {
  runCloseOut,
  sendCompletionEmail,
  sendCompletionText,
  getTaskPhotos,
  markPaymentReceived,
  markCleanerPaid,
  getOpenPayments,
  getPaymentsByDate,
  getPaymentSummary,
};
