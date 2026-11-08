import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";

const JWT_SECRET: string = (() => {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET is required to start the API server.");
  }
  return secret;
})();

export interface JwtPayload {
  adminId: number;
  email: string;
  role: string;
}

export type Role = "super_admin" | "admin" | "teacher";

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET) as unknown as JwtPayload;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const token = authHeader.slice(7);
  try {
    const payload = verifyToken(token);
    (req as Request & { admin: JwtPayload }).admin = payload;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

/**
 * Role tier middleware. Roles: super_admin (full access), admin (everything
 * except super-admin-only management), teacher (view + manual marking, no
 * terminal/operations/admin surfaces). Self-sufficient: verifies the token
 * itself, so it can replace requireAuth 1:1 on protected routes.
 */
export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    try {
      const admin = verifyToken(authHeader.slice(7));
      (req as Request & { admin: JwtPayload }).admin = admin;
      if (roles.length && !roles.includes(admin.role as Role)) {
        res.status(403).json({ error: "Forbidden — insufficient role for this action" });
        return;
      }
      next();
    } catch {
      res.status(401).json({ error: "Invalid or expired token" });
    }
  };
}

export const requireStaff = requireRole("super_admin", "admin", "teacher");
export const requireAdminLevel = requireRole("super_admin", "admin");
export const requireSuperAdmin = requireRole("super_admin");
