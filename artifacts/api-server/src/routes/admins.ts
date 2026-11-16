import { Router, type Request } from "express";
import { z } from "zod/v4";
import { db } from "@workspace/db";
import { adminsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { requireAuth, requireSuperAdmin } from "../lib/auth";
import { writeAudit } from "../lib/audit";

const router = Router();
const adminId = (req: Request) => (req as Request & { admin?: { adminId: number } }).admin?.adminId;

const ROLES = ["super_admin", "admin", "teacher"] as const;

function toDto(a: { id: number; name: string; email: string; role: string; createdAt: Date }) {
  return { id: a.id, name: a.name, email: a.email, role: a.role, createdAt: a.createdAt.toISOString() };
}

router.get("/admins", requireAuth, async (_req, res): Promise<void> => {
  const all = await db.select({
    id: adminsTable.id,
    name: adminsTable.name,
    email: adminsTable.email,
    role: adminsTable.role,
    createdAt: adminsTable.createdAt,
  }).from(adminsTable).orderBy(adminsTable.id);
  res.json(all.map(toDto));
});

router.post("/admins", requireSuperAdmin, async (req, res): Promise<void> => {
  // Phase 7 audit fix: Zod validation on every POST body — this endpoint
  // carries role + password material and had only manual field checks.
  const bodySchema = z.object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().email().max(200),
    password: z.string().min(8).max(200),
    role: z.enum(["super_admin", "admin", "teacher"]).default("admin"),
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    return;
  }
  const { name, email, password, role } = parsed.data;
  const existing = await db.select().from(adminsTable).where(eq(adminsTable.email, email));
  if (existing.length > 0) {
    res.status(409).json({ error: "Email already in use" });
    return;
  }
  const passwordHash = await bcrypt.hash(password, 12);
  const [admin] = await db.insert(adminsTable).values({
    name,
    email,
    passwordHash,
    role,
  }).returning({
    id: adminsTable.id,
    name: adminsTable.name,
    email: adminsTable.email,
    role: adminsTable.role,
    createdAt: adminsTable.createdAt,
  });
  await writeAudit({
    actorAdminId: adminId(req),
    action: "admin.created",
    targetType: "admin",
    targetId: admin.id,
    payload: { email, role },
  });
  res.status(201).json(toDto(admin));
});

router.put("/admins/:id", requireSuperAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const { name, email, password, role } = req.body;

  const updates: Record<string, any> = {};
  if (name) updates.name = name;
  if (email) {
    const existing = await db.select().from(adminsTable).where(eq(adminsTable.email, email));
    if (existing.length > 0 && existing[0].id !== id) {
      res.status(409).json({ error: "Email already in use" });
      return;
    }
    updates.email = email;
  }
  if (password) updates.passwordHash = await bcrypt.hash(password, 12);
  if (role) {
    if (!ROLES.includes(role)) {
      res.status(400).json({ error: `Role must be one of: ${ROLES.join(", ")}` });
      return;
    }
    updates.role = role;
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  // Safety: never demote the last super_admin
  if (updates.role && updates.role !== "super_admin") {
    const [target] = await db.select().from(adminsTable).where(eq(adminsTable.id, id));
    if (target?.role === "super_admin") {
      const supers = await db.select({ id: adminsTable.id }).from(adminsTable).where(eq(adminsTable.role, "super_admin"));
      if (supers.length <= 1) {
        res.status(409).json({ error: "Cannot demote the last super admin" });
        return;
      }
    }
  }

  const [updated] = await db.update(adminsTable)
    .set(updates)
    .where(eq(adminsTable.id, id))
    .returning({
      id: adminsTable.id,
      name: adminsTable.name,
      email: adminsTable.email,
      role: adminsTable.role,
      createdAt: adminsTable.createdAt,
    });
  if (!updated) {
    res.status(404).json({ error: "Admin not found" });
    return;
  }
  await writeAudit({
    actorAdminId: adminId(req),
    action: "admin.updated",
    targetType: "admin",
    targetId: id,
    payload: { fields: Object.keys(updates) },
  });
  res.json(toDto(updated));
});

router.delete("/admins/:id", requireSuperAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const reqAdminId = (req as any).admin?.adminId;
  if (id === reqAdminId) {
    res.status(400).json({ error: "Cannot delete your own account" });
    return;
  }
  const [target] = await db.select().from(adminsTable).where(eq(adminsTable.id, id));
  if (target?.role === "super_admin") {
    const supers = await db.select({ id: adminsTable.id }).from(adminsTable).where(eq(adminsTable.role, "super_admin"));
    if (supers.length <= 1) {
      res.status(409).json({ error: "Cannot delete the last super admin" });
      return;
    }
  }
  await db.delete(adminsTable).where(eq(adminsTable.id, id));
  await writeAudit({
    actorAdminId: adminId(req),
    action: "admin.deleted",
    targetType: "admin",
    targetId: id,
    payload: { email: target?.email },
  });
  res.json({ success: true });
});

export default router;
