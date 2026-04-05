import { Router } from "express";
import bcrypt from "bcryptjs";
import { db, adminsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { LoginBody } from "@workspace/api-zod";
import { signToken, requireAuth } from "../lib/auth";

const router = Router();

router.post("/auth/login", async (req, res): Promise<void> => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { email, password } = parsed.data;
  const [admin] = await db.select().from(adminsTable).where(eq(adminsTable.email, email));
  if (!admin) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }
  const valid = await bcrypt.compare(password, admin.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }
  const token = signToken({ adminId: admin.id, email: admin.email, role: admin.role });
  res.json({
    token,
    admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role, createdAt: admin.createdAt.toISOString() },
  });
});

router.get("/auth/me", requireAuth, async (req, res): Promise<void> => {
  const authReq = req as typeof req & { admin: { adminId: number } };
  const [admin] = await db.select().from(adminsTable).where(eq(adminsTable.id, authReq.admin.adminId));
  if (!admin) {
    res.status(404).json({ error: "Admin not found" });
    return;
  }
  res.json({ id: admin.id, name: admin.name, email: admin.email, role: admin.role, createdAt: admin.createdAt.toISOString() });
});

export default router;
