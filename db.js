const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = path.join(__dirname, "data", "hostturn.db");

let db;

function getDb() {
  if (!db) {
    const fs = require("fs");
    fs.mkdirSync(path.join(__dirname, "data"), { recursive: true });
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    initTables();
  }
  return db;
}

function initTables() {
  db.exec(`
    -- Contacts: cleaners, owners, admins
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      role TEXT NOT NULL DEFAULT 'cleaner', -- cleaner, owner, admin
      lang TEXT NOT NULL DEFAULT 'en', -- en, es, both
      properties TEXT, -- comma-separated property name keywords for owner matching
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Properties cache from Breezeway
    CREATE TABLE IF NOT EXISTS properties (
      id TEXT PRIMARY KEY, -- Breezeway home_id
      name TEXT,
      group_name TEXT,
      address TEXT,
      beds INTEGER,
      baths INTEGER,
      rate REAL DEFAULT 0,
      task_notes TEXT, -- persistent property-specific notes (e.g., "take garbage")
      bw_data TEXT, -- full JSON from Breezeway
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Jobs: one per cleaning task per day
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL, -- YYYY-MM-DD
      bw_task_id TEXT, -- Breezeway task ID
      property_id TEXT,
      property_name TEXT,
      group_name TEXT,
      cleaner_id TEXT, -- FK to contacts
      cleaner_name TEXT,
      checkout_time TEXT, -- HH:MM
      expected_arrival TEXT, -- HH:MM (default 10:00 or 9:00 for vacant)
      finish_by TEXT, -- HH:MM
      rate REAL DEFAULT 0,
      task_notes TEXT, -- task-specific instructions from Breezeway
      property_notes TEXT, -- property-level persistent notes
      is_checkout_day INTEGER DEFAULT 1, -- 1 = guest checking out, 0 = already vacant
      bw_status TEXT, -- from Breezeway: committed, started, completed, etc.
      bw_started_at TEXT,
      bw_completed_at TEXT,
      closed INTEGER DEFAULT 0,
      issues TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Workflow steps per job
    CREATE TABLE IF NOT EXISTS job_steps (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      step_key TEXT NOT NULL, -- owner_confirm, cleaner_sched, morning, arrival, progress, end_verify, finishing, close_out
      status TEXT NOT NULL DEFAULT 'pending', -- pending, queued, sent, delivered, skipped
      sent_at TEXT,
      message_id TEXT, -- FK to messages
      UNIQUE(job_id, step_key)
    );

    -- Messages sent/received
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      job_id TEXT,
      step_key TEXT,
      direction TEXT NOT NULL DEFAULT 'out', -- out = we sent, in = we received
      to_phone TEXT,
      from_phone TEXT,
      body TEXT,
      body_es TEXT, -- Spanish version if applicable
      lang_sent TEXT, -- which language was actually sent
      twilio_sid TEXT,
      twilio_status TEXT,
      is_escalation INTEGER DEFAULT 0,
      is_resolved INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Payment tracking
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL UNIQUE,
      date TEXT,
      property_name TEXT,
      group_name TEXT,
      rate REAL,
      cleaner_name TEXT,
      cleaner_rate REAL,
      owner_paid INTEGER DEFAULT 0, -- has owner/PM paid us
      cleaner_paid INTEGER DEFAULT 0, -- have we paid the cleaner
      invoice_sent INTEGER DEFAULT 0,
      notes TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Message templates
    CREATE TABLE IF NOT EXISTS templates (
      step_key TEXT NOT NULL,
      lang TEXT NOT NULL DEFAULT 'en', -- en or es
      body TEXT NOT NULL,
      PRIMARY KEY (step_key, lang)
    );

    -- Automation log (audit trail)
    CREATE TABLE IF NOT EXISTS auto_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event TEXT NOT NULL, -- e.g., 'arrival_check', 'bw_webhook', 'sms_received'
      job_id TEXT,
      detail TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Breezeway token store
    CREATE TABLE IF NOT EXISTS bw_tokens (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      access_token TEXT,
      refresh_token TEXT,
      expires_at INTEGER -- unix timestamp
    );
  `);

  // Seed default templates if empty
  const count = db.prepare("SELECT COUNT(*) as c FROM templates").get().c;
  if (count === 0) {
    const ins = db.prepare("INSERT OR IGNORE INTO templates (step_key, lang, body) VALUES (?, ?, ?)");
    const tpls = [
      // ENGLISH
      ["owner_confirm", "en", "Hi {{owner}}, this is HostTurn. We have {{property}} scheduled for cleaning tomorrow. Can you confirm the checkout time is {{checkout_time}}? Thank you!"],
      ["cleaner_sched", "en", "Hi {{cleaner}}, here's your schedule for tomorrow:\n{{job_list}}\nPlease confirm you're all set!"],
      ["morning", "en", "Good morning {{cleaner}}! Confirming you're on track for today. First job: {{property}} — checkout {{checkout_time}}. Let me know when you're heading out!"],
      ["arrival_started", "en", "Great {{cleaner}}, we see you started at {{property}}! Quick reminders:\n{{property_notes}}\nLet us know if you need anything."],
      ["arrival_late", "en", "Hi {{cleaner}}, checking in — we expected you at {{property}} by {{expected_arrival}} but haven't seen a start in Breezeway yet. What's your ETA? Please update us."],
      ["arrival_next_job", "en", "Hi {{cleaner}}, great work finishing {{prev_property}}! Your next job is {{property}}. Please head over and hit START in Breezeway when you arrive."],
      ["arrival_next_late", "en", "Hi {{cleaner}}, it's been a while since you finished {{prev_property}}. Are you on your way to {{property}}? Please let us know your ETA."],
      ["progress", "en", "Hey {{cleaner}}, how's it going at {{property}}? Need to finish by {{finish_by}} to stay on schedule. Let us know if any issues!"],
      ["end_verify", "en", "{{cleaner}} — before marking {{property}} complete, please upload all photos to Breezeway. Double check: beds, bathrooms, kitchen, floors."],
      ["finishing", "en", "[Admin] Review photos for {{property}} ({{cleaner}}). Note any issues for next clean."],
      ["close_out", "en", "Hi {{owner}}, {{property}} has been cleaned and is guest-ready! Invoice: ${{rate}}. Completion photos are in Breezeway. Please remit payment at your convenience. Thank you! — HostTurn"],
      // SPANISH
      ["owner_confirm", "es", "Hola {{owner}}, somos HostTurn. Tenemos {{property}} programado para limpieza mañana. ¿Puede confirmar que la hora de salida es {{checkout_time}}? ¡Gracias!"],
      ["cleaner_sched", "es", "Hola {{cleaner}}, aquí está tu horario para mañana:\n{{job_list}}\n¡Por favor confirma que estás listo/a!"],
      ["morning", "es", "¡Buenos días {{cleaner}}! Confirmando que vas en camino. Primer trabajo: {{property}} — salida {{checkout_time}}. ¡Avísame cuando salgas!"],
      ["arrival_started", "es", "¡Perfecto {{cleaner}}, vemos que empezaste en {{property}}! Recordatorios:\n{{property_notes}}\nAvísanos si necesitas algo."],
      ["arrival_late", "es", "Hola {{cleaner}}, te esperábamos en {{property}} a las {{expected_arrival}} pero no vemos que hayas comenzado en Breezeway. ¿Cuál es tu hora estimada de llegada?"],
      ["arrival_next_job", "es", "Hola {{cleaner}}, ¡buen trabajo terminando {{prev_property}}! Tu siguiente trabajo es {{property}}. Ve hacia allá y presiona INICIAR en Breezeway al llegar."],
      ["arrival_next_late", "es", "Hola {{cleaner}}, ya pasó un rato desde que terminaste {{prev_property}}. ¿Vas camino a {{property}}? Por favor avísanos tu hora estimada."],
      ["progress", "es", "Hola {{cleaner}}, ¿cómo va en {{property}}? Necesitas terminar antes de las {{finish_by}}. ¡Avísanos si hay algún problema!"],
      ["end_verify", "es", "{{cleaner}} — antes de marcar {{property}} como completado, sube todas las fotos a Breezeway. Revisa: camas, baños, cocina, pisos."],
      ["finishing", "es", "[Admin] Revisar fotos de {{property}} ({{cleaner}}). Anotar problemas para la próxima limpieza."],
      ["close_out", "es", "Hola {{owner}}, {{property}} ha sido limpiado y está listo para huéspedes. Factura: ${{rate}}. Las fotos están en Breezeway. Por favor envíe el pago. ¡Gracias! — HostTurn"],
    ];
    const insertMany = db.transaction(() => { for (const t of tpls) ins.run(...t); });
    insertMany();
  }

  // Add new columns if they don't exist (safe migration)
  try { db.exec("ALTER TABLE jobs ADD COLUMN schedule_sent_at TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE jobs ADD COLUMN confirmed_at TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE jobs ADD COLUMN owner_notified_at TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE jobs ADD COLUMN owner_confirmed_at TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE jobs ADD COLUMN closeout_email_sent_at TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE jobs ADD COLUMN bw_report_url TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE contacts ADD COLUMN cc_email TEXT"); } catch(e) {}
}

module.exports = { getDb };
