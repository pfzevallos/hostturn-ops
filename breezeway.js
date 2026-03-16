const { getDb } = require("./db");

const BW_BASE = "https://api.breezeway.io/public";

// === TOKEN MANAGEMENT ===

async function getToken() {
  const db = getDb();
  const row = db.prepare("SELECT * FROM bw_tokens WHERE id = 1").get();

  // Token still valid (with 1hr buffer)
  if (row && row.access_token && row.expires_at > Date.now()) {
    return row.access_token;
  }

  // Try refresh
  if (row && row.refresh_token) {
    try {
      const res = await fetch(`${BW_BASE}/auth/v1/refresh`, {
        method: "POST",
        headers: { Authorization: `JWT ${row.refresh_token}`, accept: "application/json" },
      });
      if (res.ok) {
        const d = await res.json();
        saveTokens(d.access_token, d.refresh_token);
        return d.access_token;
      }
    } catch (e) {
      console.error("BW refresh failed:", e.message);
    }
  }

  // Fresh auth
  const clientId = process.env.BW_CLIENT_ID;
  const clientSecret = process.env.BW_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Missing Breezeway credentials");

  const res = await fetch(`${BW_BASE}/auth/v1/`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
  });
  if (!res.ok) throw new Error(`BW auth failed: ${res.status}`);
  const d = await res.json();
  saveTokens(d.access_token, d.refresh_token);
  return d.access_token;
}

function saveTokens(access, refresh) {
  const db = getDb();
  db.prepare(`
    INSERT INTO bw_tokens (id, access_token, refresh_token, expires_at)
    VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET access_token=?, refresh_token=?, expires_at=?
  `).run(access, refresh, Date.now() + 23 * 3600000, access, refresh, Date.now() + 23 * 3600000);
}

// === API CALLS ===

async function bwFetch(path) {
  const token = await getToken();
  const res = await fetch(`${BW_BASE}/inventory/v1${path}`, {
    headers: { Authorization: `JWT ${token}`, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`BW API ${path}: ${res.status}`);
  return res.json();
}

// Fetch and cache all properties
async function syncProperties() {
  // Fetch all pages of properties
  let allData = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages) {
    const rawData = await bwFetch("/property?limit=100&page=" + page);
    const pageResults = rawData.results || rawData.data || [];
    allData = allData.concat(pageResults);
    totalPages = rawData.total_pages || 1;
    console.log("[BW] Fetched property page " + page + "/" + totalPages + " (" + pageResults.length + " results)");
    page++;
  }
  
  let data = allData;
  
  // Filter out inactive properties
  data = data.filter(p => p.status !== "inactive");
  console.log("[BW] Total:", allData.length, "Active:", data.length, "properties");
  
  if (!data.length) return [];
  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO properties (id, name, group_name, address, beds, baths, bw_data, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET name=?, group_name=?, address=?, beds=?, baths=?, bw_data=?, updated_at=datetime('now')
  `);
  const insertMany = db.transaction(() => {
    for (const p of data) {
      const groupName = p.group_name || (p.groups && p.groups[0] && p.groups[0].name) || "";
      const address = p.address || p.address1 || "";
      const vals = [String(Math.round(p.id)), p.name || p.display || "", groupName, address, p.bedrooms || 0, p.bathrooms || 0, JSON.stringify(p)];
      upsert.run(...vals, ...vals.slice(1));
    }
  });
  insertMany();
  console.log(`[BW] Synced ${data.length} properties`);
  return data;
}

// Fetch tasks for a given date and sync to jobs table
async function syncTasksForDate(date) {
  const db = getDb();
  let props = db.prepare("SELECT * FROM properties").all();
  if (!props.length) {
    await syncProperties();
    props = db.prepare("SELECT * FROM properties").all();
  }

  const allTasks = [];
  let errorCount = 0;
  let checkedCount = 0;
  for (const prop of props) {
    try {
      const rawTasks = await bwFetch(`/task?home_id=${Math.round(prop.id)}`);
      checkedCount++;
      // Handle paginated response - tasks may be in results wrapper
      const tasks = Array.isArray(rawTasks) ? rawTasks : (rawTasks.results || rawTasks.data || rawTasks.tasks || []);
      if (Array.isArray(tasks)) {
        for (const t of tasks) {
          const taskDate = t.scheduled_date || t.deadline || "";
          if (taskDate.startsWith(date)) {
            allTasks.push({ ...t, _prop: prop });
            console.log(`[BW] Found task for ${date}: ${t.name} at ${prop.name} (assigned: ${t.assignments?.[0]?.name || 'unassigned'})`);
          }
        }
      }
    } catch (e) {
      errorCount++;
      if (errorCount <= 3) console.error(`[BW] Error fetching tasks for ${prop.name} (id:${prop.id}):`, e.message);
    }
  }
  console.log(`[BW] Task sync: checked ${checkedCount} props, ${errorCount} errors, found ${allTasks.length} tasks for ${date}`);

  // Remove stale jobs that no longer exist in Breezeway for this date
  const bwTaskIds = allTasks.map(t => t.id);
  const existingJobs = db.prepare("SELECT id, bw_task_id FROM jobs WHERE date = ?").all(date);
  for (const ej of existingJobs) {
    if (ej.bw_task_id && !bwTaskIds.includes(ej.bw_task_id)) {
      db.prepare("DELETE FROM job_steps WHERE job_id = ?").run(ej.id);
      db.prepare("DELETE FROM jobs WHERE id = ?").run(ej.id);
      console.log(`[BW] Removed stale job ${ej.id} (task ${ej.bw_task_id}) for ${date}`);
    }
  }

  // Upsert jobs
  const upsert = db.prepare(`
    INSERT INTO jobs (id, date, bw_task_id, property_id, property_name, group_name, cleaner_name,
      checkout_time, expected_arrival, rate, task_notes, bw_status, bw_started_at, bw_completed_at, is_checkout_day, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      bw_status=?, bw_started_at=?, bw_completed_at=?, task_notes=?, cleaner_name=?, updated_at=datetime('now')
  `);

  const insertMany = db.transaction(() => {
    for (const t of allTasks) {
      const existing = db.prepare("SELECT * FROM jobs WHERE bw_task_id = ?").get(t.id);
      const id = existing ? existing.id : "j" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const propDb = db.prepare("SELECT * FROM properties WHERE id = ?").get(t._prop.id);
      const cleaner = t.assignments?.[0]?.name || t.assignees?.[0]?.full_name || existing?.cleaner_name || "";
      const typeStatus = typeof t.type_task_status === 'string' ? JSON.parse(t.type_task_status || '{}') : (t.type_task_status || {});
      const status = typeStatus.name || typeStatus.code || t.status?.name || t.status?.code || "";
      const startedAt = t.started_at || existing?.bw_started_at || null;
      const completedAt = t.finished_at || t.completed_at || existing?.bw_completed_at || null;
      const desc = t.description || existing?.task_notes || "";
      const reportUrl = t.report_url || existing?.bw_report_url || null;

      // Determine expected arrival: 10am for checkout day, 9am for vacant
      const isCheckout = 1; // Default to checkout; can be refined with reservation data
      const expectedArrival = existing?.expected_arrival || (isCheckout ? "10:00" : "09:00");
      const rate = existing?.rate || propDb?.rate || 0;

      upsert.run(
        id, date, t.id, t._prop.id, t._prop.name || "", t._prop.group_name || "",
        cleaner, t.start_time || "", expectedArrival, rate, desc, status,
        startedAt, completedAt, isCheckout,
        // ON CONFLICT updates:
        status, startedAt, completedAt, desc, cleaner
      );
      
      // Save report_url and task name separately (not in upsert to keep it simple)
      if (reportUrl) {
        db.prepare("UPDATE jobs SET bw_report_url = ? WHERE id = ?").run(reportUrl, id);
      }
      if (t.name) {
        db.prepare("UPDATE jobs SET bw_task_name = ? WHERE id = ?").run(t.name, id);
      }

      // Ensure job_steps exist
      const STEPS = ["owner_confirm","cleaner_sched","morning","arrival","progress","end_verify","finishing","close_out"];
      for (const sk of STEPS) {
        db.prepare(`
          INSERT OR IGNORE INTO job_steps (id, job_id, step_key, status)
          VALUES (?, ?, ?, 'pending')
        `).run(id + "_" + sk, id, sk);
      }
    }
  });
  insertMany();

  console.log(`[BW] Synced ${allTasks.length} tasks for ${date}`);
  return allTasks.length;
}

// Handle incoming Breezeway webhook
function handleWebhook(event, taskData) {
  const db = getDb();
  console.log(`[BW Webhook] Event: ${event}`, taskData?.id);

  if (!taskData || !taskData.id) return;

  const job = db.prepare("SELECT * FROM jobs WHERE bw_task_id = ?").get(taskData.id);
  if (!job) {
    console.log(`[BW Webhook] No matching job for task ${taskData.id}`);
    return null;
  }

  // Update job based on event
  if (event === "task-started") {
    db.prepare("UPDATE jobs SET bw_status = 'started', bw_started_at = ?, updated_at = datetime('now') WHERE id = ?")
      .run(taskData.started_at || new Date().toISOString(), job.id);

    db.prepare("INSERT INTO auto_log (event, job_id, detail) VALUES (?, ?, ?)")
      .run("bw_task_started", job.id, `Cleaner ${job.cleaner_name} started at ${job.property_name}`);

    return { action: "task_started", job };
  }

  if (event === "task-completed") {
    db.prepare("UPDATE jobs SET bw_status = 'completed', bw_completed_at = ?, updated_at = datetime('now') WHERE id = ?")
      .run(taskData.completed_at || new Date().toISOString(), job.id);

    db.prepare("INSERT INTO auto_log (event, job_id, detail) VALUES (?, ?, ?)")
      .run("bw_task_completed", job.id, `Cleaner ${job.cleaner_name} completed ${job.property_name}`);

    return { action: "task_completed", job };
  }

  if (event === "task-updated" || event === "task-assignment-updated") {
    const cleaner = taskData.assignments?.[0]?.name || taskData.assignees?.[0]?.full_name || job.cleaner_name;
    const status = taskData.status?.name || taskData.status?.code || job.bw_status;
    db.prepare("UPDATE jobs SET bw_status = ?, cleaner_name = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, cleaner, job.id);
    return { action: "task_updated", job };
  }

  return null;
}

// Subscribe to Breezeway webhooks
async function subscribeWebhook(webhookUrl) {
  const token = await getToken();
  const res = await fetch(`${BW_BASE}/webhook/v1/subscribe`, {
    method: "POST",
    headers: { Authorization: `JWT ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ url: webhookUrl, webhook_type: "task" }),
  });
  const data = await res.json();
  console.log("[BW] Webhook subscription:", data);
  return data;
}

module.exports = { getToken, syncProperties, syncTasksForDate, handleWebhook, subscribeWebhook, bwFetch };
