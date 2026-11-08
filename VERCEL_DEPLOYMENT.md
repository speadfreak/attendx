# Deploy AttendX on Vercel

AttendX is a pnpm monorepo containing a static React/Vite web app, an Express API, and shared libraries. This setup serves the frontend and API from one Vercel project and one origin.

## Vercel project settings

Import the GitHub repository with the **repository root** as the project root. Do not set the root directory to `artifacts/facetrack`; the API function and shared workspace packages are at the repository root.

The committed `vercel.json` configures:

- Install: `pnpm install --frozen-lockfile`
- Build: `pnpm --filter @workspace/facetrack run build`
- Static output: `artifacts/facetrack/dist/public`
- API: `api/[...route].ts`, which forwards `/api/*` requests to the existing Express routes (`maxDuration: 60`)
- SPA fallback: direct browser visits such as `/login` resolve to the Vite app, while `/api/*` stays routed to the API function
- Scheduled processing: `/api/internal/cron` runs daily at 03:00 UTC
- Live events: `/api/events/stream` is a Server-Sent Events endpoint (no WebSocket servers needed on serverless). Clients auto-reconnect and fall back to polling when the function is recycled.

Use Node.js 22 or newer. Leave `VITE_API_ORIGIN` unset for the single-origin Vercel setup; the browser will call `/api` on the same domain.

## Required Vercel environment variables

Add these in Vercel Project Settings → Environment Variables. Do not commit values to the repository.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Reachable PostgreSQL connection string. Prefer a provider's pooled connection URL for serverless traffic. |
| `SESSION_SECRET` | Long random secret used to sign admin JWTs **and the QR badge HMAC signatures**. Changing it invalidates every issued badge. |
| `CRON_SECRET` | Long random secret used to authenticate scheduled processing requests. |
| `TWILIO_ACCOUNT_SID` | Optional; enables live SMS delivery. |
| `TWILIO_AUTH_TOKEN` | Optional; enables live SMS delivery. |
| `TWILIO_FROM_NUMBER` | Optional; enables live SMS delivery. |

The three Twilio variables are optional; without them AttendX records simulated SMS delivery. If they are enabled, create new credentials and enter them in Vercel's secret environment-variable UI. Do not reuse credentials that were stored in a repository file.

Set variables for Production, and add separate values for Preview only if preview deployments should use a separate database and messaging account. Vercel's scheduled jobs run only for Production deployments.

## Database setup

Vercel does not provide the database used by this app automatically. Configure an externally reachable PostgreSQL database (Neon, Supabase, Vercel Postgres, Railway…), then apply the existing Drizzle schema once:

```sh
DATABASE_URL="postgres://..." pnpm --filter @workspace/db run push
```

Optional demo data (first admin + teacher + classrooms + students + history + QR badges + seating):

```sh
DATABASE_URL="postgres://..." pnpm --filter @workspace/scripts exec tsx src/seed-demo.ts
```

Seeded accounts: `admin@attendx.app / admin1234` (super admin) and `teacher@attendx.app / teach1234` (teacher). Change these immediately in Production via Admins → Edit.

Run the push command only after confirming `DATABASE_URL` points to the intended database and backing up any data that must be kept.

## Serverless behavior

Pi maintenance and fan jobs remain in PostgreSQL until the Pi agent polls `/api/jobs/next`; no long-running Vercel process is needed for those device jobs. SMS jobs are processed during the request that queues them, with the daily scheduled endpoint as a recovery path. Rejected-review retention cleanup also runs through that schedule.

Vercel's Hobby plan allows scheduled jobs only once per day. The committed daily schedule works on Hobby; do not change it to a more frequent schedule unless the Vercel plan supports it. The Operations page can manually retry failed jobs.

## Step-by-step deployment

1. Push this branch to `main` on GitHub (or import the repo directly).
2. Go to vercel.com → **Add New → Project** → import the `attendx` repository.
3. Leave **Framework Preset** as *Other* — `vercel.json` drives everything.
4. Provision Postgres (e.g. Neon free tier) and copy its **pooled** connection string.
5. In *Project → Settings → Environment Variables* add `DATABASE_URL`, `SESSION_SECRET` (use `openssl rand -hex 32`), `CRON_SECRET` (same), plus the Twilio trio if you want real SMS.
6. Click **Deploy**. First build takes ~2 minutes.
7. After it's live, run the schema push against the production database from your machine, then (optionally) the seed script.
8. Log in with the seeded super admin and **change the password** in Admins.

## Raspberry Pi after deployment

After Vercel creates the production domain:

1. Set the Pi agent's `ATTENDX_API_BASE` to `https://YOUR-VERCEL-DOMAIN/api`.
2. Pair the device in AttendX Operations and copy the one-time token to the Pi's protected token file.
3. Start `attendx-pi-agent` and confirm its heartbeat in Operations.

The Pi must have internet access to call the Vercel API. `attendx-pi.local` is mDNS discovery on the Pi's local network; it is not a public hostname that Vercel can resolve.

## Phase 3 notes for serverless

- **Live feed**: uses SSE push + automatic polling fallback — no sticky WebSocket state needed, so it survives serverless recycling transparently.
- **QR badges**: tokens are HMAC-signed with `SESSION_SECRET`; rotating a badge instantly invalidates older prints (version pinning). Nothing extra to configure.
- **Face recognition**: descriptors are extracted in the browser (face-api.js) and matched server-side — no GPU or native deps on Vercel.
- **PDF export**: rendered entirely client-side (jsPDF) — no serverless timeouts involved.
