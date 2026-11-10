import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { ensureSchemaMiddleware } from "./lib/schema-bootstrap";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Self-heal the Phase 6 schema (migration 0007) before any API route runs.
// Memoized per process — ~free after the first call; on failure it logs
// loudly and lets requests continue (degraded) instead of 500-ing.
app.use(ensureSchemaMiddleware());

app.use("/api", router);

export default app;
