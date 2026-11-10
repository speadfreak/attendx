import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useListSmsLogs, getListSmsLogsQueryKey, retrySmsLog, retryFailedSmsLogs, type SmsLog } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { motion } from "framer-motion";
import {
  MessageSquare, AlertCircle, AlertTriangle, CheckCircle2, Phone, RefreshCw,
  RotateCcw, Zap, Loader2,
} from "lucide-react";
import { format, formatDistanceToNowStrict } from "date-fns";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";

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

/** Statuses whose rows can be re-sent through the gateway. */
const RETRYABLE = new Set(["failed", "undelivered"]);

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
          <span
            title="Waiting on the gateway — the delivery verdict (sent/delivered/failed) upgrades this row automatically. The page polls every 20s while any row is pending."
            className={`${chip} border-slate-400/30 bg-slate-500/10 text-slate-600 dark:text-slate-300`}
          >
            <PulsingDot cls="bg-slate-400" /> Queued
          </span>
        );
      case "sent":
        // Legacy rows predate status callbacks (no providerSid) — render as before.
        return log.providerSid ? (
          <span
            title="Accepted by the gateway — awaiting final delivery confirmation (checked automatically)."
            className={`${chip} border-emerald-500/40 bg-transparent text-emerald-600 dark:text-emerald-400`}
          >
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
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // T4: auto-refresh — poll every 20s while any visible row still awaits a
  // carrier verdict (queued/sent); stop polling once every row is final.
  // Background tab never polls (refetchIntervalInBackground: false).
  const listParams = { status: status === "all" ? undefined : status };
  const { data: logs, isLoading, isError, error, refetch } = useListSmsLogs(
    listParams,
    {
      query: {
        queryKey: getListSmsLogsQueryKey(listParams),
        refetchInterval: (query) => {
          const rows = query.state.data as SmsLog[] | undefined;
          return rows?.some((r) => r.status === "queued" || r.status === "sent") ? 20_000 : false;
        },
        refetchIntervalInBackground: false,
      },
    },
  );

  const refreshSmsData = () => {
    // Prefix key matches the list (all filter variants) + the health endpoint.
    void queryClient.invalidateQueries({ queryKey: ["/api/sms-logs"] });
    void queryClient.invalidateQueries({ queryKey: ["sms-health"] });
  };

  // ── Insane retry engine ─────────────────────────────────────────────
  // Per-row retry: re-sends the exact message through the active gateway.
  // The failed row is never rewritten — a NEW row with retry lineage appears
  // and runs its own honest queued → sent/delivered/failed lifecycle.
  const retryOne = useMutation({
    mutationFn: ({ id }: { id: number }) => retrySmsLog(id),
    onSuccess: (result) => {
      refreshSmsData();
      if (result.error == null && result.status !== "failed") {
        toast({
          title: `Retry accepted — attempt #${result.retryLogId ?? "?"} is on its way`,
          description: "The gateway queued the message. Delivery status upgrades automatically.",
        });
      } else {
        toast({
          title: "Retry failed",
          description: result.error ?? "The gateway rejected the message — check the new log row for the reason.",
          variant: "destructive",
        });
      }
    },
    onError: (err: unknown) => {
      toast({
        title: "Retry failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  // Retry ALL failed rows that don't have a newer attempt yet — newest
  // first, capped at 40 per run, concurrency-limited server-side.
  const retryAll = useMutation({
    mutationFn: () => retryFailedSmsLogs(undefined),
    onSuccess: (summary) => {
      refreshSmsData();
      if (summary.attempted === 0) {
        toast({
          title: summary.skipped > 0 ? "Retries already in flight" : "Nothing to retry",
          description:
            summary.skipped > 0
              ? "Every failed message already has a retry running — give it a few seconds."
              : "No failed messages are waiting for a first retry.",
        });
        return;
      }
      toast({
        title: `Re-sent ${summary.accepted} of ${summary.attempted} message${summary.attempted === 1 ? "" : "s"}`,
        description:
          summary.failed > 0
            ? `${summary.failed} could not be re-sent — their new rows show why.`
            : "All retries were accepted by the gateway.",
        variant: summary.failed > 0 ? "destructive" : "default",
      });
    },
    onError: (err: unknown) => {
      toast({
        title: "Bulk retry failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  // T4: on-demand "check with carrier now" — forces a reconcile sweep
  // server-side, then refreshes the visible rows.
  const [reconciling, setReconciling] = useState(false);
  const [reconcileNote, setReconcileNote] = useState<string | null>(null);
  const runReconcile = async () => {
    setReconciling(true);
    setReconcileNote(null);
    try {
      const summary = await api.smsReconcile();
      await refetch();
      setReconcileNote(
        summary.checked === 0
          ? "Updated just now — nothing pending"
          : `Updated just now — checked ${summary.checked}, upgraded ${summary.upgraded}`,
      );
    } catch (err: unknown) {
      setReconcileNote(err instanceof Error ? err.message : "Status check failed");
    } finally {
      setReconciling(false);
    }
  };

  const errorMessage = error instanceof Error ? error.message : "Unknown error";

  // Failed rows still waiting for their FIRST retry — the "Retry all" target.
  const failedRows = logs?.filter((r) => RETRYABLE.has(r.status) && !r.hasRetry) ?? [];
  const retryingOneId = retryOne.isPending ? retryOne.variables?.id : undefined;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <div className="gx-page-header flex flex-col sm:flex-row justify-between gap-4 items-start sm:items-center">
        <div>
          <h1 className="gx-title-gradient text-3xl font-bold tracking-tight">Communication Logs</h1>
          <p className="text-muted-foreground">Automated parent notifications — real carrier delivery status</p>
        </div>

        <div className="flex w-full flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-end sm:gap-3">
          {reconcileNote && (
            <p className={`text-xs ${reconcileNote.includes("just now") ? "text-muted-foreground" : "text-destructive"}`}>
              {reconcileNote}
            </p>
          )}
          <Button
            variant="outline"
            size="sm"
            className="gx-glow-hover shrink-0"
            onClick={() => void runReconcile()}
            disabled={reconciling}
            aria-label="Check delivery status with the gateway now"
          >
            <RefreshCw className={`w-4 h-4 ${reconciling ? "animate-spin" : ""}`} />
            Check delivery status
          </Button>
          {failedRows.length > 0 && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  disabled={retryAll.isPending}
                  aria-label={`Retry all ${failedRows.length} failed messages`}
                >
                  {retryAll.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Zap className="w-4 h-4" />
                  )}
                  Retry failed ({failedRows.length})
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Re-send {failedRows.length} failed message{failedRows.length === 1 ? "" : "s"}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Each failed message is re-sent to its parent through the active gateway. Rows you already
                    retried once are skipped automatically, so nobody gets double texts. New attempt rows will
                    appear here and track their own delivery status.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive text-white hover:bg-destructive/90"
                    onClick={() => retryAll.mutate()}
                  >
                    <Zap className="w-4 h-4 mr-1.5" />
                    Retry {failedRows.length} now
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
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
                <TableHead className="text-right pr-4">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array(5).fill(0).map((_, i) => (
                  <TableRow key={i}>
                    {Array(6).fill(0).map((_, j) => (
                      <TableCell key={j}><Skeleton className="h-5 w-full" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : logs?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="gx-empty-tint h-32 text-center text-muted-foreground">
                    <MessageSquare className="w-8 h-8 mx-auto mb-2 opacity-50" />
                    No SMS logs found.
                  </TableCell>
                </TableRow>
              ) : (
                logs?.map((log) => {
                  const canRetry = RETRYABLE.has(log.status);
                  const retrying = retryingOneId === log.id;
                  return (
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
                          {log.hasRetry && (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className={`${chip} border-violet-500/40 bg-transparent text-violet-600 dark:text-violet-400`}>
                                    <RotateCcw className="h-2.5 w-2.5" /> Retried
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent className="max-w-xs">
                                  <p>A newer attempt of this message exists — check the row marked “retry of #{log.id}”.</p>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
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
                        {log.retryOfId != null && (
                          <div className="font-sans text-[10px] text-violet-600 dark:text-violet-400">
                            retry of #{log.retryOfId}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right pr-4">
                        {canRetry ? (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                            disabled={retryOne.isPending}
                            onClick={() => retryOne.mutate({ id: log.id })}
                            aria-label={`Retry message to ${log.parentPhone}`}
                          >
                            {retrying ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <RotateCcw className="w-3.5 h-3.5" />
                            )}
                            Retry
                          </Button>
                        ) : (
                          <span className="text-muted-foreground/40 text-xs" aria-hidden="true">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}
