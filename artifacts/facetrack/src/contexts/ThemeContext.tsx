import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/* ============================================================
   ATTENDX DUAL-THEME ENGINE
   light / dark / system with:
   - localStorage persistence ("ft_theme" — keep in sync with
     the no-FOUC boot script in index.html)
   - live OS preference tracking while in "system"
   - cross-tab sync via the storage event
   - browser chrome theming (meta theme-color + color-scheme)
   - a brief `theme-anim` mount so the palette cross-fades
     instead of snapping (skipped for reduced-motion users)
   ============================================================ */

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "ft_theme";

/** Browser-chrome colors kept in lockstep with the boot script. */
export const THEME_META_COLORS: Record<ResolvedTheme, string> = {
  light: "#f6f3fc",
  dark: "#070311",
};

const SYSTEM_MQ = "(prefers-color-scheme: dark)";

function readStoredMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    return raw === "light" || raw === "dark" || raw === "system" ? raw : "dark";
  } catch {
    return "dark";
  }
}

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia(SYSTEM_MQ).matches;
  } catch {
    return true;
  }
}

function resolveMode(mode: ThemeMode): ResolvedTheme {
  if (mode === "system") return systemPrefersDark() ? "dark" : "light";
  return mode;
}

function applyTheme(resolved: ResolvedTheme, animate: boolean) {
  const root = document.documentElement;
  const changed = root.classList.contains("dark") !== (resolved === "dark");

  if (animate && changed && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    root.classList.add("theme-anim");
    window.setTimeout(() => root.classList.remove("theme-anim"), 320);
  }

  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
  root.dataset.theme = resolved;

  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = THEME_META_COLORS[resolved];
}

interface ThemeContextValue {
  /** The stored preference: light, dark or system. */
  mode: ThemeMode;
  /** The theme actually painted right now. */
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
  /** Quick flip used by compact toggles: light <-> dark (leaves system). */
  flip: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => readStoredMode());
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveMode(readStoredMode()));

  // Paint on mount (idempotent — the boot script already did the work pre-paint).
  useEffect(() => {
    applyTheme(resolveMode(mode), false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Track the OS preference live while in "system" mode.
  useEffect(() => {
    const mq = window.matchMedia(SYSTEM_MQ);
    const onChange = () => {
      if (mode !== "system") return;
      const next = resolveMode("system");
      applyTheme(next, true);
      setResolved(next);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [mode]);

  // Cross-tab sync.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== THEME_STORAGE_KEY || e.newValue == null) return;
      if (e.newValue === "light" || e.newValue === "dark" || e.newValue === "system") {
        setModeState(e.newValue);
        const next = resolveMode(e.newValue);
        applyTheme(next, true);
        setResolved(next);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setMode = useCallback((next: ThemeMode) => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* private mode — session-only theme */
    }
    setModeState(next);
    const nextResolved = resolveMode(next);
    applyTheme(nextResolved, true);
    setResolved(nextResolved);
  }, []);

  const flip = useCallback(() => {
    setMode(resolveMode(mode) === "dark" ? "light" : "dark");
  }, [mode, setMode]);

  const value = useMemo(
    () => ({ mode, resolved, setMode, flip }),
    [mode, resolved, setMode, flip],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
