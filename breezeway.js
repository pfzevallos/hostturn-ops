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
  // Fetch all properties in one call (limit=200 covers all)
  const rawData = await bwFetch("/property?limit=200");
  let allData = rawData.results || rawData.data || [];
  console.log("[BW] Fetched " + allData.length + " total properties (total_results=" + (rawData.total_results || "?") + ")");
  
  let data = allData;
  
  // Filter out inactive properties
  data = data.filter(p => p.status === "active");
  console.log("[BW] Active properties:", data.length, "of", allData.length, "total");
  
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
  
  // Remove properties from DB that are no longer active
  const activeIds = data.map(p => String(Math.round(p.id)));
  const dbProps = db.prepare("SELECT id FROM properties").all();
  for (const dbp of dbProps) {
    if (!activeIds.includes(String(dbp.id))) {
      db.prepare("DELETE FROM properties WHERE id = ?").run(dbp.id);
    }
  }
  
  console.log(`[BW] Synced ${data.length} active properties, removed ${dbProps.length - data.length} inactive`);
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
  // IMPORTANT: Never delete jobs that have been finished, invoiced, or have payment data
  const bwTaskIds = allTasks.map(t => String(parseInt(t.id, 10)));
  const existingJobs = db.prepare("SELECT * FROM jobs WHERE date = ?").all(date);
  for (const ej of existingJobs) {
    if (ej.bw_task_id) {
      const normalizedId = String(parseInt(ej.bw_task_id, 10));
      if (!bwTaskIds.includes(normalizedId)) {
        // Check if this job has meaningful data we should preserve
        const isFinished = ['finished','closed','completed'].includes((ej.bw_status||'').toLowerCase());
        const hasPaymentData = ej.owner_paid_at || ej.cleaner_paid_at || ej.closeout_email_sent_at || ej.owner_notified_at;
        const hasStarted = ej.bw_started_at || ej.bw_completed_at;
        
        if (isFinished || hasPaymentData || hasStarted) {
          console.log(`[BW] Keeping finished/paid job ${ej.id} (task ${ej.bw_task_id}) for ${date} - not deleting`);
        } else {
          db.prepare("DELETE FROM job_steps WHERE job_id = ?").run(ej.id);
          db.prepare("DELETE FROM jobs WHERE id = ?").run(ej.id);
          console.log(`[BW] Removed stale job ${ej.id} (task ${ej.bw_task_id}) for ${date}`);
        }
      }
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
      const taskIdStr = String(t.id);
      const taskIdInt = String(parseInt(t.id, 10));
      const taskIdFloat = taskIdInt + ".0";
      const existing = db.prepare("SELECT * FROM jobs WHERE date = ? AND (bw_task_id = ? OR bw_task_id = ? OR bw_task_id = ?)")
        .get(date, taskIdStr, taskIdFloat, taskIdInt);
      const id = existing ? existing.id : "j" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const propDb = db.prepare("SELECT * FROM properties WHERE id = ?").get(t._prop.id);
      let cleaner = "";
      // Filter out admin accounts — Pedro and Lizzy are company owners, not cleaners
      // Look through ALL assignments to find a real cleaner (not admin)
      const ADMIN_NAMES = ["pedro zevallos", "lizzy zevallos"];
      const allAssignments = t.assignments || t.assignees || [];
      for (const a of allAssignments) {
        const aName = (a.name || a.full_name || "").replace(/\s+/g, ' ').trim();
        const aNameLower = aName.toLowerCase();
        if (aName && !ADMIN_NAMES.some(admin => aNameLower.includes(admin))) {
          cleaner = aName;
          break;
        }
      }
      // Fall back to existing cleaner name if no non-admin assignment found
      if (!cleaner) {
        const existingName = (existing?.cleaner_name || "").toLowerCase().replace(/\s+/g, ' ').trim();
        if (existingName && !ADMIN_NAMES.some(admin => existingName.includes(admin))) {
          cleaner = existing.cleaner_name;
        }
      }
      const typeStatus = typeof t.type_task_status === 'string' ? JSON.parse(t.type_task_status || '{}') : (t.type_task_status || {});
      const status = typeStatus.name || typeStatus.code || t.status?.name || t.status?.code || "";
      const startedAt = t.started_at || existing?.bw_started_at || null;
      const completedAt = t.finished_at || t.completed_at || existing?.bw_completed_at || null;
      const desc = t.description || existing?.task_notes || "";
      const reportUrl = t.report_url || existing?.bw_report_url || null;

      // Determine expected arrival: 10am for checkout day, 9am for vacant
      const isCheckout = 1; // Default to checkout; can be refined with reservation data
      const expectedArrival = existing?.expected_arrival || (isCheckout ? "10:00" : "09:00");
      
      // Rate lookup table from Rate Sheet
      const RATE_TABLE = {
        "bridgewater, 732 bridgewater center rd": 400,
        "dorset, 109 nichols hill lane": 300,
        "dover, 185 tanglewood 56b": 280,
        "dover, 2320 lower dover": 380,
        "dover, 6 johnson hill": 300,
        "jamaica, 20 jamie ln": 450,
        "killington - 5983 us rt. 4": 185,
        "killington, 49 timberline rd n": 275,
        "killington, 163 lakewood dr": 450,
        "londonderry, 23 hemlock dr": 330,
        "ludlow, 147 deerfield rd": 365,
        "ludlow, 18 high street": 410,
        "ludlow, okemo mtn lodge a303": 140,
        "ludlow, okemo mtn lodge a309": 140,
        "monkton, 1387 monkton rd": 180,
        "mt holly, 148 belmont rd": 250,
        "mt holly, 4261 vt-103": 135,
        "peru, 127 sap bucket": 280,
        "rutland - 122 oak st": 200,
        "stratton - 2b stratton springs rd": 300,
        "stratton, 653 stratton arlington rd": 235,
        "stratton, 761 stratton mt rd": 170,
        "wilmington, 17 cornell way": 150,
        "wilmington, 8 splatter foot": 210,
        "winhall, 44 hilltop rd": 400,
        "ludlow - 8 andover st": 285,
        "west dover, 255 valley view rd": 300,
        "wardsboro, 704 fay boyden rd": 350,
        "jamaica, 1 benson fuller dr": 400,
        "jamaica, 32 benson fuller dr": 400,
        "dover - 24 bluebrook rd": 450,
        "winhall - 65 lower taylor hill": 365,
        "winhall - 57 garden loop rd": 365,
        "ludlow, winterplace": 140,
        "ludlow, trailside": 140,
        "ludlow, kettlebrook": 140,
        "ludlow, solitude": 140,
        "ludlow, ledgewood": 140,
        "ludlow, brookhaven": 140,
        "ludlow, mill 303": 140,
        "ludlow, 30 pond st": 140,
        "ludlow, 31 lake pauline": 140,
        "ludlow, 21 blue ridge": 140,
        "ludlow, 183 upper crossroad": 140,
        "ludlow, 25 trailside rd": 140,
        "ludlow, bixby house": 140,
        "ludlow, 598 east lake rd": 140,
        "dover, 17j snow tree ln": 280,
        "wilmington, 1 darrah loop": 210,
        "wilmington, 84 mowing": 210,
        "wilmington, 43 winter haven": 210,
        "wilmington, 87 elwell heights": 210,
      };
      
      // Look up rate by matching property name
      let rate = existing?.rate || 0;
      if (!rate) {
        const propNameLower = (t._prop.name || "").toLowerCase();
        for (const [key, val] of Object.entries(RATE_TABLE)) {
          if (propNameLower.includes(key)) {
            rate = val;
            break;
          }
        }
      }
      if (!rate) rate = propDb?.rate || 0;

      upsert.run(
        id, date, String(parseInt(t.id, 10)), String(Math.round(t._prop.id)), t._prop.name || "", t._prop.group_name || "",
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
      
      // Cleaner rate lookup - maps property keyword + cleaner name to pay rate
      const CLEANER_RATES = {
        "leyner": {
          "185 tanglewood": 165, "2320 lower dover": 250, "6 johnson hill": 200,
          "20 jamie ln": 250, "5983 us rt. 4": 135, "49 timberline": 150,
          "23 hemlock": 190, "18 high street": 190, "okemo mtn lodge a303": 85,
          "okemo mtn lodge a309": 85, "1387 monkton": 160, "4261 vt-103": 85,
          "127 sap bucket": 145, "122 oak st": 128, "2b stratton springs": 170,
          "653 stratton arlington": 150, "761 stratton mt rd": 95,
          "17 cornell way": 100, "8 splatter foot": 145, "44 hilltop": 195,
          "704 fay boyden": 200, "1 benson fuller": 290, "32 benson fuller": 270,
          "long trail house 458": 130
        },
        "paola": {
          "185 tanglewood": 165, "2320 lower dover": 250, "6 johnson hill": 200,
          "20 jamie ln": 250, "5983 us rt. 4": 135, "49 timberline": 150,
          "23 hemlock": 190, "18 high street": 190, "okemo mtn lodge a303": 85,
          "okemo mtn lodge a309": 85, "1387 monkton": 160, "4261 vt-103": 85,
          "127 sap bucket": 145, "122 oak st": 128, "2b stratton springs": 170,
          "653 stratton arlington": 150, "761 stratton mt rd": 95,
          "17 cornell way": 100, "8 splatter foot": 145, "44 hilltop": 195,
          "704 fay boyden": 200, "1 benson fuller": 290, "32 benson fuller": 270,
          "long trail house 458": 130
        },
        "byron ramos": {
          "185 tanglewood": 160, "6 johnson hill": 140, "23 hemlock": 190,
          "147 deerfield": 185, "18 high street": 190, "4261 vt-103": 100,
          "127 sap bucket": 150, "653 stratton arlington": 150, "761 stratton mt rd": 95,
          "17 cornell way": 100, "8 splatter foot": 140, "8 andover st": 180,
          "255 valley view": 190
        },
        "magiber duche": {
          "5983 us rt. 4": 135, "okemo mtn lodge a303": 85,
          "127 sap bucket": 140, "2b stratton springs": 120,
          "653 stratton arlington": 110
        },
        "christian": {
          "okemo mtn lodge a309": 80
        }
      };
      
      // Look up cleaner rate
      const cleanerNameLower = (cleaner || "").toLowerCase().trim().replace(/\s+/g, ' ');
      const propNameLower2 = (t._prop.name || "").toLowerCase();
      let cleanerRate = 0;
      if (cleanerNameLower) {
        const cleanerRates = CLEANER_RATES[cleanerNameLower];
        if (cleanerRates) {
          for (const [key, val] of Object.entries(cleanerRates)) {
            if (propNameLower2.includes(key)) {
              cleanerRate = val;
              break;
            }
          }
        }
        // Also check "paola" rates for "leyner" (same rates)
        if (!cleanerRate && cleanerNameLower === "paola") {
          const leynerRates = CLEANER_RATES["leyner"];
          if (leynerRates) {
            for (const [key, val] of Object.entries(leynerRates)) {
              if (propNameLower2.includes(key)) {
                cleanerRate = val;
                break;
              }
            }
          }
        }
      }
      if (cleanerRate) {
        db.prepare("UPDATE jobs SET cleaner_rate = ? WHERE id = ?").run(cleanerRate, id);
        console.log(`[BW] Cleaner rate for ${cleaner} at ${t._prop.name}: $${cleanerRate}`);
      } else if (cleaner) {
        console.log(`[BW] No cleaner rate found for "${cleanerNameLower}" at "${propNameLower2}"`);
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
