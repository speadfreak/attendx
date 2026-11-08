// AttendX API — serverless entrypoint.
// maxDuration keeps the SSE live-event stream (and face/bulk operations) alive
// as long as the plan allows; the client auto-reconnects and falls back to
// polling if the stream is recycled earlier.
import app from "../artifacts/api-server/src/app";

export default app;

export const maxDuration = 60;
