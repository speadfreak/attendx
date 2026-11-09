# AttendX

**Intelligent attendance command center** — AI face recognition + signed QR door terminals + parent SMS alerts, with a real-time dark-purple command center UI.

![Phase](https://img.shields.io/badge/phase-5%20·%20delivery%20%2B%20risk%20radar-blueviolet) ![stack](https://img.shields.io/badge/stack-Vite%20·%20Express%20·%20Drizzle%20·%20Postgres-purple)

## What's new in Phase 5

### 📡 SMS Delivery Health (the Twilio 21612 killer)
- **Messaging Service routing**: sends through a Twilio **Messaging Service SID** (auto-detected by live diagnostics) instead of a raw US long-code `From` — the exact fix for Twilio `21612: Message cannot be sent with the current combination of 'To' and 'From'` when texting Ethiopian (+251) parents. Configurable at runtime in Operations → SMS Health (DB-backed, no redeploy) or via `TWILIO_MESSAGING_SERVICE_SID`.
- **Channel strategies**: `sms only` · `whatsapp only` · **`auto` (SMS first → WhatsApp fallback)** with per-attempt logging (`provider: twilio:whatsapp` in sms_logs).
- **Live Twilio diagnostics** (`GET /api/sms/diagnostics`): verifies credentials + balance, lists numbers & Messaging Services with pool sizes, checks real outbound pricing **for every country present in your parent phone data**, and returns prioritized FIX recommendations.
- **One-click test send** (`POST /api/sms/test-send`) runs the exact production path and surfaces provider errors with an actionable **FIX** line (20003, 21211, 21408, 21606, 21608, 21610, 21612, 21614, 63007, 63016 …).
- **E.164 normalization**: `09…`/`9…`/`00…`/`+…` inputs normalized against a configurable default country (+251) before sending.

### 🛡 Absence Risk Radar
- Explainable early-warning engine (`GET /api/analytics/absence-risk`): per-student risk score (0–100) over a rolling window from absence rate, consecutive misses, lateness, accelerating trend and "ghost" (no activity) signals — every score ships with human-readable reasons.
- Dashboard card with level counts (low/watch/elevated/critical), animated risk bars and deep links into the student database.

### 📷 QR Terminal camera controls
- Camera device picker, front/back **flip**, and LED **torch** toggle on the door terminal; selection persists per kiosk. Compact flip control also added to the attendance webcam scanner.

### 📱 Operations page, fully responsive
- Mobile-first pass across every card: collapsing grids, horizontally scrollable tables, constrained dialogs, non-colliding action rows.

## What's new in Phase 4

### 🛡 Gate Integrity Validator (sensor fusion)
- **Arduino gate firmware** (`hardware/arduino/AttendXGateValidator.ino`): HC-SR04 ultrasonic + IR break-beam pass-event detection with hysteresis + debounce, serial JSON protocol (`STATUS` / `THRESH` / `GAPU` / `GAPI` commands)
- **Pi agent ingestion**: persistent serial listener (`ATTENDX_GATE_PORT`, default `/dev/ttyACM1`), event buffering, batched `POST /api/gate/sensor-events`, offline spool via the existing outbox
- **Cross-validation engine**: epoch-aligned windows compare gate-camera vs ultrasonic vs IR counts → `missed_detections` + `sensor_conflict` alerts, deduped per (gate, window, type); runs inline after ingestion, in the daily cron recovery pass, and via manual **Run validation**
- **Operations UI**: Gate Integrity card — 3 counters, verdict badge, rolling discrepancy chart, alert list + event timeline drawer, **Simulate** (events clearly tagged `[DEMO]` everywhere) and Run buttons; new `gate` notification category

### ⏰ Admin-controlled attendance time rules
- System settings for **entrance time, late cutoff, absence cutoff + attendance timezone** (default `Africa/Addis_Ababa`) — replaces every hardcoded server-time check across face, QR, gate-camera and review-decision paths
- Timezone-correct present/late resolution with proper local-day bounds
- **Absent sweep locked** until the absence cutoff (with explicit force override)
- Operations settings UI with validation (IANA timezone + ordering `entrance ≤ late ≤ absence`)

### 📟 SMS delivery diagnostics
- Twilio API errors parsed (code + message + more_info) and **surfaced verbatim** in job errors — the root cause of silent "delivery failures" was Twilio auth errors (e.g. 20003) being swallowed
- Retryable (network / 5xx / 429) vs permanent failure classification: retryable jobs requeue up to 3 attempts, permanent failures fail fast with actionable detail

### 🎨 Branding
- Custom AttendX emblem applied across the app: sidebar/mobile emblem, favicon-32/192, apple-touch-icon — the login page keeps its original hero image (`/hero.jpg`)

## What's inside (Phase 3)

### 🎛 Design system
- Layered **glow-card** language (soft outer glow + sharp inner border) as reusable CSS tokens
- Animated **gradient mesh** backdrops on Dashboard & Operations
- System-wide **status colors**: green = present/online · amber = late/pending · red = absent/offline/failed · purple = AI/primary
- **Command palette** (`⌘K` / `Ctrl+K`): jump to any student/classroom/page, "mark … present", absent sweep
- **Notification center**: low-confidence matches, Pi offline, failed SMS jobs, QR anomalies — one bell
- On-brand **shimmer skeletons** everywhere; gradient wordmark section headers

### ⚡ Live infrastructure
- **SSE push** (`/api/events/stream`) streams attendance, Pi heartbeats, job status, QR scans & reviews
- Automatic **polling fallback** when the stream drops (serverless-friendly, no WebSocket infra)
- Dashboard **occupancy counter** — "who's in the building right now" with per-student check-out

### 🧑‍🎓 Student database
- **Bulk enrollment wizard**: CSV + folder of photos → filename auto-match → in-browser AI face descriptors → batch insert (+ optional auto QR issue)
- **Detail drawer**: GitHub-style attendance heatmap (90 days), current/longest **streaks**, face-match confidence trend, parent contact + SMS history, identity methods, seat
- Identity badges: **AI Enrolled** · **No Face** · **QR** · **No Identity** (red gap state)
- **Seating map**: drag-and-drop grid per classroom

### 🚪 QR attendance system (the door terminal)
- Every student gets a **server-signed QR badge** (`AXQR1.<payload>.<hmac>`) printable on ID cards
- **QR Terminal kiosk** (`/qr-terminal`): camera scanning, USB keyboard-wedge scanners, manual token entry, big WELCOME/ALREADY-IN/DENIED verdicts, sound feedback, live door feed + counters
- **QR Badge Manager** (`/qr-manager`): issue / whole-classroom batch / rotate / revoke / expiry passes / printable ID-card sheet / PNG download / full scan & anomaly log
- **Anti-spoof**: HMAC signatures, per-student version pinning (rotate kills old prints instantly), expiry windows, duplicate protection, forged-badge rejection — every tap logged

### 🎥 Active scan / gate camera
- **Multi-camera grid** (up to 4 feeds on one screen)
- **On-frame overlay**: matched name + confidence directly on the bounding box, color-coded by tier
- Live **FPS + frames-processed** telemetry
- **Review Queue page**: ambiguous matches with top-3 candidates, expected-seat tie-breaker hint (never auto-applied), one-click approve / reject / reassign

### 📊 Reports & analytics
- **Attendance confidence heatmap** sub-page: per-classroom → per-student drill-down
- **Branded PDF export**: gradient cover page, chart snapshots, school-wide + per-classroom tables (CSV export kept)
- Classroom monitor **today/week/month** toggle on the dashboard
- Method mix + classroom leaderboard insights

### 🛠 Admin & ops
- **SMS Template Manager**: editable present/late/absent templates with `{student_name} {time} {classroom}` variables — absent template now fully wired via end-of-day sweep
- **Audit trail viewer**: searchable/filterable log of every sensitive action (CSV export)
- **Role tiers**: super_admin (full access) · admin · teacher (view + manual marking + QR issue, no operations/admin/audit surfaces)

## Monorepo layout

```
artifacts/facetrack     React 19 + Vite + Tailwind 4 web app (the command center)
artifacts/api-server    Express 5 API (auth, attendance, QR, reviews, events, reports…)
artifacts/mockup-sandbox  Vite design-preview sandbox (served at /sandbox on Vercel)
lib/db                  Drizzle schema (students, attendance, qr_issues, seats, gate_sensor_events, gate_integrity_alerts…)
lib/api-*               OpenAPI spec + generated zod/client (legacy endpoints)
hardware/               Raspberry Pi agent + Arduino fan controller & gate validator
scripts/                seed-demo.ts — instant demo data
vercel.json             Vercel services config: facetrack @ / · api-server @ /api · sandbox @ /sandbox
```

## Local development

```sh
pnpm install
# provision postgres, then:
DATABASE_URL="postgres://…" pnpm --filter @workspace/db run push
DATABASE_URL="postgres://…" pnpm --filter @workspace/scripts exec tsx src/seed-demo.ts

# API (terminal 1)
cd artifacts/api-server && PORT=4000 DATABASE_URL="postgres://…" SESSION_SECRET="dev" pnpm run dev

# Web (terminal 2)
cd artifacts/facetrack && VITE_API_PROXY_TARGET="http://127.0.0.1:4000" pnpm run dev
```

Login: `admin@attendx.app / admin1234` (super admin) · `teacher@attendx.app / teach1234` (teacher)

## Deployment

See **[VERCEL_DEPLOYMENT.md](./VERCEL_DEPLOYMENT.md)** for the full step-by-step Vercel guide (env vars, database provisioning, Pi re-pairing).
