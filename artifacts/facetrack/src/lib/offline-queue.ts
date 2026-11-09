/**
 * AttendX Phase 6 — offline kiosk spool.
 *
 * Zero-dependency IndexedDB wrapper that buffers QR scans taken while the
 * door terminal has no WiFi, and flushes them to `POST /qr/scan/batch` when
 * connectivity returns. Field names mirror the server `scanInput` zod schema
 * in artifacts/api-server/src/routes/qr.ts EXACTLY:
 *
 *   token       string  (6..2000)
 *   terminalId  string  (optional, ≤80)
 *   classroomId number  (optional, int > 0)
 *   latitude    number  (optional/nullable, -90..90)
 *   longitude   number  (optional/nullable, -180..180)
 *   accuracy    number  (optional/nullable, 0..100000)  ← server field is `accuracy`
 *   nonce       string  (8..80, client idempotency key — one nonce = one outcome)
 *   scannedAt   string  (ISO datetime with offset — the moment of the scan)
 *
 * Batch wire shape: `{ scans: scanInput[] }` (1..200 items). Per-item result:
 * `{ nonce, ok, result, httpCode, message, studentName?, attendanceId? }`
 * where `ok === httpCode < 400`. Flush policy:
 *   - `ok === true` (valid / duplicate / replayed) → remove from spool
 *   - 4xx (expired, revoked, geofence-violation, too-old, clock-skew…) →
 *     permanent rejection → remove (retrying can never succeed)
 *   - network failure / 5xx ("server-error") → retryable → keep for next flush
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { qrScanBatch, type QrScanBatchItem, type QrScanBatchResultItem } from "./api";

// ── DB constants ────────────────────────────────────────────────

const DB_NAME = "attendx-kiosk";
const DB_VERSION = 1;
const STORE = "pending-scans";
const NONCE_INDEX = "nonce";

/** One queued scan — wire fields match the server `scanInput` schema 1:1. */
export interface QueuedScan {
  token: string;
  terminalId?: string;
  classroomId?: number;
  /** ISO timestamp captured at the scan moment (server `scannedAt`). */
  scannedAt: string;
  /** Client idempotency key (server `nonce`). */
  nonce: string;
  latitude?: number | null;
  longitude?: number | null;
  /** GPS accuracy in meters — named `accuracy` per the server schema. */
  accuracy?: number | null;
  /** Client bookkeeping: when this item entered the spool. */
  queuedAt: string;
}

/** A queued scan as stored (autoIncrement primary key assigned by IndexedDB). */
export interface StoredScan extends QueuedScan {
  id: number;
}

export interface FlushOutcome {
  sender: string;
  /** Items that were in the spool when the flush started. */
  attempted: number;
  /** Accepted by the server (`ok: true`, includes nonce replays). */
  accepted: number;
  /** Permanently rejected (4xx) — removed from the spool. */
  rejected: number;
  /** Left in the spool for a later flush (network failure / 5xx). */
  retryable: number;
  networkError: boolean;
  results: QrScanBatchResultItem[];
}

// ── crypto nonce helper (secure-context independent) ────────────

/** crypto.randomUUID() with a v4 fallback for non-secure kiosk origins. */
export function newNonce(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10, 16).join("")}`;
}

// ── change notification (hook recount after enqueue/flush) ─────

type QueueListener = () => void;
const listeners = new Set<QueueListener>();

/** Subscribe to spool changes (enqueue / removal). Returns unsubscribe. */
export function subscribeQueue(listener: QueueListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emitQueueChanged(): void {
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* a broken listener must never break the spool */
    }
  }
}

// ── IndexedDB plumbing ──────────────────────────────────────────

function hasIndexedDB(): boolean {
  return typeof indexedDB !== "undefined";
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!hasIndexedDB()) return Promise.reject(new Error("IndexedDB unavailable"));
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
          store.createIndex(NONCE_INDEX, "nonce", { unique: false });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // A later-version delete/close elsewhere shouldn't poison the cache.
        db.onclose = () => {
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        dbPromise = null;
        reject(req.error ?? new Error("Failed to open attendx-kiosk IndexedDB"));
      };
      req.onblocked = () => {
        dbPromise = null;
        reject(new Error("attendx-kiosk IndexedDB upgrade blocked by another tab"));
      };
    });
  }
  return dbPromise;
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
  });
}

// ── Public spool API ────────────────────────────────────────────

/** Buffer one scan for later sync. Resolves with the assigned row id. */
export async function enqueueScan(item: Omit<QueuedScan, "queuedAt">): Promise<number | null> {
  if (!hasIndexedDB()) return null;
  const record: QueuedScan = { ...item, queuedAt: new Date().toISOString() };
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  const id = await requestToPromise(tx.objectStore(STORE).add(record) as IDBRequest<IDBValidKey>);
  await txDone(tx);
  emitQueueChanged();
  return typeof id === "number" ? id : null;
}

/** All queued scans, oldest first (flush order). */
export async function listScans(): Promise<StoredScan[]> {
  if (!hasIndexedDB()) return [];
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  const rows = await requestToPromise(tx.objectStore(STORE).getAll() as IDBRequest<StoredScan[]>);
  return rows.sort((a, b) => a.id - b.id);
}

/** Remove spooled scans by primary key (after a successful flush). */
export async function removeScanIds(ids: number[]): Promise<void> {
  if (!hasIndexedDB() || ids.length === 0) return;
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  for (const id of ids) store.delete(id);
  await txDone(tx);
  emitQueueChanged();
}

/** Number of scans waiting in the spool. */
export async function countScans(): Promise<number> {
  if (!hasIndexedDB()) return 0;
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  return requestToPromise(tx.objectStore(STORE).count());
}

const BATCH_MAX = 200; // server: z.array(scanInput).min(1).max(200)

function toBatchItem(scan: StoredScan): QrScanBatchItem {
  return {
    token: scan.token,
    terminalId: scan.terminalId,
    classroomId: scan.classroomId,
    scannedAt: scan.scannedAt,
    nonce: scan.nonce,
    latitude: scan.latitude,
    longitude: scan.longitude,
    accuracy: scan.accuracy,
  };
}

function isPermanentRejection(item: QrScanBatchResultItem): boolean {
  // 4xx verdicts (expired, revoked, geofence-violation, too-old, …) can never
  // succeed on retry — drop them so the spool doesn't retry forever.
  return item.httpCode >= 400 && item.httpCode < 500;
}

let flushInFlight = false;

/**
 * Push the spool to POST /qr/scan/batch. Safe no-op when empty, when the
 * browser reports offline, when IndexedDB is unavailable, or when another
 * flush is already running (concurrent-flush lock). Never throws — network
 * failures leave every item spooled and are reported via `networkError`.
 */
export async function flushQueue(sender = "auto"): Promise<FlushOutcome | null> {
  if (!hasIndexedDB() || flushInFlight) return null;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return null;
  flushInFlight = true;
  try {
    const all = await listScans();
    if (all.length === 0) return null; // safe no-op when empty

    const removedIds: number[] = [];
    const results: QrScanBatchResultItem[] = [];
    let acceptedCount = 0;
    let networkError = false;

    for (let i = 0; i < all.length; i += BATCH_MAX) {
      const chunk = all.slice(i, i + BATCH_MAX);
      try {
        const res = await qrScanBatch(chunk.map(toBatchItem));
        const batchResults = res?.results ?? [];
        results.push(...batchResults);
        const byNonce = new Map(batchResults.map((r) => [r.nonce ?? "", r]));
        for (const scan of chunk) {
          const outcome = byNonce.get(scan.nonce);
          // Missing per-item result (server error mid-batch) → retryable, keep.
          if (!outcome) continue;
          if (outcome.ok) {
            removedIds.push(scan.id); // accepted (valid / duplicate / nonce replay)
            acceptedCount += 1;
          } else if (isPermanentRejection(outcome)) {
            removedIds.push(scan.id); // permanent 4xx — never retry
          }
        }
      } catch (err) {
        // Batch-level failure (auth / network / 5xx with no per-item results).
        const status = (err as { status?: number }).status;
        if (status === 401 || status === 403) {
          // Not signed in as staff — flushing is pointless until re-login.
          networkError = false;
          break;
        }
        networkError = true;
      }
    }

    if (removedIds.length > 0) {
      await removeScanIds(removedIds);
    }

    return {
      sender,
      attempted: all.length,
      accepted: acceptedCount,
      rejected: removedIds.length - acceptedCount,
      retryable: all.length - removedIds.length,
      networkError,
      results,
    };
  } finally {
    flushInFlight = false;
  }
}

// ── React hook ──────────────────────────────────────────────────

export interface OfflineSyncState {
  /** Scans waiting in the spool. */
  pending: number;
  /** True while a flush round-trip is in flight. */
  syncing: boolean;
  /** Last time a flush actually reached the server (null = never). */
  lastSyncAt: Date | null;
  /** navigator.onLine snapshot, updated via online/offline events. */
  online: boolean;
  /** Manual "Sync now" trigger. */
  flushNow: () => Promise<void>;
}

/**
 * Offline-sync state for the kiosk UI. Recounts the spool after every
 * enqueue/flush (via subscribeQueue), auto-flushes on `online` and
 * `visibilitychange`, and polls every 30s while items are pending.
 */
export function useOfflineSync(): OfflineSyncState {
  const [pending, setPending] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<Date | null>(null);
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));

  const mountedRef = useRef(true);
  const syncingRef = useRef(false);
  const pendingRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const recount = useCallback(async () => {
    try {
      const n = await countScans();
      pendingRef.current = n;
      if (mountedRef.current) setPending(n);
    } catch {
      /* spool unreadable → treat as empty */
    }
  }, []);

  const runFlush = useCallback(
    async (sender: string) => {
      if (syncingRef.current) return;
      syncingRef.current = true;
      if (mountedRef.current) setSyncing(true);
      try {
        const outcome = await flushQueue(sender);
        if (outcome && mountedRef.current) setLastSyncAt(new Date());
      } catch {
        /* flushQueue never throws, belt-and-braces */
      } finally {
        syncingRef.current = false;
        if (mountedRef.current) {
          setSyncing(false);
          void recount();
        }
      }
    },
    [recount],
  );

  const flushNow = useCallback(() => runFlush("manual"), [runFlush]);

  useEffect(() => {
    void recount();
    const unsubscribe = subscribeQueue(() => {
      void recount(); // pending count updates after every enqueue/flush
    });

    const handleOnline = () => {
      setOnline(true);
      void runFlush("online");
    };
    const handleOffline = () => setOnline(false);
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        void recount();
        if (pendingRef.current > 0) void runFlush("visibility");
      }
    };
    // 30s poll — only fires a flush while items are pending.
    const interval = window.setInterval(() => {
      if (pendingRef.current > 0) void runFlush("interval");
    }, 30_000);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      unsubscribe();
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.clearInterval(interval);
    };
  }, [recount, runFlush]);

  return { pending, syncing, lastSyncAt, online, flushNow };
}
