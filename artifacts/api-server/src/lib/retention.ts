import { and, eq, lte } from "drizzle-orm";
import { db, matchReviewsTable } from "@workspace/db";
import { logger } from "./logger";

export async function purgeExpiredRejectedReviews(): Promise<number> {
  const removed = await db
    .delete(matchReviewsTable)
    .where(
      and(
        eq(matchReviewsTable.status, "rejected"),
        lte(matchReviewsTable.purgeAt, new Date()),
      ),
    )
    .returning({ id: matchReviewsTable.id });

  if (removed.length > 0) {
    logger.info({ count: removed.length }, "Expired rejected face reviews purged");
  }
  return removed.length;
}

export function startReviewRetentionWorker(): void {
  const timer = setInterval(() => {
    void purgeExpiredRejectedReviews().catch((error) => {
      logger.error({ err: error }, "Rejected review retention cleanup failed");
    });
  }, 60 * 60 * 1000);
  timer.unref?.();
  void purgeExpiredRejectedReviews().catch((error) => {
    logger.error({ err: error }, "Initial rejected review retention cleanup failed");
  });
}
