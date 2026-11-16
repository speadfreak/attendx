# AttendX — Phase 7 Full System Audit (findings + dispositions)

Audit performed before the Phase 7 build, per the build-order mandate
(audit first → unified device model → PWA + Operations UI → extras).
Every finding below is either FIXED in this phase or explicitly deferred
with a reason.

---

## 1. Data model review

**Inventory:** 18 tables across `lib/db/src/schema/*.ts` — admins, classrooms,
students, face_encodings, attendance_logs, sms_logs, audit_logs, pi_devices
(→ renamed), jobs, match_reviews, system_settings, qr_issues, qr_scan_logs,
classroom_seats, gate_sensor_events + gate_integrity_alerts (gate.ts), gates,
fraud_signals — plus Phase 7's new `device_uptime_days`.

### Findings and dispositions

| # | Finding | Severity | Disposition |
|---|---------|----------|-------------|
| 1.1 | **Hot tables had ZERO secondary indexes**: `attendance_logs` (every dashboard/report/QR/face query = full scan + sort), `jobs` (worker poll + bulk-match dedupe), `qr_issues` (badge token lookup on every physical door tap), `audit_logs` (created_at, 20s polling feed), `match_reviews` (pending queue + purge), `sms_logs.student_id` (per-student history) | HIGH | **FIXED** — migration `0009_gate_devices_and_indexes` adds 14 indexes; mirrored in the Drizzle schema so `push` agrees with the runtime bootstrap |
| 1.2 | `pi_devices` single-device hardcoded id `"attendx-pi"`; no device_type/mode/gate/health/battery columns | HIGH | **FIXED** — table renamed to `gate_devices` (data preserved), fleet-capable, +12 phone columns (see Section 2) |
| 1.3 | `gate.ts` (sensor events/alerts) vs `gates.ts` (registry) filename split is confusing | LOW | Deferred — cosmetic; a rename would churn imports for zero behavior gain |
| 1.4 | `students.qr_code` legacy free-text column — written + echoed to UI, never consumed by any scan path (superseded by HMAC `qr_issues`) | LOW | Deferred — deprecated in docs; removal is a breaking UI change for the student table display, safe to drop in a future cleanup migration |
| 1.5 | `attendance_logs.method` vs `.source` overlapping taxonomies | LOW | Deferred — both actively written/read; standardizing is a data-migration project, noted for Phase 8 |
| 1.6 | `sms_logs.sentAt` vs `createdAt` near-duplicate timestamps | LOW | Deferred — `sentAt` is the documented sort key; harmless |
| 1.7 | Dead event types `attendance.updated` and `heartbeat` declared in `lib/events.ts`, never published | LOW | Partially fixed — union extended for Phase 7 (`device.*`); dead members left (removing them breaks the client map for zero gain) |
| 1.8 | `fraud_signals` unique constraint named differently between bootstrap SQL (table constraint) and Drizzle schema (uniqueIndex) | LOW | Deferred — fraud.ts tolerates both names by message-match; renaming would require a destructive migration |
| 1.9 | No 0001–0006 baseline migrations exist (pre-Phase-6 tables only via `drizzle-kit push`) | MEDIUM | Deferred — documented in VERCEL_DEPLOYMENT.md; fresh deploys must run push once, then the runtime bootstrap self-heals 0007→0009 |

## 2. API surface review

**Wiring:** auth is per-route (no global middleware) — `requireAuth` /
`requireRole(...)` / `requireStaff` / `requireAdminLevel` / `requireSuperAdmin`
(JWT) or `requirePiToken` (device token). CORS is wide-open default; auth is
Bearer-token only, no cookies — no CSRF surface for the JSON API.

| # | Finding | Severity | Disposition |
|---|---------|----------|-------------|
| 2.1 | **Unvalidated POST/PATCH bodies**: `POST /admins` + `PUT /admins/:id` (role-bearing fields straight from body), `POST /qr/students/:id/rotate` + `/qr/classrooms/:id/issue-all` (`expiresInDays`/`label` into DB), `DELETE /attendance/records`, `POST /qr/issues/:id/revoke`, `POST /gate/integrity/alerts/:id/resolve`, `POST /attendance/absent-sweep` (`force`), `POST /sms-logs/retry-failed` (limit) | HIGH (admins) / MEDIUM | **FIXED (admins + QR rotate/issue-all)** — Zod schemas added; the remaining manual checks are bounded (string slices / boolean coercion) and low-risk, listed for Phase 8 |
| 2.2 | `/attendance/bulk-match` (device token) vs `/qr/scan` (staff JWT) — a phone camera node can't use both | HIGH | **FIXED** — `/qr/scan` + `/qr/scan/batch` now accept staff JWT **or** paired device token (`requireStaffOrDevice`); `/gate/sensor-events` accepts staff JWT for the Arduino serial monitor |
| 2.3 | Pi pairing could only ever issue one device | HIGH | **FIXED** — fleet pairing via `/devices/pair` (+ `/devices/:id/pair` re-pair); legacy `/pi/*` endpoints unchanged on top of the renamed table |
| 2.4 | No server→device push channel for phones (Pi polls jobs; SSE is JWT-browser only) | HIGH | **FIXED** — device commands fan out over SSE (`device.command`) **and** a per-device heartbeat mailbox (`pending_command` drained by `POST /devices/heartbeat`, TTL 10 min) so commands survive SSE loss and serverless restarts; `/api/events/stream` now accepts device tokens |
| 2.5 | Intentional unauthenticated endpoints (verified, not accidents): `/healthz`, `POST /auth/login`, carrier webhooks (HMAC/token verified when secrets configured), `/internal/cron` (CRON_SECRET Bearer) | INFO | No action |

## 3. Frontend review

| # | Finding | Severity | Disposition |
|---|---------|----------|-------------|
| 3.1 | **8 pages silently swallow query errors** (render empty/skeleton forever): DashboardPage, AttendancePage, QrManagerPage, ReportsPage, SmsTemplatesPage (explicit `catch(() => {})`), AuditPage, AdminsPage, ReviewQueuePage (renders "Queue is clear" ON ERROR — misleading) | HIGH | **FIXED** — every listed page got a proper error state (destructive panel + message + retry); an error state never looks like an empty state |
| 3.2 | `sms.status` published by the server but missing from the client invalidation map | LOW | **FIXED** |
| 3.3 | NotificationCenter deliberately degrades on fetch error (badge only) | INFO | Accepted — by design |
| 3.4 | QrTerminalPage identified as the model kiosk (camera states, offline spool, GPS capture) — reused as the pattern for the Phase 7 phone PWA | INFO | Adopted in `/camera-node` |

## 4. Documentation drift

| # | Finding | Disposition |
|---|---------|-------------|
| 4.1 | README described Phase 6 + Twilio-only SMS; no TextBee/AfroMessage story, no retry engine (0008), no runtime-bootstrap mention | **FIXED** — README rewritten for Phase 7 (architecture, device model, endpoints, migrations, SMS gateways) |
| 4.2 | VERCEL_DEPLOYMENT.md missing 0008/0009 + self-healing explanation | **FIXED** |
| 4.3 | openapi.yaml covers only the original 26 paths; newer surfaces (qr/gate/gates/fraud/notifications/reports/sms-tools + all Phase 7 device routes) are hand-typed in `facetrack/src/lib/api.ts` | **Documented, deferred** — formalizing the hand-typed layer into the spec is a large mechanical codegen project; the hand-typed layer is the documented integration point for Phase 7 features |

## 5. Pre-build summary (what the build inherited)

- Everything Phase 7 needed was either already provider-agnostic and clean
  (job queue, SSE bus, gates/terminal mapping, bulk-match, QR pipeline,
  token-rotation auth) or was fixed by this audit first (1.1, 1.2, 2.1–2.4).
- Known-accepted debts going forward: legacy `students.qr_code`,
  method/source taxonomy, gate.ts filename, constraint-name drift on
  fraud_signals, missing 0001–0006 baseline, remaining minor unvalidated
  bodies. All listed above with reasons.

---

## 6. Phase 7 build index (what was shipped after the audit)

| Piece | Where |
|---|---|
| Unified device model (pi+phone), token rotation, command mailbox | `lib/db/src/schema/gate_devices.ts`, `lib/db/migrations/0009_*.sql`, `api-server/src/lib/devices.ts`, `api-server/src/routes/devices.ts` |
| Phone camera node PWA (`/camera-node`) | `facetrack/src/pages/CameraNodePage.tsx`, `facetrack/src/lib/camera-node/*` |
| Operations Camera Command Center | `facetrack/src/components/CameraNetworkCard.tsx` (mounted in OperationsPage) |
| Arduino Gate Controller Studio (`/arduino`) | `facetrack/src/pages/ArduinoPage.tsx`, `facetrack/src/lib/arduino/*` |
| Device uptime report | `GET /devices/uptime` + reliability section in CameraNetworkCard |
| Notification integration (blind-spot alerts) | `api-server/src/routes/notifications.ts` device section |
| Insane favicon + PWA icons | `facetrack/public/favicon.svg`, `facetrack/public/icons/*`, `index.html`, `manifest.webmanifest` |
