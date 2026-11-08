/**
 * AttendX demo seeder — creates the first super admin, a teacher account,
 * classrooms, students (with face encodings ready to be re-enrolled), a week
 * of attendance history and QR badges so every screen has data.
 *
 * Usage:
 *   DATABASE_URL=postgres://... SESSION_SECRET=... pnpm --filter @workspace/scripts exec tsx src/seed-demo.ts
 */
import bcrypt from "bcryptjs";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const pool = new pg.Pool({ connectionString: url });

async function main() {
  const q = (text: string, params?: unknown[]) => pool.query(text, params as any);

  // ── Admins ──
  const adminHash = await bcrypt.hash("admin1234", 12);
  const teacherHash = await bcrypt.hash("teach1234", 12);
  const admin = await q(
    `INSERT INTO admins (name, email, password_hash, role) VALUES ($1,$2,$3,$4)
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    ["Joseph James", "admin@attendx.app", adminHash, "super_admin"],
  );
  await q(
    `INSERT INTO admins (name, email, password_hash, role) VALUES ($1,$2,$3,$4)
     ON CONFLICT (email) DO NOTHING`,
    ["Ms. Hanna", "teacher@attendx.app", teacherHash, "teacher"],
  );
  const adminId = admin.rows[0].id;

  // ── Classrooms ──
  const classrooms: Array<[string, string, string]> = [
    ["Grade 4A", "Main building, ground floor", "Ms. Hanna"],
    ["Grade 5B", "Main building, first floor", "Mr. Daniel"],
    ["Grade 6A", "Science wing", "Ms. Hanna"],
  ];
  const classroomIds: number[] = [];
  for (const [name, description, teacher] of classrooms) {
    const res = await q(
      `INSERT INTO classrooms (name, description, teacher_name)
       SELECT $1,$2,$3
       WHERE NOT EXISTS (SELECT 1 FROM classrooms WHERE name = $1)
       RETURNING id`,
      [name, description, teacher],
    );
    if (res.rows[0]) classroomIds.push(res.rows[0].id);
    else {
      const found = await q(`SELECT id FROM classrooms WHERE name = $1`, [name]);
      classroomIds.push(found.rows[0].id);
    }
  }

  // ── Students ──
  const names = [
    "Abebe Girma", "Sara Tesfaye", "Daniel Bekele", "Hanna Mekonnen", "Yonas Tadesse",
    "Lidya Alemu", "Samuel Haile", "Meron Solomon", "Kalkidan Fikru", "Nahom Getachew",
    "Bethlehem Ayele", "Eyasu Wolde", "Selam Tsegaye", "Mikias Abebe", "Rahel Girmay",
    "Tewodros Lemma", "Genet Assefa", "Bereket Mengistu", "Hiwot Zewdu", "Fikadu Kebede",
    "Amelia Desta", "Robel Shiferaw", "Mekdes Yohannes", "Zewditu Bekele", "Girma Chala",
    "Marta Nigussie", "Yared Solomon", "Betelhem Taye", "Dawit Alemayehu", "Tsion Berhane",
  ];
  const studentIds: number[] = [];
  for (let i = 0; i < names.length; i++) {
    const ref = `STU-${String(i + 1).padStart(3, "0")}`;
    const classroomId = classroomIds[i % classroomIds.length];
    const res = await q(
      `INSERT INTO students (name, student_id, classroom_id, parent_phone)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (student_id) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [names[i], ref, classroomId, `+25191100${String(i + 1).padStart(4, "0")}`],
    );
    studentIds.push(res.rows[0].id);
  }

  // ── Attendance history: last 14 days, weighted random ──
  const existing = await q(`SELECT count(*)::int AS n FROM attendance_logs`);
  if (existing.rows[0].n < 20) {
    for (let d = 14; d >= 0; d--) {
      const day = new Date();
      day.setDate(day.getDate() - d);
      if (day.getDay() === 0 || day.getDay() === 6) continue; // weekends off
      for (let i = 0; i < studentIds.length; i++) {
        const roll = Math.random();
        const status = roll > 0.12 ? "present" : roll > 0.05 ? "late" : "absent";
        const method = status === "absent" ? "manual" : roll > 0.4 ? "face" : "qr";
        const source = method === "face" ? "webcam" : method === "qr" ? "qr-terminal" : "manual";
        const marked = new Date(day);
        marked.setHours(status === "late" ? 8 : 7, 30 + Math.floor(Math.random() * 60), 0, 0);
        const confidence = method === "face" ? 0.62 + Math.random() * 0.36 : null;
        const classroomId = classroomIds[i % classroomIds.length];
        await q(
          `INSERT INTO attendance_logs (student_id, classroom_id, status, method, source, confidence, marked_at, created_at)
           SELECT $1,$2,$3,$4,$5,$6,$7,$7
           WHERE NOT EXISTS (
             SELECT 1 FROM attendance_logs WHERE student_id = $1 AND marked_at::date = $8::date
           )`,
          [studentIds[i], classroomId, status, method, source, confidence, marked.toISOString(), day.toISOString().slice(0, 10)],
        );
      }
    }
  }

  // ── QR badges for the first 12 students ──
  for (let i = 0; i < Math.min(12, studentIds.length); i++) {
    await q(
      `INSERT INTO qr_issues (student_id, classroom_id, token_hash, version, serial, issued_by_admin_id, label)
       SELECT $1,$2,$3,1,$4,$5,'id-card'
       WHERE NOT EXISTS (SELECT 1 FROM qr_issues WHERE student_id = $1 AND revoked = false)`,
      [studentIds[i], classroomIds[i % classroomIds.length], `seed-${Date.now()}-${i}`, `AX-SEED-${String(i + 1).padStart(4, "0")}`, adminId],
    );
  }

  // ── Seating map for first classroom ──
  const seatCount = await q(`SELECT count(*)::int AS n FROM classroom_seats WHERE classroom_id = $1`, [classroomIds[0]]);
  if (seatCount.rows[0].n === 0) {
    let idx = 0;
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        const studentId = idx < 10 ? studentIds[idx] : null;
        await q(
          `INSERT INTO classroom_seats (classroom_id, student_id, seat_label, row_idx, col_idx)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [classroomIds[0], studentId, `${String.fromCharCode(65 + r)}${c + 1}`, r, c],
        );
        idx++;
      }
    }
  }

  // ── SMS log samples ──
  const smsCount = await q(`SELECT count(*)::int AS n FROM sms_logs`);
  if (smsCount.rows[0].n === 0) {
    await q(
      `INSERT INTO sms_logs (student_id, parent_phone, message, status, provider, sent_at)
       VALUES ($1,'+251911000001','AttendX: Abebe Girma arrived late to class at 8:42 AM.','sent','simulation', now() - interval '1 day')`,
      [studentIds[0]],
    );
  }

  // ── System settings defaults ──
  await q(`INSERT INTO system_settings (key, value) VALUES ('confidenceThreshold', '0.72') ON CONFLICT (key) DO NOTHING`);

  console.log("Seed complete:");
  console.log("  super admin → admin@attendx.app / admin1234");
  console.log("  teacher     → teacher@attendx.app / teach1234");
  console.log(`  ${classroomIds.length} classrooms, ${studentIds.length} students, attendance history, QR badges, seating map`);

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
