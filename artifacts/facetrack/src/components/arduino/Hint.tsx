import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Tooltip wrapper so disabled controls still explain themselves.
 * Radix tooltips can't attach to a truly `disabled` <button> (no pointer
 * events), so the trigger anchors to an always-hoverable <span> around it.
 */
export function Hint({
  children,
  label,
  side = "top",
  wrapperClassName,
}: {
  children: React.ReactNode;
  label: string;
  side?: "top" | "bottom" | "left" | "right";
  wrapperClassName?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("inline-flex", wrapperClassName)}>{children}</span>
      </TooltipTrigger>
      <TooltipContent side={side} className="max-w-64 text-[11px]">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
