import { useEffect, useRef, useState } from "react";
import { CornerDownLeft, Eraser, History, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/arduino/Hint";
import { MONITOR_LINE_COLOR, type MonitorLine } from "@/lib/arduino/serial";
import type { SketchCommand } from "@/lib/arduino/sketches";
import { cn } from "@/lib/utils";

/**
 * Arduino Lab — the Control Terminal.
 *
 * A real REPL over the Web Serial monitor: command input with persistent
 * history (↑/↓), Enter to send, per-sketch macro chips, and a color-coded
 * transcript that merges board chatter with cyan "you typed" echoes.
 */

const stamp = (d: Date): string =>
  `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;

const SCROLLBAR_CLASSES =
  "[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-700/80 [&::-webkit-scrollbar-track]:bg-transparent";

export interface SerialTerminalProps {
  lines: MonitorLine[];
  canSend: boolean;
  disabledReason?: string | null;
  onSend: (line: string) => void;
  onClear: () => void;
  macros?: SketchCommand[];
  placeholder?: string;
}

export function SerialTerminal({
  lines,
  canSend,
  disabledReason,
  onSend,
  onClear,
  macros = [],
  placeholder = "type a command — PING, STATUS, LED ON…",
}: SerialTerminalProps) {
  const [input, setInput] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyRef = useRef<string[]>([]);
  const historyIdxRef = useRef<number>(-1);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [autoscroll, setAutoscroll] = useState(true);

  // Persisted per-session history across panel remounts.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("atx_arduino_terminal_history");
      if (raw) historyRef.current = JSON.parse(raw) as string[];
    } catch {
      /* ignore corrupt history */
    }
  }, []);

  useEffect(() => {
    if (!autoscroll) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, autoscroll]);

  const pushHistory = (line: string) => {
    const list = historyRef.current;
    if (list[list.length - 1] !== line) list.push(line);
    if (list.length > 60) list.splice(0, list.length - 60);
    historyIdxRef.current = -1;
    try {
      sessionStorage.setItem("atx_arduino_terminal_history", JSON.stringify(list));
    } catch {
      /* session-only fallback */
    }
  };

  const send = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed || !canSend) return;
    pushHistory(trimmed);
    onSend(trimmed);
    setInput("");
    setHistoryOpen(false);
  };

  const handleKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      send(input);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      const list = historyRef.current;
      if (list.length === 0) return;
      if (historyIdxRef.current < 0) historyIdxRef.current = list.length - 1;
      else historyIdxRef.current = Math.max(0, historyIdxRef.current - 1);
      setInput(list[historyIdxRef.current] ?? "");
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const list = historyRef.current;
      if (historyIdxRef.current < 0) return;
      historyIdxRef.current += 1;
      if (historyIdxRef.current >= list.length) {
        historyIdxRef.current = -1;
        setInput("");
      } else {
        setInput(list[historyIdxRef.current] ?? "");
      }
    }
  };

  return (
    <div className="mt-3 space-y-2">
      {/* macro chips */}
      {macros.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {macros.map((m) => (
            <Hint key={m.cmd} label={m.hint ?? `Send "${m.cmd}"`}>
              <Button
                variant="outline"
                size="sm"
                className="h-7 border-border bg-muted px-2.5 font-mono text-[10px] text-cyan-300 hover:border-cyan-500/40 hover:bg-cyan-500/10"
                disabled={!canSend}
                onClick={() => send(m.cmd)}
                aria-label={`Send ${m.cmd} to the board`}
              >
                {m.label}
              </Button>
            </Hint>
          ))}
        </div>
      )}

      {/* transcript */}
      <div
        ref={scrollRef}
        role="log"
        aria-label="Control terminal transcript"
        aria-live="polite"
        className={cn(
          "h-64 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950/90 p-3 font-mono text-[11px] leading-relaxed",
          SCROLLBAR_CLASSES,
        )}
      >
        {lines.length === 0 ? (
          <p className="text-slate-600">
            board output lands here once the monitor runs — every line you send echoes in cyan
          </p>
        ) : (
          lines.map((l) => (
            <div key={l.id} className="whitespace-pre-wrap break-all">
              <span className="text-slate-600">{stamp(l.at)}</span>{" "}
              <span className={MONITOR_LINE_COLOR[l.kind]}>{l.text}</span>
            </div>
          ))
        )}
      </div>

      {/* input line */}
      <div className="flex items-center gap-2">
        <div
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded-lg border bg-muted px-3 py-1.5",
            canSend ? "border-border focus-within:border-cyan-500/50" : "border-border/60 opacity-60",
          )}
        >
          <Terminal className="h-3.5 w-3.5 shrink-0 text-cyan-400/70" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setHistoryOpen(false);
            }}
            onKeyDown={handleKey}
            disabled={!canSend}
            title={disabledReason ?? undefined}
            aria-label="Serial command input"
            aria-disabled={!canSend}
            placeholder={canSend ? placeholder : (disabledReason ?? "connect + start the monitor first")}
            className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-cyan-800 caret-cyan-600 outline-none placeholder:text-muted-foreground/70 dark:text-cyan-100 dark:caret-cyan-300"
          />
          <span className="hidden shrink-0 items-center gap-1 text-[10px] text-muted-foreground sm:flex">
            <kbd className="rounded border border-border px-1">↵</kbd> send
            <kbd className="ml-1 rounded border border-border px-1">↑</kbd> history
          </span>
        </div>
        <Hint label="Send the current line">
          <Button
            size="sm"
            className="min-h-9 bg-cyan-500 font-semibold text-slate-950 hover:bg-cyan-400"
            disabled={!canSend || !input.trim()}
            onClick={() => send(input)}
            aria-label="Send command"
          >
            <CornerDownLeft className="h-4 w-4" aria-hidden="true" />
          </Button>
        </Hint>
        <Hint label={`${historyRef.current.length} commands this session — toggle the history strip`}>
          <Button
            variant="outline"
            size="sm"
            className="min-h-9 border-border"
            onClick={() => setHistoryOpen((v) => !v)}
            aria-label="Toggle command history"
            aria-pressed={historyOpen}
          >
            <History className="h-4 w-4" aria-hidden="true" />
          </Button>
        </Hint>
        <Hint label="Wipe the transcript (history is kept)">
          <Button
            variant="outline"
            size="sm"
            className="min-h-9 border-border"
            onClick={onClear}
            aria-label="Clear terminal transcript"
          >
            <Eraser className="h-4 w-4" aria-hidden="true" />
          </Button>
        </Hint>
      </div>

      {historyOpen && (
        <div className={cn("max-h-32 overflow-y-auto rounded-lg border border-border bg-card/80 p-2", SCROLLBAR_CLASSES)}>
          {historyRef.current.length === 0 ? (
            <p className="px-1 text-[11px] text-muted-foreground">nothing sent yet</p>
          ) : (
            historyRef.current
              .slice()
              .reverse()
              .map((h, i) => (
                <button
                  key={`${h}-${i}`}
                  type="button"
                  className="block w-full truncate rounded px-1.5 py-0.5 text-left font-mono text-[11px] text-muted-foreground hover:bg-foreground/10 hover:text-cyan-700 dark:hover:text-cyan-200"
                  onClick={() => {
                    setInput(h);
                    setHistoryOpen(false);
                    inputRef.current?.focus();
                  }}
                  aria-label={`Reuse command ${h}`}
                >
                  {h}
                </button>
              ))
          )}
        </div>
      )}
    </div>
  );
}
