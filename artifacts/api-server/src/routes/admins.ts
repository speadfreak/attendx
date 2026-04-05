import { Router } from "express";
import { db } from "@workspace/db";
import { adminsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { requireAuth } from "../lib/auth";

const router = Router();

router.get("/admins", requireAuth, async (req, res) => {
  const all = await db.select({
    id: adminsTable.id,
    name: adminsTable.name,
    email: adminsTable.email,
    role: adminsTable.role,
    createdAt: adminsTable.createdAt,
  }).from(adminsTable);
  res.json(all);
});

router.post("/admins", requireAuth, async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: "name, email, and password are required" });
  }
  const existing = await db.select().from(adminsTable).where(eq(adminsTable.email, email));
  if (existing.length > 0) {
    return res.status(409).json({ error: "Email already in use" });
  }
  const passwordHash = await bcrypt.hash(password, 12);
  const [admin] = await db.insert(adminsTable).values({
    name,
    email,
    passwordHash,
    role: role ?? "admin",
  }).returning({
    id: adminsTable.id,
    name: adminsTable.name,
    email: adminsTable.email,
    role: adminsTable.role,
    createdAt: adminsTable.createdAt,
  });
  res.status(201).json(admin);
});

router.put("/admins/:id", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const { name, email, password, role } = req.body;

  const updates: Record<string, any> = {};
  if (name) updates.name = name;
  if (email) {
    const existing = await db.select().from(adminsTable).where(eq(adminsTable.email, email));
    if (existing.length > 0 && existing[0].id !== id) {
      return res.status(409).json({ error: "Email already in use" });
    }
    updates.email = email;
  }
  if (password) updates.passwordHash = await bcrypt.hash(password, 12);
  if (role) updates.role = role;

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No fields to update" });
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
  if (!updated) return res.status(404).json({ error: "Admin not found" });
  res.json(updated);
});

router.delete("/admins/:id", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const reqAdminId = (req as any).admin?.adminId;
  if (id === reqAdminId) {
    return res.status(400).json({ error: "Cannot delete your own account" });
  }
  await db.delete(adminsTable).where(eq(adminsTable.id, id));
  res.json({ success: true });
});

export default router;
