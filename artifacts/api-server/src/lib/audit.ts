import { db, auditLogsTable } from "@workspace/db";

export async function writeAudit(params: {
  actorAdminId?: number | null;
  action: string;
  targetType: string;
  targetId?: string | number | null;
  payload?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(auditLogsTable).values({
    actorAdminId: params.actorAdminId ?? null,
    action: params.action,
    targetType: params.targetType,
    targetId: params.targetId == null ? null : String(params.targetId),
    payload: params.payload ?? {},
  });
}
