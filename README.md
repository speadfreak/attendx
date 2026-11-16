# AttendX

**Intelligent attendance command center** — AI face recognition + signed QR door terminals + phone/Pi gate-camera fleet + parent SMS alerts, with a real-time dark command center UI.

![Phase](https://img.shields.io/badge/phase-7%20·%20phone%2Das%2Dgate%2Dcamera%20network-blueviolet) ![stack](https://img.shields.io/badge/stack-Vite%20·%20Express%20·%20Drizzle%20·%20Postgres-purple)

## What's new in Phase 7

Full pre-build system audit with every finding + disposition: **[docs/PHASE7_AUDIT.md](docs/PHASE7_AUDIT.md)**.

### 📱 Phone-as-Gate-Camera Network (any phone becomes a paired gate camera)
- **Installable PWA camera node** at **`/camera-node`** (public route, authenticated by the paired device token — no admin login on the phone): rear camera via `facingMode: environment` with a flip toggle, full-screen kiosk HUD (wake lock, fullscreen, install prompt), and two remote-switchable modes:
  - **Face mode** — the same `@vladmandic/face-api` descriptor pipeline used client-side elsewhere; descriptors (never frames) batch-posted to the existing `POST /api/attendance/bulk-match` (device-token auth, streak + dedupe logic unchanged).
  - **QR mode** — BarcodeDetector API (html5-qrcode fallback) decoding badge tokens into the existing `POST /api/qr/scan` — which now accepts **staff JWT or paired device token**, with the device's gate geofence applied through `gates.terminal_ids`.
- **Adaptive performance + data-saver** (this is Ethiopia-critical): `navigator.connection` cellular/saveData → automatic Low profile; operator quality override (Low/Balanced/HD) pushed live from Operations and persisted server-side; data-saver halves detection rate and thumbnail frequency.
- **On-device health self-checks**: 16×12 frame downsample → near-black lens (`obstructed`) and frozen-frame hash detection (`frozen`) reported in every heartbeat and surfaced as alerts.
- **Heartbeats every 8s** with battery / FPS / resolution / connection / uptime — same rotating-token pattern as the Pi (SHA-256 hash storage, 60s grace, 15-min lifetime).
- **One still-frame thumbnail** (≤90 KB JPEG, not video) uploaded periodically so operators can visually confirm each camera is pointed at the gate.
- Manual device-side steps the web app cannot force: enable **Guided Access** (iOS) or a kiosk-lock app (Android) after installing to the home screen.

### 🗂 Unified device model (one fleet, not two systems)
- `pi_devices` **renamed to `gate_devices`** (migration `0009`, data preserved) with `device_type` (`pi` | `phone`), `mode` (`face` | `qr`), `assigned_gate_id`, `resolution`, `fps`, `health_status`, `battery_level`, `connection`, `data_saver`, `target_quality`, `thumbnail(+_at)` and a one-slot **command mailbox** (`pending_command` drained on every heartbeat — works even when SSE is unreachable).
- **Fleet pairing**: `POST /api/devices/pair` (name, type, gate, mode) issues a once-shown token; `POST /api/devices/:id/pair` re-pairs. Assigning a gate appends the device id to `gates.terminal_ids` so geofencing resolves phone scans unchanged. Legacy `/api/pi/*` endpoints keep working for the Pi.
- **Remote commands**: `POST /api/devices/:id/command` — `switch_mode`, `request_snapshot`, `disconnect`, `flashlight_toggle` (torch constraint where the phone supports it), `set_quality`, `set_data_saver` — delivered near-instantly over SSE (`device.command`) **and** the heartbeat mailbox fallback; every command is audited.
- **Daily uptime rollup**: `device_uptime_days` powers `GET /api/devices/uptime?days=7` (online-seconds per day, capped heartbeat gaps) — the "this camera keeps dying before 8am" report.

### 🎛 Operations — Camera Command Center
- New **Camera Network** card on Operations (Device health → Gate integrity → **Camera Network** → Job queue): device grid grouped by gate with live status dots (online/offline/obstructed/frozen), mode one-click toggle, thumbnails, battery/CPU-temp, FPS+resolution, quality/data-saver controls, Connect/Disconnect/Re-pair (QR pairing dialog with expiry countdown + live "first heartbeat received" detection).
- **Blind-spot auto-failover banner**: a paired gate camera that goes offline/obstructed/frozen raises `Gate {gate} camera down — switch to manual/QR fallback` in Operations **and** the Notification Center.
- **Reliability report**: per-device 7-day uptime bars + overall online % (emerald/amber/red).

### 🔌 Arduino Gate Controller Studio (`/arduino`, admin)
- **Web Serial IDE-like workbench**: auto-detects Arduino Uno family by USB VID/PID (0x2341/0x1a86 CH340 clones included), probes 115200/57600/9600, reads the STK500v1 signature (ATmega328P/32U4/2560).
- **Real one-window flashing**: hand-rolled **Intel HEX parser + STK500v1 uploader** over Web Serial (DTR auto-reset, sync loop with press-RESET retry guidance, 128-byte page programming, live progress + log console). Paste/drag a compiled `.hex` and flash — no Arduino IDE window needed.
- **Sketch library** (copy/download `.ino`): Gate Geofence Controller (HC-SR04 person count + TSOP IR beam + buzzer), IR Receiver Node (NEC decode), Gate Failsafe Relay (serial-controlled + heartbeat).
- **Serial monitor with ingestion**: `ATX1,{...}` event lines from the Arduino are parsed and posted to `POST /api/gate/sensor-events` (now staff-JWT or device-token) — IR/ultrasonic events flow straight into the existing gate-integrity fusion engine.
- Honest constraint (stated in the UI): browsers cannot compile AVR C — compile the sketch with `arduino-cli compile --fqbn arduino:avr:uno`, then flash the `.hex` right here. Requires Chrome/Edge on desktop over HTTPS.

### 🎨 Insane favicon + PWA icons
- New SVG mark (face-scan brackets + shield check + emerald/violet gradient) as `favicon.svg` first-class, with maskable 192/512 PNGs + apple-touch generated via resvg; manifest + theme-color updated.

### 🧹 Full-system audit fixes shipped in this phase
- **14 new indexes** on the hottest query paths (attendance dashboards/reports, job-queue polling, QR door-token lookups, audit feed, per-student SMS history, review queue) — previously full table scans.
- **Zod validation** added to `POST /admins`, `PUT /admins/:id`, QR rotate/issue-all (role/password/badge fields no longer pass raw).
- **8 pages fixed for the silent-failure bug class** (Dashboard, Attendance, QrManager, Reports, SmsTemplates, Audit, Admins, ReviewQueue) — errors now render explicit panels with retry; an error never looks like an empty state.
- `sms.status` SSE event finally invalidates the SMS Logs page cache.

### 🗃 Schema migration (Phase 7)
- `lib/db/migrations/0009_gate_devices_and_indexes.sql` (idempotent) — `pi_devices → gate_devices` rename + phone columns + `device_uptime_days` + the index sweep:

  ```sh
  psql $DATABASE_URL -f lib/db/migrations/0009_gate_devices_and_indexes.sql
  # the api-server ALSO self-applies 0007→0009 at boot (schema_migrations ledger)
  ```

## What's new in Phase 6

### 📶 SMS delivery lifecycle (the honesty engine)
- **Honest status taxonomy**: every Twilio send now logs as `queued` and upgrades through `sent → delivered / undelivered / failed` — plus `canceled` and `simulated` (Twilio disabled) in the SMS Logs UI. No more claiming "sent" for a message the carrier silently dropped (the async 21612 trap). Rows also expose `provider_sid`, `error_code`, `channel` (sms/whatsapp) and `status_updated_at`.
- **Twilio status webhook** (`POST /api/webhooks/twilio/status`): every send carries a `StatusCallback` so Twilio pushes the real carrier verdict (+ error code/message) straight into sms_logs. HMAC-validated via `X-Twilio-Signature` when `TWILIO_AUTH_TOKEN` is set (fail-closed); unsigned calls are accepted only in dev/simulated mode when no token is configured. Statuses only move forward — regressive updates are ignored.
- **Reconcile sweep** (`artifacts/api-server/src/lib/sms-reconcile.ts`): the safety net for missed webhooks — re-fetches the verdict from Twilio for rows still pending confirmation (`queued`/`sent` older than 45s). Runs every 60s on long-lived servers (skipped when `VERCEL` is set) and in the existing daily `/api/internal/cron` pass.
- **On-demand reconcile endpoint** (`POST /api/sms/reconcile`, staff auth like `GET /sms-logs`): runs the sweep immediately and returns `{ checked, upgraded, byStatus, errors, geoBlocked }` — wired to the **Check delivery status** button on the SMS Logs page and the **refresh carrier statuses** button on the SMS Health card.
- **Throttled auto-reconcile middleware** (`smsReconcileMiddleware`, mounted in `app.ts` right after schema bootstrap): fire-and-forget sweep at most once per 60s per process, never awaited in the request path — keeps statuses fresh on **Vercel serverless**, where the `setInterval` sweep can't run. A one-shot sweep also fires **~12s after every carrier-accepted send** so rows leave `queued` fast (Twilio can still fail minutes-zero at the carrier — the async 21612 trap).
- **Trial-account limitation (the 21612 root cause)**: Twilio trial accounts only deliver to **Verified Caller IDs**, and Geographic Permissions are console-only. `GET /api/sms/diagnostics` + `GET /api/sms/config-status` now include a `carrier` object (`{ accountType: "trial"|"paid"|null, trial, messagingServiceConfigured, fromNumber }` — 5-min server cache, nulls on Twilio failure) and the SMS Health card renders an amber trial banner. Console fixes, in order: ① Phone Numbers → **Verified Caller IDs** (add each parent number), ② Messaging → Settings → **Geographic Permissions** (enable Ethiopia/ET), ③ create a **Messaging Service** with your sender and set `TWILIO_MESSAGING_SERVICE_SID`.
- **WhatsApp is opt-in**: in `auto` channel mode the WhatsApp fallback is attempted **only** when `TWILIO_WHATSAPP_FROM` is configured (or the admin pins channel mode to `whatsapp`); otherwise SMS only — unregistered WhatsApp senders previously produced 63007 failure bursts.
- **SMS Health card**: `GET /api/sms-logs/health` returns `pendingDelivery` (sends still awaiting a carrier verdict) + per-status counts; `GET /api/sms/diagnostics` now includes `pendingDelivery` too. Every provider error ships with an actionable hint (e.g. `21612` → enable geographic permissions for the destination country, or route via a Messaging Service).
- **New/changed env vars** (read in `artifacts/api-server/src/lib/sms.ts`):

  | Env var | Purpose |
  | --- | --- |
  | `PUBLIC_BASE_URL` | Public HTTPS base URL of this deployment (e.g. `https://attendx.vercel.app`) — used to build each send's `StatusCallback` URL. **Required for real Twilio callbacks in production**; without it rows stay `queued` and rely on the reconcile sweep. |
  | `TWILIO_STATUS_CALLBACK_BASE` | Legacy/alternate name for the same value (checked as fallback). |
  | `TWILIO_AUTH_TOKEN` | Now also validates the status webhook (`X-Twilio-Signature`, HMAC-SHA1) and authenticates reconcile re-fetches. |
  | `TWILIO_WHATSAPP_FROM` | **Opt-in** WhatsApp sender (E.164). When unset, `auto` channel mode sends SMS only (no 63007 bursts); when set, the WhatsApp fallback uses it as the `From` sender. |

### 📴 Offline PWA kiosk (facetrack)
- **Installable**: hand-rolled zero-dependency service worker (`public/sw.js` — app-shell precache, network-first navigations, cache-first hashed assets, `/api/*` always hits the network) + `manifest.webmanifest` ("AttendX Kiosk", standalone display).
- **Offline capture**: the QR terminal stamps every scan with **GPS (lat/lng/accuracy) + a unique nonce**; scans that fail to submit spool in **IndexedDB (`attendx-kiosk`)** instead of being lost.
- **Auto-flush**: the spool drains via `POST /api/qr/scan/batch` on the `online` event, tab visibility change, or a 30s poll while items are pending. Server-side **nonce idempotency** means offline replays never double-count attendance. Sticky offline banner with a manual **Sync now** button on the terminal.

### 📍 Geofenced QR
- New **`gates` table**: physical gate registry (gate_id, name, lat/lng, `geofence_radius_m` default 150, `terminal_ids[]`). Gate registry CRUD at `/api/gates` — read is staff-level, create/update/delete require admin (audited).
- Scans carrying GPS are validated by **haversine distance** with a generous buffer: `radius + 30m fixed jitter + reported GPS accuracy`. Violations log a `geofence-violation` verdict, answer **403**, and raise a fraud signal. Scans without GPS (or gates without coordinates) pass un-enforced.

### 🕵 Proxy-fraud AI
- New **`fraud_signals` table + inline engine** wired into every committed scan: `impossible_travel`, `burst_scan`, `badge_sharing`, `proxy_farm`, `geofence_violation` — deduped per (kind, key), with severity + score.
- Triage API: `GET /api/fraud-signals` (filter by kind/status/severity), `GET /api/fraud-signals/summary`, `POST /api/fraud-signals/:id/decide` (acknowledge / resolve / dismiss, stamped from the JWT admin + audit trail). Open signals surface in the **notification center**.

### 🗃 Schema migration
- `lib/db/migrations/0007_phase6_sms_geo_fraud.sql` (idempotent) — creates `gates` + `fraud_signals`, adds the sms_logs delivery-lifecycle columns and the qr_scan_logs GPS/nonce/fraud columns:

  ```sh
  psql $DATABASE_URL -f lib/db/migrations/0007_phase6_sms_geo_fraud.sql
  # or: DATABASE_URL="postgres://…" pnpm --filter @workspace/db run push
  ```

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
- **SMS Template Manager**: editable present/late/absent templates with `{student_name} {time} {classroom}` variables — arrival messages are queued for every new check-in, and absent alerts fire from the end-of-day sweep
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
