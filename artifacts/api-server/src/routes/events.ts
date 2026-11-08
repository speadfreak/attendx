import { Router, type Request, type Response } from "express";
import { verifyToken } from "../lib/auth";
import { subscribeEvents, recentEvents, type LiveEvent } from "../lib/events";

/**
 * Server-Sent Events live stream — the push channel behind the dashboard,
 * notification center and live feeds. JWT is passed as ?token= because
 * EventSource cannot set Authorization headers. A heartbeat comment every
 * 25s keeps proxies warm; the client auto-reconnects (EventSource default)
 * and falls back to smart polling while disconnected.
 */
const router = Router();

router.get("/events/stream", (req: Request, res: Response): void => {
  const token = String(req.query.token ?? "");
  let admin: { adminId: number; email: string; role: string } | null = null;
  try {
    admin = verifyToken(token);
  } catch {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  void admin;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);

  // Replay recent events so a reconnecting client resyncs quickly
  for (const event of recentEvents(10)) {
    res.write(`event: live\ndata: ${JSON.stringify(event)}\n\n`);
  }

  const unsub = subscribeEvents((event: LiveEvent) => {
    try {
      res.write(`event: live\ndata: ${JSON.stringify(event)}\n\n`);
    } catch {
      // client gone — cleanup below on close
    }
  });

  const heartbeat = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      /* noop */
    }
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsub();
  });
});

export default router;
