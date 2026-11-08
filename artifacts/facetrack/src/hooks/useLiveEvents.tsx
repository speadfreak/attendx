import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

/**
 * Live event system: Server-Sent Events push with graceful degradation.
 *  - SSE connected → invalidates react-query caches in realtime (push)
 *  - SSE dropped   → smart 10s polling fallback keeps data warm (REST)
 * Status exposed to UI: live | polling | offline
 */

export type LiveStatus = "connecting" | "live" | "polling" | "offline";

export interface LiveEvent {
  type: string;
  payload: Record<string, unknown>;
  at: string;
}

interface LiveEventsContextValue {
  status: LiveStatus;
  lastEvent: LiveEvent | null;
  events: LiveEvent[];
}

const LiveEventsContext = createContext<LiveEventsContextValue>({
  status: "connecting",
  lastEvent: null,
  events: [],
});

// Which react-query keys each event type should refresh
const INVALIDATION_MAP: Record<string, string[][]> = {
  "attendance.created": [["attendance"], ["dashboard"], ["occupancy"], ["today-attendance"]],
  "attendance.updated": [["attendance"], ["dashboard"], ["occupancy"]],
  "attendance.checkout": [["occupancy"], ["dashboard"]],
  "pi.heartbeat": [["pi"], ["operations"]],
  "job.updated": [["jobs"], ["notifications"]],
  "review.created": [["reviews"], ["notifications"]],
  "review.decided": [["reviews"], ["notifications"]],
  "qr.scan": [["qr"], ["notifications"], ["dashboard"]],
  "sms.sent": [["sms-logs"], ["notifications"]],
  "settings.updated": [["settings"], ["sms-templates"]],
};

export function LiveEventsProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [lastEvent, setLastEvent] = useState<LiveEvent | null>(null);
  const queryClient = useQueryClient();
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const ingest = (event: LiveEvent) => {
      setLastEvent(event);
      setEvents((prev) => [event, ...prev].slice(0, 100));
      const keys = INVALIDATION_MAP[event.type];
      if (keys) {
        for (const key of keys) {
          void queryClient.invalidateQueries({ queryKey: key });
        }
      }
    };

    const startPolling = () => {
      if (pollTimer.current) return;
      setStatus((s) => (s === "connecting" ? "connecting" : "polling"));
      pollTimer.current = setInterval(() => {
        void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
        void queryClient.invalidateQueries({ queryKey: ["notifications"] });
        void queryClient.invalidateQueries({ queryKey: ["attendance"] });
        void queryClient.invalidateQueries({ queryKey: ["occupancy"] });
      }, 10000);
    };

    const stopPolling = () => {
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    };

    const connect = () => {
      const token = localStorage.getItem("ft_token");
      if (!token) return;
      try {
        esRef.current?.close();
      } catch {
        /* noop */
      }
      const es = new EventSource(`/api/events/stream?token=${encodeURIComponent(token)}`);
      esRef.current = es;

      es.addEventListener("connected", () => {
        setStatus("live");
        stopPolling();
      });
      es.addEventListener("live", (e) => {
        try {
          ingest(JSON.parse((e as MessageEvent).data) as LiveEvent);
        } catch {
          /* ignore malformed */
        }
      });
      es.onopen = () => setStatus("live");
      es.onerror = () => {
        es.close();
        setStatus("polling");
        startPolling();
        // Exponential-ish reconnect (5s → 15s cap)
        if (!reconnectTimer.current) {
          reconnectTimer.current = setTimeout(() => {
            reconnectTimer.current = null;
            connect();
          }, 5000 + Math.random() * 5000);
        }
      };
    };

    connect();

    return () => {
      esRef.current?.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      stopPolling();
    };
  }, [queryClient]);

  return (
    <LiveEventsContext.Provider value={{ status, lastEvent, events }}>
      {children}
    </LiveEventsContext.Provider>
  );
}

export function useLiveEvents() {
  return useContext(LiveEventsContext);
}
