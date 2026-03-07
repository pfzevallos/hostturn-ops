# HostTurn Ops — Cleaning Business Automation

Automated operations center for HostTurn cleaning business.
Integrates Breezeway (task management) + Twilio (SMS) with smart arrival logic.

## What It Does

### Batch Messages (sent on schedule)
- **Owner Confirm** — Night before, texts owners to confirm checkout time
- **Cleaner Schedule** — Night before, texts each cleaner their full schedule
- **Morning Check** — 7am, confirms cleaners are on track

### Smart Arrival Logic (event-driven)
- **Arrival Text 1** — When cleaner presses START in Breezeway → auto-sends confirmation + property reminders
- **Arrival Text 2** — If expected time passes with no START → auto-texts "where are you?"
- **Multi-job chaining** — When cleaner completes Job A → auto-reminds about Job B. If 60+ min pass without starting Job B → escalation text to you
- **Default expected times**: 10am (checkout day), 9am (vacant) — overridable per job

### Progress & Close-Out
- **Progress Text** — Sent 30min after cleaner starts (only when Breezeway shows "started")
- **End Verify** — Auto-sent when cleaner marks task complete in Breezeway
- **Close Out** — Invoice/completion to owner with rate

### Incoming SMS + Escalation
- Reads cleaner replies via Twilio webhook
- Analyzes for confirmation vs. delay vs. issue (keyword matching + optional Claude AI)
- Escalates problems to you & Lizzy's phones immediately

### Bilingual
- All templates in English AND Spanish
- Per-cleaner language preference (en, es, or both)

## Setup

### 1. Clone and install
```bash
npm install
cp .env.example .env
```

### 2. Fill in .env
- **Breezeway**: Get API credentials from https://developer.breezeway.io/docs/obtaining-credentials
- **Twilio**: Get Account SID, Auth Token, and a phone number from https://console.twilio.com
- **BASE_URL**: Your deployed URL (needed for webhooks)

### 3. Run locally
```bash
npm start
```
Dashboard at http://localhost:3000

### 4. Deploy to Railway
```bash
# Install Railway CLI
npm install -g @railway/cli
railway login
railway init
railway up
```
Or push to GitHub and connect the repo in Railway dashboard.

### 5. Configure webhooks
After deploying, set up the webhook URLs:

**Breezeway**: Go to dashboard and run:
```
POST /api/breezeway/subscribe-webhook
```
This subscribes `{BASE_URL}/webhook/breezeway` to task events.

**Twilio**: In Twilio Console → Phone Numbers → your number → Messaging:
- Set "A message comes in" webhook to: `{BASE_URL}/webhook/twilio`
- Method: POST

### 6. Add contacts
Via dashboard or API:
```
POST /api/contacts
{
  "name": "Leyner",
  "phone": "+1234567890",
  "role": "cleaner",
  "lang": "es"
}
```

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/jobs?date=YYYY-MM-DD | Get jobs for date |
| POST | /api/jobs | Create manual job |
| POST | /api/jobs/:id/send/:step | Send step message for job |
| POST | /api/bulk-send/:step | Bulk send step to all pending |
| POST | /api/sync/tasks | Sync tasks from Breezeway |
| GET | /api/contacts | List contacts |
| POST | /api/contacts | Add contact |
| GET | /api/templates | List message templates |
| PUT | /api/templates/:step/:lang | Update template |
| GET | /api/messages?date= | Message log |
| GET | /api/messages/escalations | Unresolved escalations |
| GET | /api/stats?date= | Dashboard stats |
| GET | /api/auto-log | Automation log |

## Cron Schedule

| Interval | Task |
|----------|------|
| Every 5 min | Check arrivals + poll Breezeway status |
| Every 15 min | Progress checks on active cleans |
| 6:00 AM | Sync today's tasks from Breezeway |
| 6:00 PM | Sync tomorrow's tasks |

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  Breezeway  │────>│  HostTurn    │────>│   Twilio    │
│  (tasks)    │<────│  Server      │<────│   (SMS)     │
└─────────────┘     │              │     └─────────────┘
  webhooks          │  Express.js  │       webhooks
  API polling       │  SQLite      │       send/receive
                    │  Cron jobs   │
                    │              │     ┌─────────────┐
                    │  Smart Logic:│────>│  Claude API  │
                    │  - Arrivals  │     │  (optional)  │
                    │  - Chaining  │     │  reply       │
                    │  - Escalate  │     │  analysis    │
                    └──────────────┘     └─────────────┘
                          │
                    ┌─────┴─────┐
                    │ Dashboard │
                    │ (HTML)    │
                    └───────────┘
```
