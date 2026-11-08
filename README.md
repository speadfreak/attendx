# AttendX

**Intelligent attendance command center** — AI face recognition + signed QR door terminals + parent SMS alerts, with a real-time dark-purple command center UI.

![Phase](https://img.shields.io/badge/phase-3%20·%20command%20center-blueviolet) ![stack](https://img.shields.io/badge/stack-Vite%20·%20Express%20·%20Drizzle%20·%20Postgres-purple)

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
lib/db                  Drizzle schema (students, attendance, qr_issues, qr_scan_logs, seats…)
lib/api-*               OpenAPI spec + generated zod/client (legacy endpoints)
hardware/               Raspberry Pi agent + Arduino fan controller
scripts/                seed-demo.ts — instant demo data
api/[...route].ts       Vercel serverless entrypoint
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
