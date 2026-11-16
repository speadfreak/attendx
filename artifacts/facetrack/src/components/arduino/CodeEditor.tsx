import { useEffect, useMemo, useRef, useState } from "react";
import { highlightCpp } from "@/lib/arduino/highlight";
import { cn } from "@/lib/utils";

/**
 * Arduino Lab — lightweight IDE code editor.
 *
 * Transparent <textarea> stacked over a highlighted <pre> (same font metrics,
 * same padding) with a synchronized line-number gutter. Tab inserts two
 * spaces; Ctrl/Cmd+Enter fires the compile callback. No editor dependency —
 * the whole surface stays inside the bundle budget.
 */

const FONT_CLASSES = "font-mono text-[11.5px] leading-[1.55]";
const PAD_CLASSES = "px-3 py-2";

interface CodeEditorProps {
  value: string;
  onChange: (next: string) => void;
  /** Fired on Ctrl/Cmd+Enter. */
  onCompile?: () => void;
  ariaLabel: string;
  maxHeightClass?: string;
  disabled?: boolean;
  /** Tailwind classes for the frame. */
  className?: string;
}

export function CodeEditor({
  value,
  onChange,
  onCompile,
  ariaLabel,
  maxHeightClass = "max-h-[420px]",
  disabled = false,
  className,
}: CodeEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);

  const lineCount = useMemo(() => value.split("\n").length, [value]);
  const htmlLines = useMemo(() => highlightCpp(value), [value]);
  const gutter = useMemo(() => Array.from({ length: lineCount }, (_, i) => i + 1), [lineCount]);

  // Vertical scroll of the textarea drags the gutter; horizontal scroll drags
  // the highlight layer (the textarea scrolls itself, the pre is clipped).
  const syncScroll = () => {
    const el = textareaRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    if (preRef.current) {
      preRef.current.scrollLeft = el.scrollLeft;
    }
  };

  useEffect(() => {
    syncScroll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      onCompile?.();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const el = event.currentTarget;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const next = `${value.slice(0, start)}  ${value.slice(end)}`;
      onChange(next);
      // Defer caret restore until React has flushed the new value.
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.selectionStart = start + 2;
          textareaRef.current.selectionEnd = start + 2;
        }
      });
    }
  };

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-lg border border-slate-800 bg-slate-950/95 focus-within:border-emerald-500/40",
        className,
      )}
    >
      <div className={cn("flex", maxHeightClass)}>
        {/* line-number gutter */}
        <div
          ref={gutterRef}
          aria-hidden="true"
          className={cn(
            "shrink-0 select-none overflow-hidden border-r border-slate-800/80 bg-slate-950 text-right",
            FONT_CLASSES,
            PAD_CLASSES,
          )}
          style={{ width: "3.2rem" }}
        >
          <div style={{ transform: `translateY(-${scrollTop}px)` }}>
            {gutter.map((n) => (
              <div key={n} className="text-slate-600">
                {n}
              </div>
            ))}
          </div>
        </div>

        {/* code surface: highlighted layer under a transparent textarea */}
        <div className="relative min-w-0 flex-1">
          <pre
            ref={preRef}
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-0 overflow-hidden whitespace-pre",
              FONT_CLASSES,
              PAD_CLASSES,
            )}
            style={{ margin: 0 }}
          >
            {htmlLines.map((line, i) => (
              <div key={i} dangerouslySetInnerHTML={{ __html: `${line}\n` }} />
            ))}
          </pre>
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onScroll={syncScroll}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            wrap="off"
            aria-label={ariaLabel}
            className={cn(
              "absolute inset-0 h-full w-full resize-none overflow-auto whitespace-pre bg-transparent text-transparent caret-emerald-300 outline-none",
              FONT_CLASSES,
              PAD_CLASSES,
              "[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-700/70 [&::-webkit-scrollbar-track]:bg-transparent",
              disabled && "cursor-not-allowed opacity-60",
            )}
          />
        </div>
      </div>
    </div>
  );
}
