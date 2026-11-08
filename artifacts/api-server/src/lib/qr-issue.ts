import { db, studentsTable, qrIssuesTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { signQrToken, hashQrToken, newNonce, serialFor } from "./qr";
import { writeAudit } from "./audit";

/**
 * Shared QR issuance logic used by /qr/* routes and bulk enrollment.
 * Issues a new server-signed badge, bumping the student's version so every
 * previously printed badge is instantly invalidated.
 */
export async function issueForStudents(params: {
  studentIds: number[];
  expiresInDays: number | null;
  label: string;
  note?: string;
  actorAdminId: number | null;
}): Promise<{
  issued: Array<{ studentId: number; name: string; token: string; serial: string; expiresAt: string | null; version: number }>;
  skipped: Array<{ studentId: number; reason: string }>;
}> {
  const issued: Array<{ studentId: number; name: string; token: string; serial: string; expiresAt: string | null; version: number }> = [];
  const skipped: Array<{ studentId: number; reason: string }> = [];

  for (const studentId of params.studentIds) {
    const [student] = await db.select().from(studentsTable).where(eq(studentsTable.id, studentId)).limit(1);
    if (!student) {
      skipped.push({ studentId, reason: "student-not-found" });
      continue;
    }

    // Monotonic version: new issue instantly invalidates every older badge
    const [{ maxVersion }] = await db
      .select({ maxVersion: sql<number>`coalesce(max(${qrIssuesTable.version}), 0)` })
      .from(qrIssuesTable)
      .where(eq(qrIssuesTable.studentId, studentId));
    const version = Number(maxVersion) + 1;

    // Auto-revoke prior active badges when rotating
    await db
      .update(qrIssuesTable)
      .set({ revoked: true, revokedAt: new Date(), revokeReason: "rotated" })
      .where(and(eq(qrIssuesTable.studentId, studentId), eq(qrIssuesTable.revoked, false)));

    const expiresAt = params.expiresInDays && params.expiresInDays > 0
      ? new Date(Date.now() + params.expiresInDays * 24 * 60 * 60 * 1000)
      : null;

    const nonce = newNonce();
    const token = signQrToken({
      sid: studentId,
      v: version,
      n: nonce,
      exp: expiresAt ? Math.floor(expiresAt.getTime() / 1000) : null,
    });

    const [{ count: seq }] = await db.select({ count: sql<number>`count(*)` }).from(qrIssuesTable);
    const serial = serialFor(student.studentId || String(studentId), Number(seq) + 1);

    await db.insert(qrIssuesTable).values({
      studentId,
      classroomId: student.classroomId,
      tokenHash: hashQrToken(token),
      version,
      serial,
      issuedByAdminId: params.actorAdminId,
      expiresAt,
      label: params.label || "id-card",
    });

    await writeAudit({
      actorAdminId: params.actorAdminId,
      action: "qr.issued",
      targetType: "qr_issue",
      targetId: serial,
      payload: { studentId, version, expiresAt: expiresAt?.toISOString() ?? null, label: params.label, note: params.note },
    });

    issued.push({
      studentId,
      name: student.name,
      token,
      serial,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      version,
    });
  }

  return { issued, skipped };
}
