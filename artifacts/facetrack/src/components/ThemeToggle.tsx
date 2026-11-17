import { Monitor, Moon, Sun, SunMoon } from "lucide-react";
import { useTheme, type ThemeMode } from "@/contexts/ThemeContext";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/* ============================================================
   AttendX theme switch — sun / moon / monitor trinity.
   The trigger shows the STORED mode (so "system" reads as its
   own state, not the current OS answer); the menu offers all
   three with a radio check. Every mode change is persisted,
   synced cross-tab and cross-faded by the ThemeContext.
   ============================================================ */

const MODE_ICON: Record<ThemeMode, typeof Sun> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};

const MODE_LABEL: Record<ThemeMode, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

export function ThemeToggle({
  className,
  compact = false,
}: {
  className?: string;
  /** Renders a tighter trigger for kiosks / dense toolbars. */
  compact?: boolean;
}) {
  const { mode, setMode } = useTheme();
  const Icon = MODE_ICON[mode];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Theme: ${MODE_LABEL[mode]}. Switch theme`}
          title={`Theme: ${MODE_LABEL[mode]}`}
          className={cn(
            "relative text-foreground/40 hover:text-primary hover:bg-primary/10 active:scale-95 transition-all gx-glow-hover",
            compact && "h-7 w-7",
            className,
          )}
        >
          <Icon className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="min-w-44">
        <DropdownMenuLabel className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          <SunMoon className="h-3 w-3" aria-hidden="true" />
          Appearance
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup value={mode} onValueChange={(v) => setMode(v as ThemeMode)}>
          <DropdownMenuRadioItem value="light">
            <Sun className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
            Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
            Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <Monitor className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
            System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
