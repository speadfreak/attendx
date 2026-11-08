# Deploy AttendX on Vercel

AttendX is a pnpm monorepo that deploys to Vercel as **one project with multiple services** (`vercel.json` → `services`). One domain, shared environment variables, independent builds.

## Services & public routing

| Service | Root | Framework | Public path | Notes |
| --- | --- | --- | --- | --- |
| `facetrack` | `artifacts/facetrack` | Vite | `/` (catch-all) | The AttendX command center. SPA fallback rewrite serves `index.html` for client-side routes. |
| `api-server` | `artifacts/api-server` | Express | `/api/(.*)` | Entrypoint `src/app.ts` (default-exported Express app). Routes already live under `/api`, so the rewrite passes the original path through unchanged. |
| `mockup-sandbox` | `artifacts/mockup-sandbox` | Vite | `/sandbox/(.*)` | Design-preview sandbox. Service-level rewrites strip the `/sandbox` prefix; `vite base` defaults to `/sandbox/` so asset URLs agree with the mount. |

Top-level rewrites (ordered most-specific first):

1. `/api/(.*)` → `api-server`
2. `/sandbox/(.*)` → `mockup-sandbox` (plus `/sandbox` for the no-trailing-slash visit)
3. `/(.*)` → `facetrack`

## Service bindings — none needed

No service calls another service from server-side code, so **no `bindings` entries are declared**:

- The browser (facetrack / mockup-sandbox) calls the API with **same-origin relative `/api/…` paths**, which are routed by the public rewrite above — not by a binding. Bindings inject variables into server-side functions at runtime only; they never reach browser code, so a binding would not work for these calls anyway.
- `api-server` is the leaf of the graph: it never calls `facetrack` or `mockup-sandbox`.
- `mockup-sandbox` makes no network calls at all.

If a future service needs to call `api-server` server-side, declare a binding on the **caller**:

```json
"bindings": [
  { "type": "service", "service": "api-server", "format": "url", "env": "API_SERVER_URL" }
]
```

and use `fetch(new URL('path', process.env.API_SERVER_URL))` in that service's functions. Do not set `API_SERVER_URL` yourself — Vercel injects it per deployment (preview deployments resolve to the same preview's services).

## Vercel project settings

Import the GitHub repository with the **repository root** as the project root. `vercel.json` drives everything (Framework Preset *Other*), including per-service `installCommand`, `buildCommand`, `outputDirectory`, and the SPA/sandbox rewrites.

Scheduled processing stays configured at the top level: `/api/internal/cron` runs daily at 03:00 UTC (Vercel sends `Authorization: Bearer $CRON_SECRET`; the route verifies it). Hobby-plan crons run once per day — keep the daily schedule unless your plan supports more; Operations can retry failed jobs manually.

## Required Vercel environment variables

Project-level env vars are shared by all services. Add them in Project → Settings → Environment Variables; never commit values.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Reachable PostgreSQL connection string. Prefer a provider's **pooled** connection URL for serverless traffic. |
| `SESSION_SECRET` | Long random secret used to sign admin JWTs **and the QR badge HMAC signatures**. Changing it invalidates every issued badge. |
| `CRON_SECRET` | Long random secret used to authenticate scheduled processing requests. |
| `TWILIO_ACCOUNT_SID` | Optional; enables live SMS delivery. |
| `TWILIO_AUTH_TOKEN` | Optional; enables live SMS delivery. |
| `TWILIO_FROM_NUMBER` | Optional; enables live SMS delivery. |

The three Twilio variables are optional; without them AttendX records simulated SMS delivery. If enabled, create fresh credentials in Vercel's secret UI — do not reuse credentials stored in any repository file.

Leave `VITE_API_ORIGIN` unset: the browser calls `/api` on the same domain. It only exists for exotic split-origin setups.

## Database setup

Vercel does not provision the database. Use an externally reachable PostgreSQL (Neon, Supabase, Vercel Postgres, Railway…), then apply the Drizzle schema once:

```sh
DATABASE_URL="postgres://..." pnpm --filter @workspace/db run push
```

Optional demo data (first admin + teacher + classrooms + students + history + QR badges + seating):

```sh
DATABASE_URL="postgres://..." pnpm --filter @workspace/scripts exec tsx src/seed-demo.ts
```

Seeded accounts: `admin@attendx.app / admin1234` (super admin) and `teacher@attendx.app / teach1234` (teacher). Change these immediately in Production via Admins → Edit.

Run the push command only after confirming `DATABASE_URL` points at the intended database, and back up any data that must be kept.

## Serverless behavior

- The Express app deploys as a single Vercel Function (Fluid compute) via the `express` framework. `src/index.ts` stays for local/Replit dev (listens on `PORT`, runs the in-process job/retention workers); on Vercel the default-exported `src/app.ts` serves requests with **no interval workers**.
- SMS jobs are processed during the request that queues them; the daily cron route is the recovery path. Pi maintenance/fan jobs sit in PostgreSQL until the Pi polls `/api/jobs/next`.
- **Live feed**: `/api/events/stream` is Server-Sent Events. On serverless the stream lives for the function's max duration; clients auto-reconnect and fall back to 10s polling, so recycling is transparent. No WebSocket infrastructure needed.
- **QR badges**: HMAC-signed with `SESSION_SECRET`; rotating a badge instantly invalidates older prints (version pinning).
- **Face recognition**: descriptors extracted in the browser (face-api.js), matched server-side — no GPU/native deps.
- **PDF export**: rendered client-side (jsPDF).

## Step-by-step deployment

1. Push this repo to GitHub, then vercel.com → **Add New → Project** → import `attendx`.
2. Leave **Framework Preset** as *Other* — `vercel.json` (services mode) drives everything.
3. Provision Postgres (e.g. Neon free tier) and copy its **pooled** connection string.
4. Add `DATABASE_URL`, `SESSION_SECRET` (`openssl rand -hex 32`), `CRON_SECRET` (same), plus the Twilio trio if wanted.
5. Click **Deploy** — three services build independently (Vite ×2, Express ×1).
6. After it's live, run the schema push against the production database from your machine, then optionally the seed script.
7. Log in with the seeded super admin and **change the password** in Admins.

Sanity checks after deploy: `/api/health` returns JSON · the dashboard loads at `/` · `/sandbox` shows the design sandbox.

## Raspberry Pi after deployment

1. Set the Pi agent's `ATTENDX_API_BASE` to `https://YOUR-VERCEL-DOMAIN/api` (the public rewrite path — the Pi is just another API client).
2. Pair the device in AttendX Operations and copy the one-time token to the Pi's protected token file.
3. Start `attendx-pi-agent` and confirm its heartbeat in Operations.

The Pi needs internet access to call the Vercel API. `attendx-pi.local` is mDNS on the Pi's local network and is not a public hostname.

## Local development with `vercel dev`

`vercel dev` runs all services together and injects binding env vars (none used today). If you prefer the plain pnpm setup:

```sh
pnpm install
# API (terminal 1)
cd artifacts/api-server && PORT=4000 DATABASE_URL="postgres://…" SESSION_SECRET="dev" pnpm run dev
# Web (terminal 2)
cd artifacts/facetrack && VITE_API_PROXY_TARGET="http://127.0.0.1:4000" pnpm run dev
```
