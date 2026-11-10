import { useState } from "react";
import { useListSmsLogs, type SmsLog } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { motion } from "framer-motion";
import { MessageSquare, AlertCircle, AlertTriangle, CheckCircle2, Phone } from "lucide-react";
import { format, formatDistanceToNowStrict } from "date-fns";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

type SmsLogRow = SmsLog;

/**
 * Phase 6 — honest delivery taxonomy. Never claim "sent" when the carrier
 * hasn't accepted the message. Palette: slate / emerald / red / violet only.
 */
const STATUS_FILTERS = [
  { value: "all", label: "All Statuses" },
  { value: "queued", label: "Queued" },
  { value: "sent", label: "Sent" },
  { value: "delivered", label: "Delivered" },
  { value: "undelivered", label: "Undelivered" },
  { value: "failed", label: "Failed" },
  { value: "canceled", label: "Canceled" },
  { value: "simulated", label: "Simulated" },
] as const;

const chip = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium leading-none";

function PulsingDot({ cls }: { cls: string }) {
  return (
    <span className="relative flex h-2 w-2 shrink-0">
      <span className={`absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping ${cls}`} />
      <span className={`relative inline-flex h-2 w-2 rounded-full ${cls}`} />
    </span>
  );
}

/** Honest per-status chip. Legacy rows ('sent' with no providerSid) keep the old look. */
function StatusChip({ log }: { log: SmsLogRow }) {
  const inner = (() => {
    switch (log.status) {
      case "queued":
        return (
          <span className={`${chip} border-slate-400/30 bg-slate-500/10 text-slate-600 dark:text-slate-300`}>
            <PulsingDot cls="bg-slate-400" /> Queued
          </span>
        );
      case "sent":
        // Legacy rows predate status callbacks (no providerSid) — render as before.
        return log.providerSid ? (
          <span className={`${chip} border-emerald-500/40 bg-transparent text-emerald-600 dark:text-emerald-400`}>
            Sent to carrier
          </span>
        ) : (
          <span className={`${chip} border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400`}>
            <CheckCircle2 className="h-3 w-3" /> Sent
          </span>
        );
      case "delivered":
        return (
          <span className={`${chip} border-emerald-500 bg-emerald-500 text-white`}>
            <CheckCircle2 className="h-3 w-3" /> Delivered
          </span>
        );
      case "undelivered":
        return (
          <span className={`${chip} border-destructive/25 bg-destructive/10 text-destructive`}>
            <AlertCircle className="h-3 w-3" /> Undelivered
          </span>
        );
      case "failed":
        return (
          <span className={`${chip} border-destructive/25 bg-destructive/10 text-destructive`}>
            <AlertCircle className="h-3 w-3" /> Failed
          </span>
        );
      case "canceled":
        return (
          <span className={`${chip} border-slate-400/30 bg-slate-500/10 text-slate-500`}>
            Canceled
          </span>
        );
      case "simulated":
        return (
          <span className={`${chip} border-violet-500/40 bg-transparent text-violet-600 dark:text-violet-400`}>
            Simulated
          </span>
        );
      default:
        return (
          <span className={`${chip} border-slate-400/30 bg-slate-500/10 text-slate-500`}>
            {log.status}
          </span>
        );
    }
  })();

  if (!log.errorMessage) return inner;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help">{inner}</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs bg-destructive text-destructive-foreground border-destructive/50">
          <p>{log.errorMessage}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export default function SmsLogsPage() {
  const [status, setStatus] = useState<string>("all");

  const { data: logs, isLoading, isError, error, refetch } = useListSmsLogs({
    status: status === "all" ? undefined : status
  });

  const errorMessage = error instanceof Error ? error.message : "Unknown error";

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <div className="gx-page-header flex flex-col sm:flex-row justify-between gap-4 items-start sm:items-center">
        <div>
          <h1 className="gx-title-gradient text-3xl font-bold tracking-tight">Communication Logs</h1>
          <p className="text-muted-foreground">Automated parent notifications — real carrier delivery status</p>
        </div>

        <div className="w-full sm:w-[200px]">
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="min-h-[44px]" aria-label="Filter by delivery status">
              <SelectValue placeholder="All Statuses" />
            </SelectTrigger>
            <SelectContent>
              {STATUS_FILTERS.map((s) => (
                <SelectItem key={s.value} value={s.value} className="min-h-[44px]">
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card className="gx-panel bg-card border-border">
        <CardContent className="p-0">
          {isError ? (
            <div className="gx-empty-tint flex flex-col items-center justify-center gap-3 rounded-md m-4 border border-destructive/30 bg-destructive/5 px-6 py-10 text-center">
              <AlertTriangle className="w-8 h-8 text-destructive" />
              <div>
                <p className="font-medium text-destructive">Failed to load SMS logs</p>
                <p className="mt-1 text-sm text-muted-foreground">{errorMessage}</p>
              </div>
              <Button variant="outline" size="sm" className="gx-glow-hover" onClick={() => refetch()}>
                Retry
              </Button>
            </div>
          ) : (
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow className="gx-table-head">
                <TableHead>Recipient</TableHead>
                <TableHead>Phone Number</TableHead>
                <TableHead className="w-1/3">Message</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Timestamp</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array(5).fill(0).map((_, i) => (
                  <TableRow key={i}>
                    {Array(5).fill(0).map((_, j) => (
                      <TableCell key={j}><Skeleton className="h-5 w-full" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : logs?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="gx-empty-tint h-32 text-center text-muted-foreground">
                    <MessageSquare className="w-8 h-8 mx-auto mb-2 opacity-50" />
                    No SMS logs found.
                  </TableCell>
                </TableRow>
              ) : (
                logs?.map((log) => (
                  <TableRow key={log.id} className="hover:bg-muted/30">
                    <TableCell className="font-medium text-sm">{log.studentName}'s Parent</TableCell>
                    <TableCell className="text-muted-foreground font-mono text-xs">
                      <div className="flex items-center gap-1.5">
                        <Phone className="w-3 h-3" />
                        {log.parentPhone}
                      </div>
                      {log.channel && log.channel !== "sms" && (
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70">{log.channel}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      <p className="text-xs text-muted-foreground truncate max-w-[300px]" title={log.message}>
                        {log.message}
                      </p>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <StatusChip log={log} />
                        {log.errorCode && (
                          <span className="gx-chip gx-chip-amber font-mono">
                            err {log.errorCode}
                          </span>
                        )}
                      </div>
                      {log.errorHint && (
                        <p className="mt-1 max-w-[260px] text-[11px] leading-snug text-muted-foreground">
                          <span className="font-medium">{log.errorHint.title}:</span> {log.errorHint.fix}
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground font-mono text-xs">
                      <div>{format(new Date(log.sentAt), 'MMM d, HH:mm')}</div>
                      {log.statusUpdatedAt && (
                        <div className="font-sans text-[10px] text-muted-foreground/70">
                          status {formatDistanceToNowStrict(new Date(log.statusUpdatedAt), { addSuffix: true })}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}
