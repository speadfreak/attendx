# FaceTrack – Intelligent Attendance & Student Safety System

**Developed by Joseph James** (Age 17, Addis Ababa, Ethiopia)

## Overview

FaceTrack is a complete, production-ready intelligent attendance and student safety monitoring platform. It provides real-time face recognition attendance tracking, QR code scanning, SMS parent notifications, and a comprehensive admin dashboard.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **Frontend**: React + Vite + TailwindCSS + shadcn/ui + Framer Motion
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **Auth**: JWT (jsonwebtoken + bcryptjs)
- **Charts**: Recharts

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally
- `pnpm --filter @workspace/facetrack run dev` — run frontend locally

## Default Admin Credentials

- **Email**: admin@gmail.com
- **Password**: admin_password

## Architecture

```
Frontend (React/Vite) → Node.js API (Express) → PostgreSQL (Drizzle ORM)
                                              → SMS Service (Twilio or simulation)
```

## Features

1. **Face Recognition** — webcam capture, base64 encoding, cosine similarity matching
2. **QR Code Attendance** — unique QR per student, scan to mark attendance
3. **Manual Attendance** — manual override with notes
4. **Real-Time SMS** — parent notifications on attendance events (Twilio or simulated)
5. **Admin Dashboard** — live stats, 7-day trend chart, classroom summaries
6. **Student Management** — CRUD with face encoding capture
7. **Classroom Management** — organize students by class
8. **Reports** — filterable attendance logs with CSV export
9. **SMS Logs** — view all sent notifications
10. **Admin Management** — manage admin accounts

## Database Schema

- `admins` — admin accounts with bcrypt password hashing
- `classrooms` — class rooms with teacher info
- `students` — student profiles with parent phone, QR code
- `face_encodings` — stored face encoding vectors per student
- `attendance_logs` — attendance records (present/late/absent, method: face/qr/manual)
- `sms_logs` — all sent SMS notifications

## API Routes

- `POST /api/auth/login` — JWT login
- `GET /api/auth/me` — current admin info
- `GET/POST /api/students` — student CRUD
- `GET/POST /api/classrooms` — classroom CRUD
- `GET/POST /api/attendance` — attendance logs
- `GET /api/attendance/today` — today's live feed
- `POST /api/face/encode` — store face encoding
- `POST /api/face/recognize` — recognize face + auto-mark attendance
- `GET /api/sms-logs` — SMS notification history
- `GET /api/dashboard/stats` — summary statistics
- `GET /api/dashboard/recent-activity` — recent attendance feed
- `GET /api/dashboard/attendance-trend` — 7-day trend data
- `GET /api/dashboard/classroom-summary` — per-classroom attendance rates
- `GET/POST/PUT/DELETE /api/admins` — admin management

## Artifacts

- `artifacts/facetrack` — React + Vite frontend (previewPath: `/`)
- `artifacts/api-server` — Express API server (previewPath: `/api`)

## Environment Variables

- `DATABASE_URL` — PostgreSQL connection string (auto-provisioned)
- `SESSION_SECRET` — JWT signing secret
- `TWILIO_ACCOUNT_SID` — (optional) Twilio account SID for SMS
- `TWILIO_AUTH_TOKEN` — (optional) Twilio auth token
- `TWILIO_FROM_NUMBER` — (optional) Twilio sender number

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
