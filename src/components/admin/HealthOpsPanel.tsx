"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type HealthSummary = {
  stockMismatches: number;
  negativeStock: number;
  orderBalanceMismatches: number;
  paymentMismatches: number;
  legacyAutoApply: number;
  ledgerMismatches: number;
  missingPostings?: Record<string, number>;
  podCompliance7d?: {
    delivered: number;
    podCaptured: number;
    podMissing: number;
    podMissingRatePct: number;
    thresholdPct: number;
    minDelivered: number;
    alert: boolean;
  };
};

type OpsResponse = {
  freshness: {
    diagnosticsAt: string | null;
    alertSentAt: string | null;
    podAlertSentAt: string | null;
    autoHealAt: string | null;
  };
  acknowledgement: {
    owner: string | null;
    note: string | null;
    acknowledgedAt: string | null;
    acknowledgedByName: string | null;
    stillCurrent: boolean;
    status?: "OPEN" | "IN_PROGRESS" | "RESOLVED";
    dueAt?: string | null;
    statusUpdatedAt?: string | null;
    statusUpdatedByName?: string | null;
    overdue?: boolean;
    needsAssignment?: boolean;
  };
  incident?: {
    id: string;
    status: "OPEN" | "IN_PROGRESS" | "RESOLVED" | "CLOSED";
    isManual: boolean;
    openedAt: string;
    resolvedAt: string | null;
    followUpDueAt: string | null;
    issueSummary: string;
    issueCount: number;
  } | null;
  activeIncidentLink?: string | null;
  trend: Array<{ date: string; issueCount: number }>;
  autoHeal: {
    enabled: boolean;
    lastRunAt: string | null;
    lastRunByName: string | null;
    lastResult: {
      posted: {
        orders: number;
        payments: number;
        expenses: number;
        purchases: number;
        supplierPayments: number;
        creditPayouts: number;
        settlements: number;
      };
    } | null;
  };
  kpis?: {
    windowDays: number;
    incidentCount: number;
    mttaHours: number | null;
    mttrHours: number | null;
    reopenRatePct: number;
    overdueRatePct: number;
  };
  kpiTrend?: Array<{
    week: string;
    mttaHours: number;
    mttrHours: number;
  }>;
  lastSentAlert?: {
    at: string | null;
    byName: string;
    recipientCount: number;
    recipients: string[];
    issueSummary: string;
    triggerSource: string;
    resultSummary: string;
  };
  lastAlertActivity?: {
    at: string | null;
    action: string;
    byName: string;
    recipientCount: number;
    issueSummary: string;
    reason: string;
    result: string;
  };
  alertRecipients?: Array<{
    name: string;
    email: string;
  }>;
  alertGuard?: {
    forceSendMaxDiagnosticsAgeHours?: number;
  };
  incidentTimeline?: Array<{
    at: string;
    byName: string;
    note: string;
  }>;
  exportLinks: {
    csv: string;
    pdf: string;
    handoff?: string;
  };
};

function fmtTime(value?: string | null) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString();
}

function formatCountdown(ms: number) {
  const abs = Math.abs(ms);
  const minutes = Math.floor(abs / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function calcIssueCount(summary?: HealthSummary | null) {
  if (!summary) return 0;
  const posting = Object.values(summary.missingPostings || {}).reduce((sum, n) => sum + Number(n || 0), 0);
  const pod = summary.podCompliance7d?.alert ? 1 : 0;
  return (
    Number(summary.stockMismatches || 0) +
    Number(summary.orderBalanceMismatches || 0) +
    Number(summary.paymentMismatches || 0) +
    Number(summary.legacyAutoApply || 0) +
    Number(summary.ledgerMismatches || 0) +
    posting +
    pod
  );
}

function severityLabel(summary?: HealthSummary | null) {
  if (!summary) return { label: "Unknown", tone: "secondary" as const };
  const posting = Object.values(summary.missingPostings || {}).reduce((sum, n) => sum + Number(n || 0), 0);
  const severe = Number(summary.ledgerMismatches || 0) > 0 || posting > 0;
  const moderate =
    Number(summary.stockMismatches || 0) > 0 ||
    Number(summary.orderBalanceMismatches || 0) > 0 ||
    Number(summary.paymentMismatches || 0) > 0 ||
    Number(summary.legacyAutoApply || 0) > 0 ||
    Boolean(summary.podCompliance7d?.alert);
  if (severe) return { label: "Critical", tone: "destructive" as const };
  if (moderate) return { label: "Warning", tone: "secondary" as const };
  return { label: "Healthy", tone: "default" as const };
}

function SlaText({ summary }: { summary?: HealthSummary | null }) {
  if (!summary) return <span className="text-muted-foreground">SLA: pending data</span>;
  const posting = Object.values(summary.missingPostings || {}).reduce((sum, n) => sum + Number(n || 0), 0);
  if (Number(summary.ledgerMismatches || 0) > 0 || posting > 0) {
    return <span className="text-rose-700">SLA: same-day (finance-impacting)</span>;
  }
  if (calcIssueCount(summary) > 0) {
    return <span className="text-amber-700">SLA: within 24 hours</span>;
  }
  return <span className="text-emerald-700">SLA met</span>;
}

function Sparkline({ trend }: { trend: Array<{ date: string; issueCount: number }> }) {
  const max = Math.max(1, ...trend.map((t) => t.issueCount));
  return (
    <div className="flex items-end gap-1 h-14" aria-label="Issue trend last 7 diagnostics">
      {trend.map((point, index) => {
        const h = Math.max(6, Math.round((point.issueCount / max) * 48));
        const title = `${point.date}: ${point.issueCount} issue(s)`;
        return (
          <div key={`${point.date}-${index}`} className="flex-1 flex flex-col items-center gap-1">
            <div title={title} className="w-full rounded-sm bg-slate-400/70" style={{ height: `${h}px` }} />
          </div>
        );
      })}
    </div>
  );
}

function MetricSparkline({
  points,
  label,
}: {
  points: Array<{ label: string; value: number }>;
  label: string;
}) {
  const max = Math.max(1, ...points.map((p) => Number(p.value || 0)));
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="flex items-end gap-1 h-12">
        {points.map((point, idx) => {
          const h = Math.max(4, Math.round((Number(point.value || 0) / max) * 38));
          return (
            <div key={`${point.label}-${idx}`} className="flex-1 flex flex-col items-center gap-1">
              <div title={`${point.label}: ${point.value}`} className="w-full rounded-sm bg-slate-400/70" style={{ height: `${h}px` }} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function HealthOpsPanel({ currentUserName }: { currentUserName: string }) {
  const [owner, setOwner] = useState(currentUserName);
  const [note, setNote] = useState("");
  const [workflowStatus, setWorkflowStatus] = useState<"OPEN" | "IN_PROGRESS" | "RESOLVED">("OPEN");
  const [workflowDueAt, setWorkflowDueAt] = useState("");
  const [busy, setBusy] = useState<"diagnostics" | "ack" | "heal" | "alerts" | "escalate" | null>(null);
  const [status, setStatus] = useState<string>("");
  const [ackAttempted, setAckAttempted] = useState(false);
  const [handoffScope, setHandoffScope] = useState<"full" | "incident">("full");
  const [handoffTimeline, setHandoffTimeline] = useState<"5" | "10" | "20">("10");
  const [alertPreview, setAlertPreview] = useState<{
    hasIssues: boolean;
    recipientCount: number;
    summary: string;
    checkedAt: string;
    recipients: Array<{ name: string; email: string }>;
  } | null>(null);
  const [forceSendReason, setForceSendReason] = useState("");
  const [incidentNote, setIncidentNote] = useState("");
  const [incidentMode, setIncidentMode] = useState<"DETECTOR_BACKED" | "OPERATIONAL_FOLLOW_UP">("DETECTOR_BACKED");
  const [incidentFollowUpDueAt, setIncidentFollowUpDueAt] = useState("");
  const [queuePreset, setQueuePreset] = useState<
    "all" | "critical" | "posting" | "operational" | "pod"
  >("all");
  const [confirmAction, setConfirmAction] = useState<null | "run_diagnostics" | "acknowledge" | "run_auto_heal" | "run_alerts_dry" | "run_alerts_send" | "run_alerts_force_send">(null);
  const forceSendReasonError =
    confirmAction === "run_alerts_force_send" && forceSendReason.trim().length < 8
      ? "Force send reason is required (minimum 8 characters)."
      : "";

  const summaryQuery = useClientQuery<HealthSummary>({
    queryKey: ["admin-health-summary"],
    queryFn: () => fetch("/api/admin/health/summary", { cache: "no-store" }).then((r) => r.json()),
  });

  const opsQuery = useClientQuery<OpsResponse>({
    queryKey: ["admin-health-ops"],
    queryFn: () => fetch("/api/admin/health/ops", { cache: "no-store" }).then((r) => r.json()),
  });

  const severity = useMemo(() => severityLabel(summaryQuery.data), [summaryQuery.data]);
  const issueCount = useMemo(() => calcIssueCount(summaryQuery.data), [summaryQuery.data]);
  const detectorModeBlocked = issueCount <= 0 && incidentMode === "DETECTOR_BACKED";
  const incidentNoteError =
    !detectorModeBlocked && incidentNote.trim().length > 0 && incidentNote.trim().length < 8
      ? "Incident note must be at least 8 characters."
      : "";
  const incidentModeError =
    detectorModeBlocked && incidentNote.trim().length > 0
      ? "No active issue signals. Choose Operational follow-up for manual documentation."
      : "";
  const acknowledgementError = useMemo(() => {
    if (workflowStatus === "RESOLVED" && note.trim().length < 12) {
      return "Resolution evidence note is required when status is Resolved (minimum 12 characters).";
    }
    if (issueCount <= 0) return "";
    if (!owner.trim()) return "Owner is required while issues are active.";
    if (note.trim().length < 8) return "Acknowledgement note must be at least 8 characters.";
    if (!workflowDueAt.trim()) return "Due date is required while issues are active.";
    const due = new Date(workflowDueAt);
    if (Number.isNaN(due.getTime())) return "Enter a valid due date.";
    if (workflowStatus !== "RESOLVED" && due.getTime() < Date.now()) {
      return "Due date cannot be in the past unless status is Resolved.";
    }
    return "";
  }, [issueCount, owner, note, workflowDueAt, workflowStatus]);
  const showAcknowledgementError = ackAttempted && Boolean(acknowledgementError);
  const dueTimingLabel = useMemo(() => {
    const dueRaw = opsQuery.data?.acknowledgement?.dueAt;
    const status = String(opsQuery.data?.acknowledgement?.status || "OPEN").toUpperCase();
    if (!dueRaw || status === "RESOLVED") return null;
    const dueAt = new Date(dueRaw);
    if (Number.isNaN(dueAt.getTime())) return null;
    const diff = dueAt.getTime() - Date.now();
    if (diff < 0) return { overdue: true, label: `Overdue by ${formatCountdown(diff)}` };
    return { overdue: false, label: `Due in ${formatCountdown(diff)}` };
  }, [opsQuery.data?.acknowledgement?.dueAt, opsQuery.data?.acknowledgement?.status]);

  useEffect(() => {
    const ack = opsQuery.data?.acknowledgement;
    if (!ack) return;
    setOwner(ack.owner || "");
    const nextStatus = String(ack.status || "OPEN").toUpperCase();
    setWorkflowStatus(
      nextStatus === "IN_PROGRESS" || nextStatus === "RESOLVED" ? nextStatus : "OPEN",
    );
    if (ack.dueAt) {
      const d = new Date(ack.dueAt);
      setWorkflowDueAt(!Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : "");
    } else {
      setWorkflowDueAt("");
    }
    const shouldClearNote = nextStatus === "RESOLVED" && issueCount === 0;
    setNote(shouldClearNote ? "" : (ack.note || ""));
  }, [opsQuery.data?.acknowledgement, issueCount]);

  useEffect(() => {
    if (!ackAttempted) return;
    if (!acknowledgementError) setAckAttempted(false);
  }, [ackAttempted, acknowledgementError]);

  const issueSignals = useMemo(() => {
    const summary = summaryQuery.data;
    if (!summary) return [] as Array<{
      id: string;
      label: string;
      count: number;
      countLabel?: string;
      severity: "critical" | "warning";
      queue: "critical" | "posting" | "operational" | "pod";
      hint: string;
      link?: string;
    }>;
    const posting = summary.missingPostings || {};
    const ledgerCount = Number(summary.ledgerMismatches || 0);
    const items = [
      {
        id: "ledger",
        label: "Ledger mismatches",
        count: ledgerCount,
        countLabel: `${ledgerCount} check${ledgerCount === 1 ? "" : "s"}`,
        severity: "critical" as const,
        queue: "critical" as const,
        hint: "Failing ledger checks across AR, inventory, AP, and trial balance. Same-day response expected.",
        link: "/admin/health#ledger-integrity",
      },
      {
        id: "posting",
        label: "Missing postings",
        count: Object.values(posting).reduce((sum, n) => sum + Number(n || 0), 0),
        severity: "critical" as const,
        queue: "posting" as const,
        hint: "Operational events without journal postings.",
        link: "/admin/health#ledger-readiness",
      },
      {
        id: "stock",
        label: "Stock mismatches",
        count: Number(summary.stockMismatches || 0),
        severity: "warning" as const,
        queue: "operational" as const,
        hint: "Product stock differs from movement totals.",
        link: "/admin/health#stock-movement-mismatches",
      },
      {
        id: "order-balance",
        label: "Order balance mismatches",
        count: Number(summary.orderBalanceMismatches || 0),
        severity: "warning" as const,
        queue: "operational" as const,
        hint: "Order balance and payment projection are inconsistent.",
        link: "/admin/health#order-balance-mismatches",
      },
      {
        id: "payment",
        label: "Payment mismatches",
        count: Number(summary.paymentMismatches || 0),
        severity: "warning" as const,
        queue: "operational" as const,
        hint: "Recorded payment allocations need investigation.",
        link: "/admin/health#payment-mismatches",
      },
      {
        id: "legacy",
        label: "Legacy auto-apply",
        count: Number(summary.legacyAutoApply || 0),
        severity: "warning" as const,
        queue: "operational" as const,
        hint: "Legacy payment note links still pending cleanup.",
        link: "/admin/health#legacy-auto-apply",
      },
      {
        id: "pod",
        label: "POD compliance alert",
        count: summary.podCompliance7d?.alert ? 1 : 0,
        severity: "warning" as const,
        queue: "pod" as const,
        hint: "Missing POD ratio exceeded configured threshold.",
        link: "/admin/health#pod-compliance",
      },
    ];
    return items.filter((item) => item.count > 0);
  }, [summaryQuery.data]);

  const visibleSignals = useMemo(() => {
    if (queuePreset === "all") return issueSignals;
    if (queuePreset === "critical") return issueSignals.filter((item) => item.severity === "critical");
    return issueSignals.filter((item) => item.queue === queuePreset);
  }, [issueSignals, queuePreset]);

  async function runAction(action: "run_diagnostics" | "acknowledge" | "run_auto_heal" | "run_alerts_dry" | "run_alerts_send" | "run_alerts_force_send" | "add_incident_note" | "run_escalation_check") {
    try {
      setBusy(
        action === "run_diagnostics"
          ? "diagnostics"
          : action === "acknowledge"
            ? "ack"
            : action === "run_auto_heal"
              ? "heal"
              : action === "run_escalation_check"
                ? "escalate"
              : "alerts",
      );
      setStatus("");
      if (action === "run_alerts_dry" || action === "run_alerts_send" || action === "run_alerts_force_send") {
        const res = await fetch("/api/admin/health/alerts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            dryRun: action === "run_alerts_dry",
            force: action === "run_alerts_force_send",
            forceReason: action === "run_alerts_force_send" ? forceSendReason.trim() : null,
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          setStatus(String(json?.error || "Alert action failed"));
          return;
        }
        if (Boolean(json?.dryRun)) {
          const recipientCount = Number(json?.recipientCount || 0);
          const hasIssues = Boolean(json?.hasIssues);
          setAlertPreview({
            hasIssues,
            recipientCount,
            summary: String(json?.issueSummary || ""),
            checkedAt: new Date().toISOString(),
            recipients: Array.isArray(json?.recipients) ? json.recipients : [],
          });
          setStatus(
            hasIssues
              ? `Dry run complete: alert would be sent to ${recipientCount} admin recipient(s).`
              : "Dry run complete: no active issues, alert would not be sent.",
          );
        } else if (Boolean(json?.skipped)) {
          setStatus(String(json?.reason || "Alert not sent."));
        } else if (Number(json?.sent || 0) > 0) {
          setStatus(`Health alert sent to ${Number(json.sent)} admin recipient(s).`);
          if (action === "run_alerts_force_send") setForceSendReason("");
        } else {
          setStatus("Alert action completed.");
        }
        await Promise.all([summaryQuery.refetch(), opsQuery.refetch()]);
        return;
      }
      if (action === "add_incident_note") {
        const res = await fetch("/api/admin/health/ops", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "add_incident_note",
            incidentNote: incidentNote.trim(),
            incidentMode,
            followUpDueAt: incidentFollowUpDueAt.trim() || null,
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          setStatus(String(json?.error || "Incident note action failed"));
          return;
        }
        setIncidentNote("");
        setIncidentFollowUpDueAt("");
        setStatus("Incident timeline note added.");
        await opsQuery.refetch();
        return;
      }
      if (action === "run_escalation_check") {
        const res = await fetch("/api/admin/health/ops", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "run_escalation_check" }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          setStatus(String(json?.error || "Escalation check failed."));
          return;
        }
        if (json?.skipped) {
          setStatus(String(json?.reason || "Escalation not sent."));
        } else {
          setStatus("Escalation check completed and escalation sent.");
        }
        await opsQuery.refetch();
        return;
      }
      const res = await fetch("/api/admin/health/ops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          owner: owner.trim() || null,
          note: note.trim() || null,
          workflowStatus,
          workflowDueAt: workflowDueAt.trim() || null,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus(String(json?.error || "Action failed"));
        return;
      }
      if (action === "run_diagnostics") setStatus("Diagnostics completed and snapshot captured.");
      if (action === "acknowledge") {
        const ack = json?.acknowledgement;
        if (ack) {
          setOwner(String(ack.owner || ""));
          const nextStatus = String(ack.status || "OPEN").toUpperCase();
          setWorkflowStatus(nextStatus === "IN_PROGRESS" || nextStatus === "RESOLVED" ? nextStatus : "OPEN");
          if (ack.dueAt) {
            const d = new Date(String(ack.dueAt));
            setWorkflowDueAt(!Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : "");
          } else {
            setWorkflowDueAt("");
          }
          setNote(Boolean(json?.clearNote) ? "" : String(ack.note || ""));
        }
        setStatus("Issue ownership and acknowledgement saved.");
      }
      if (action === "run_auto_heal") setStatus("Auto-heal executed; review new diagnostics result.");
      await Promise.all([summaryQuery.refetch(), opsQuery.refetch()]);
    } catch {
      setStatus("Action failed.");
    } finally {
      setBusy(null);
    }
  }

  const forceGuardHours = Number(opsQuery.data?.alertGuard?.forceSendMaxDiagnosticsAgeHours || 6);
  const diagnosticsAgeMs = useMemo(() => {
    const raw = opsQuery.data?.freshness?.diagnosticsAt;
    if (!raw) return Number.POSITIVE_INFINITY;
    const ms = new Date(raw).getTime();
    if (!Number.isFinite(ms)) return Number.POSITIVE_INFINITY;
    return Date.now() - ms;
  }, [opsQuery.data?.freshness?.diagnosticsAt]);
  const forceSendStale = forceGuardHours > 0 && diagnosticsAgeMs > forceGuardHours * 60 * 60 * 1000;
  const runbookItems = useMemo(
    () => [
      {
        key: "diagnostics",
        label: "Run diagnostics",
        done: Number.isFinite(diagnosticsAgeMs) && diagnosticsAgeMs !== Number.POSITIVE_INFINITY,
      },
      {
        key: "assign",
        label: "Assign owner and due date",
        done: issueCount === 0 || Boolean(opsQuery.data?.acknowledgement.owner && opsQuery.data?.acknowledgement.dueAt),
      },
      {
        key: "investigate",
        label: "Add investigation note",
        done: Number(opsQuery.data?.incidentTimeline?.length || 0) > 0,
      },
      {
        key: "verify",
        label: "Verify healthy state",
        done: issueCount === 0,
      },
      {
        key: "handoff",
        label: "Export report for handoff",
        done: false,
      },
    ],
    [diagnosticsAgeMs, issueCount, opsQuery.data?.acknowledgement.owner, opsQuery.data?.acknowledgement.dueAt, opsQuery.data?.incidentTimeline?.length],
  );
  const signalRunbook = useMemo(() => {
    const summary = summaryQuery.data;
    if (!summary) return [] as Array<{ id: string; label: string; count: number; countLabel?: string; detail?: string; done: boolean; link?: string }>;
    const posting = summary.missingPostings || {};
    const postingCount =
      Number(summary.ledgerMismatches || 0) +
      Number(posting.orders || 0) +
      Number(posting.payments || 0) +
      Number(posting.expenses || 0) +
      Number(posting.purchases || 0) +
      Number(posting.supplierPayments || 0) +
      Number(posting.creditPayouts || 0) +
      Number(posting.settlements || 0);
    const stockCount = Number(summary.stockMismatches || 0) + Number(summary.negativeStock || 0);
    const paymentOpsCount =
      Number(summary.orderBalanceMismatches || 0) + Number(summary.paymentMismatches || 0) + Number(summary.legacyAutoApply || 0);
    const podCount = summary.podCompliance7d?.alert ? 1 : 0;
    return [
      {
        id: "posting",
        label: "Posting + ledger",
        count: postingCount,
        countLabel: `${postingCount} issue${postingCount === 1 ? "" : "s"} open`,
        detail: "Combined total of failing ledger checks and missing-posting buckets.",
        done: postingCount === 0,
        link: "/admin/health#ledger-integrity",
      },
      {
        id: "stock",
        label: "Stock integrity",
        count: stockCount,
        countLabel: `${stockCount} issue${stockCount === 1 ? "" : "s"} open`,
        detail: "Includes stock-field mismatches and negative-stock findings.",
        done: stockCount === 0,
        link: "/admin/health#stock-movement-mismatches",
      },
      {
        id: "payments",
        label: "Payments + balances",
        count: paymentOpsCount,
        countLabel: `${paymentOpsCount} issue${paymentOpsCount === 1 ? "" : "s"} open`,
        detail: "Includes payment mismatches, order-balance mismatches, and legacy auto-apply records.",
        done: paymentOpsCount === 0,
        link: "/admin/health#data-quality",
      },
      {
        id: "pod",
        label: "POD compliance",
        count: podCount,
        countLabel: `${podCount} alert${podCount === 1 ? "" : "s"} open`,
        detail: "Shows whether the 7-day POD missing-rate alert is active.",
        done: podCount === 0,
        link: "/admin/health#pod-compliance",
      },
    ];
  }, [summaryQuery.data]);

  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base font-semibold">Health Operations</CardTitle>
          <Badge variant={severity.tone}>{severity.label}</Badge>
          <span className="text-xs text-muted-foreground">{issueCount} active issue signal(s)</span>
          {opsQuery.data?.acknowledgement.overdue ? (
            <Badge variant="destructive">Overdue</Badge>
          ) : null}
          {opsQuery.data?.acknowledgement.needsAssignment ? (
            <Badge variant="secondary">Needs assignment</Badge>
          ) : null}
          {dueTimingLabel ? (
            <Badge variant={dueTimingLabel.overdue ? "destructive" : "secondary"}>{dueTimingLabel.label}</Badge>
          ) : null}
        </div>
        <div className="text-xs">
          <SlaText summary={summaryQuery.data} />
        </div>
      </CardHeader>
      <CardContent className="space-y-5 text-sm">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">MTTA ({Number(opsQuery.data?.kpis?.windowDays || 30)}d)</p>
            <p className="font-medium">{opsQuery.data?.kpis?.mttaHours ?? "-"} h</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">MTTR ({Number(opsQuery.data?.kpis?.windowDays || 30)}d)</p>
            <p className="font-medium">{opsQuery.data?.kpis?.mttrHours ?? "-"} h</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">Reopen rate ({Number(opsQuery.data?.kpis?.windowDays || 30)}d)</p>
            <p className="font-medium">{Number(opsQuery.data?.kpis?.reopenRatePct || 0)}%</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">Overdue rate ({Number(opsQuery.data?.kpis?.windowDays || 30)}d)</p>
            <p className="font-medium">{Number(opsQuery.data?.kpis?.overdueRatePct || 0)}%</p>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-md border p-3">
            <MetricSparkline
              label="MTTA trend (weekly)"
              points={(opsQuery.data?.kpiTrend || []).map((p) => ({ label: p.week, value: Number(p.mttaHours || 0) }))}
            />
          </div>
          <div className="rounded-md border p-3">
            <MetricSparkline
              label="MTTR trend (weekly)"
              points={(opsQuery.data?.kpiTrend || []).map((p) => ({ label: p.week, value: Number(p.mttrHours || 0) }))}
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">Last diagnostics run</p>
            <p className="font-medium">{fmtTime(opsQuery.data?.freshness.diagnosticsAt)}</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">Last alert sent</p>
            <p className="font-medium">{fmtTime(opsQuery.data?.freshness.alertSentAt)}</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">Last POD alert</p>
            <p className="font-medium">{fmtTime(opsQuery.data?.freshness.podAlertSentAt)}</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">Last auto-heal run</p>
            <p className="font-medium">{fmtTime(opsQuery.data?.freshness.autoHealAt)}</p>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-md border p-3 space-y-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Trend (last 7 diagnostics)</p>
            <Sparkline trend={opsQuery.data?.trend || []} />
          </div>

          <div className="rounded-md border p-3 space-y-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Acknowledge + owner</p>
            <div className="grid gap-2">
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">Owner</span>
                <Input placeholder="Owner" value={owner} onChange={(e) => setOwner(e.target.value)} />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">Acknowledgement note</span>
                <Input placeholder="Acknowledgement note" value={note} onChange={(e) => setNote(e.target.value)} />
              </label>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="space-y-1">
                  <span className="text-xs text-muted-foreground">Status</span>
                  <select
                    className="h-9 w-full rounded border bg-background px-2 text-sm"
                    value={workflowStatus}
                    onChange={(e) =>
                      setWorkflowStatus((e.target.value || "OPEN").toUpperCase() as "OPEN" | "IN_PROGRESS" | "RESOLVED")
                    }
                  >
                    <option value="OPEN">Open</option>
                    <option value="IN_PROGRESS">In progress</option>
                    <option value="RESOLVED">Resolved</option>
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-xs text-muted-foreground">Due date (deadline)</span>
                  <Input
                    type="date"
                    value={workflowDueAt}
                    onChange={(e) => setWorkflowDueAt(e.target.value)}
                  />
                </label>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Current: {opsQuery.data?.acknowledgement.owner || "-"} | {fmtTime(opsQuery.data?.acknowledgement.acknowledgedAt)}
              {opsQuery.data?.acknowledgement.stillCurrent ? " | active for current issue state" : ""}
              {opsQuery.data?.acknowledgement.status ? ` | Status: ${String(opsQuery.data?.acknowledgement.status).replace("_", " ")}` : ""}
              {opsQuery.data?.acknowledgement.dueAt ? ` | Due: ${new Date(String(opsQuery.data?.acknowledgement.dueAt)).toLocaleDateString()}` : ""}
            </p>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                if (acknowledgementError) {
                  setAckAttempted(true);
                  return;
                }
                setConfirmAction("acknowledge");
              }}
              disabled={busy !== null}
            >
              {busy === "ack" ? "Saving..." : "Save acknowledgement"}
            </Button>
            {showAcknowledgementError ? (
              <p className="text-xs text-red-600">{acknowledgementError}</p>
            ) : null}
          </div>
        </div>

        <div className="rounded-md border p-3 space-y-3">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Triage queue</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant={queuePreset === "all" ? "default" : "outline"} onClick={() => setQueuePreset("all")}>All</Button>
            <Button type="button" size="sm" variant={queuePreset === "critical" ? "default" : "outline"} onClick={() => setQueuePreset("critical")}>Critical</Button>
            <Button type="button" size="sm" variant={queuePreset === "posting" ? "default" : "outline"} onClick={() => setQueuePreset("posting")}>Posting gaps</Button>
            <Button type="button" size="sm" variant={queuePreset === "operational" ? "default" : "outline"} onClick={() => setQueuePreset("operational")}>Operational</Button>
            <Button type="button" size="sm" variant={queuePreset === "pod" ? "default" : "outline"} onClick={() => setQueuePreset("pod")}>POD alerts</Button>
          </div>
          {visibleSignals.length === 0 ? (
            <p className="text-xs text-muted-foreground">No issue signal in this queue.</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {visibleSignals.map((item) => (
                <div key={item.id} className="rounded border p-2 text-xs space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{item.label}</span>
                    <Badge variant={item.severity === "critical" ? "destructive" : "secondary"}>
                      {item.countLabel ?? item.count}
                    </Badge>
                  </div>
                  <p className="text-muted-foreground">{item.hint}</p>
                  <div className="flex flex-wrap gap-2">
                    {item.link ? (
                      <Link href={item.link} className="underline">Open queue</Link>
                    ) : null}
                    {opsQuery.data?.activeIncidentLink ? (
                      <Link href={opsQuery.data.activeIncidentLink} className="underline">Open active incident</Link>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-md border p-3 space-y-3">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Runbook by signal</p>
          {signalRunbook.length === 0 ? (
            <p className="text-xs text-muted-foreground">Signal runbook will appear after diagnostics data loads.</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {signalRunbook.map((item) => (
                <div key={item.id} className="rounded border p-2 text-xs space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{item.label}</span>
                    <Badge variant={item.done ? "default" : "secondary"}>{item.done ? "Done" : (item.countLabel ?? `${item.count} open`)}</Badge>
                  </div>
                  {item.detail ? <p className="text-muted-foreground">{item.detail}</p> : null}
                  <div className="flex flex-wrap gap-2">
                    {item.link ? <Link href={item.link} className="underline">Open signal view</Link> : null}
                    {!item.done && opsQuery.data?.activeIncidentLink ? (
                      <Link href={opsQuery.data.activeIncidentLink} className="underline">Open active incident</Link>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-md border p-3 space-y-3">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Diagnostics + auto-heal</p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setConfirmAction("run_diagnostics")}
              disabled={busy !== null}
            >
              {busy === "diagnostics" ? "Running..." : "Run diagnostics (dry run)"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setConfirmAction("run_alerts_dry")}
              disabled={busy !== null}
            >
              {busy === "alerts" ? "Running..." : "Run alert check (dry run)"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setConfirmAction("run_alerts_send")}
              disabled={busy !== null}
            >
              {busy === "alerts" ? "Sending..." : "Send health alert now"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setConfirmAction("run_alerts_force_send")}
              disabled={busy !== null || forceSendStale}
            >
              {busy === "alerts" ? "Sending..." : "Force send alert now"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void runAction("run_escalation_check")}
              disabled={busy !== null}
            >
              {busy === "escalate" ? "Checking..." : "Run escalation check"}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => setConfirmAction("run_auto_heal")}
              disabled={busy !== null || !opsQuery.data?.autoHeal.enabled}
            >
              {busy === "heal" ? "Running heal..." : "Run auto-heal now"}
            </Button>
            <a
              href={opsQuery.data?.exportLinks.csv || "/api/admin/health/ops?format=csv"}
              className="inline-flex items-center rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted"
            >
              Export health report (CSV)
            </a>
            <a
              href={opsQuery.data?.exportLinks.pdf || "/api/admin/health/ops?format=pdf"}
              className="inline-flex items-center rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted"
            >
              Download summary (PDF)
            </a>
            <a
              href={opsQuery.data?.exportLinks.handoff || "/api/admin/health/ops?format=handoff"}
              className="inline-flex items-center rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted"
            >
              Export handoff bundle
            </a>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 text-xs">
            <label className="space-y-1">
              <span className="text-muted-foreground">Handoff scope</span>
              <select
                className="h-8 w-full rounded border bg-background px-2 text-xs"
                value={handoffScope}
                onChange={(e) => setHandoffScope((e.target.value || "full") as "full" | "incident")}
              >
                <option value="full">Full snapshot</option>
                <option value="incident">Incident only</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-muted-foreground">Timeline notes</span>
              <select
                className="h-8 w-full rounded border bg-background px-2 text-xs"
                value={handoffTimeline}
                onChange={(e) => setHandoffTimeline((e.target.value || "10") as "5" | "10" | "20")}
              >
                <option value="5">Latest 5</option>
                <option value="10">Latest 10</option>
                <option value="20">Latest 20</option>
              </select>
            </label>
          </div>
          <a
            href={`${opsQuery.data?.exportLinks.handoff || "/api/admin/health/ops?format=handoff"}&scope=${handoffScope}&timeline=${handoffTimeline}`}
            className="inline-flex items-center rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted w-fit"
          >
            Download configured handoff bundle
          </a>
          <p className="text-xs text-muted-foreground">
            Auto-heal: {opsQuery.data?.autoHeal.enabled ? "enabled" : "disabled"}
            {opsQuery.data?.autoHeal.lastRunByName ? ` | last by ${opsQuery.data.autoHeal.lastRunByName}` : ""}
          </p>
          <p className="text-xs text-muted-foreground">
            Last sent alert: {fmtTime(opsQuery.data?.lastSentAlert?.at)} | recipients {Number(opsQuery.data?.lastSentAlert?.recipientCount || 0)}
            {opsQuery.data?.lastSentAlert?.byName ? ` | by ${opsQuery.data.lastSentAlert.byName}` : ""}
          </p>
          {opsQuery.data?.lastSentAlert?.at ? (
            <div className="rounded border p-2 text-xs space-y-1 text-muted-foreground">
              {opsQuery.data.lastSentAlert.triggerSource ? (
                <p>
                  <span className="font-medium">Source:</span> {opsQuery.data.lastSentAlert.triggerSource}
                </p>
              ) : null}
              {opsQuery.data.lastSentAlert.issueSummary ? (
                <p>
                  <span className="font-medium">Issue summary:</span> {opsQuery.data.lastSentAlert.issueSummary}
                </p>
              ) : null}
              {opsQuery.data.lastSentAlert.resultSummary ? (
                <p>
                  <span className="font-medium">Result:</span> {opsQuery.data.lastSentAlert.resultSummary}
                </p>
              ) : null}
              {opsQuery.data.lastSentAlert.recipients?.length ? (
                <div className="space-y-1">
                  <p className="font-medium">Sent to</p>
                  {opsQuery.data.lastSentAlert.recipients.map((recipient) => (
                    <p key={recipient}>{recipient}</p>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {opsQuery.data?.lastAlertActivity?.at ? (
            <div className="rounded border p-2 text-xs space-y-1 text-muted-foreground">
              <p className="font-medium">
                Last alert activity: {opsQuery.data.lastAlertActivity.action.replace(/_/g, " ")} at {fmtTime(opsQuery.data.lastAlertActivity.at)}
              </p>
              <p>By: {opsQuery.data.lastAlertActivity.byName}</p>
              {opsQuery.data.lastAlertActivity.reason ? <p>Reason: {opsQuery.data.lastAlertActivity.reason}</p> : null}
              {opsQuery.data.lastAlertActivity.result ? <p>Result: {opsQuery.data.lastAlertActivity.result}</p> : null}
            </div>
          ) : null}
          {forceSendStale ? (
            <p className="text-xs text-amber-700">
              Force send is locked until diagnostics are refreshed (max age {forceGuardHours}h).
            </p>
          ) : null}
          {opsQuery.data?.autoHeal.lastResult ? (
            <p className="text-xs text-muted-foreground">
              Last heal postings: orders {opsQuery.data.autoHeal.lastResult.posted.orders}, payments {opsQuery.data.autoHeal.lastResult.posted.payments},
              expenses {opsQuery.data.autoHeal.lastResult.posted.expenses}, purchases {opsQuery.data.autoHeal.lastResult.posted.purchases},
              supplier payments {opsQuery.data.autoHeal.lastResult.posted.supplierPayments}, credit payouts {opsQuery.data.autoHeal.lastResult.posted.creditPayouts},
              settlements {opsQuery.data.autoHeal.lastResult.posted.settlements}
            </p>
          ) : null}
        </div>

        <div className="rounded-md border p-3 space-y-3">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Incident timeline</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              placeholder={detectorModeBlocked ? "Switch to Operational follow-up to add note" : "Add incident note"}
              value={incidentNote}
              onChange={(e) => setIncidentNote(e.target.value)}
              disabled={detectorModeBlocked}
            />
            <select
              className="h-9 rounded border bg-background px-2 text-sm"
              value={incidentMode}
              onChange={(e) =>
                setIncidentMode((e.target.value || "DETECTOR_BACKED") as "DETECTOR_BACKED" | "OPERATIONAL_FOLLOW_UP")
              }
            >
              <option value="DETECTOR_BACKED">Detector-backed</option>
              <option value="OPERATIONAL_FOLLOW_UP">Operational follow-up</option>
            </select>
            <Input
              type="date"
              value={incidentFollowUpDueAt}
              onChange={(e) => setIncidentFollowUpDueAt(e.target.value)}
              placeholder="Follow-up due date (optional)"
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy !== null || detectorModeBlocked || incidentNote.trim().length < 8 || Boolean(incidentModeError)}
              onClick={() => void runAction("add_incident_note")}
            >
              Add note
            </Button>
          </div>
          {incidentNoteError ? <p className="text-xs text-red-600">{incidentNoteError}</p> : null}
          {incidentModeError ? <p className="text-xs text-amber-700">{incidentModeError}</p> : null}
          {opsQuery.data?.incident ? (
            <p className="text-xs text-muted-foreground">
              Active/recent incident: {opsQuery.data.incident.isManual ? "Manual" : "Detector-backed"} | {opsQuery.data.incident.status.replace(/_/g, " ")}
              {opsQuery.data.incident.followUpDueAt ? ` | Follow-up due ${new Date(opsQuery.data.incident.followUpDueAt).toLocaleDateString()}` : ""}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">Showing latest 5 notes for the current/recent incident.</p>
          <div className="space-y-2 text-xs">
            {(opsQuery.data?.incidentTimeline || []).length === 0 ? (
              <p className="text-muted-foreground">No incident notes yet.</p>
            ) : (
              [...(opsQuery.data?.incidentTimeline || [])]
                .slice()
                .reverse()
                .map((item, index) => (
                  <div key={`${item.at}-${index}`} className="rounded border p-2">
                    <p className="font-medium">{item.byName} | {fmtTime(item.at)}</p>
                    <p className="text-muted-foreground">{item.note}</p>
                  </div>
                ))
            )}
          </div>
        </div>

        <div className="rounded-md border p-3 space-y-2">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Runbook checklist</p>
          {issueCount <= 0 ? (
            <div className="rounded border border-dashed p-2 text-xs text-muted-foreground">
              No active incident. Runbook checklist will activate when issue signals are detected.
            </div>
          ) : (
            runbookItems.map((item) => (
              <p key={item.key} className={`text-xs ${item.done ? "text-emerald-700" : "text-muted-foreground"}`}>
                {item.done ? "Done" : "Pending"}: {item.label}
              </p>
            ))
          )}
        </div>

        <div className="rounded-md border p-3 space-y-2">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Quick links</p>
          <div className="flex flex-wrap gap-2 text-xs">
            <Link href="/admin/accounting/integrity" className="inline-flex items-center rounded-md border px-2 py-1 hover:bg-muted">Accounting integrity</Link>
            <Link href="/admin/health/incidents" className="inline-flex items-center rounded-md border px-2 py-1 hover:bg-muted">Health incidents</Link>
            <Link href="/admin/delivery/collection-review" className="inline-flex items-center rounded-md border px-2 py-1 hover:bg-muted">Collection review</Link>
            <Link href="/admin/delivery/dispatch?attentionOnly=1" className="inline-flex items-center rounded-md border px-2 py-1 hover:bg-muted">Dispatch attention list</Link>
            <Link href="/admin/delivery/pod-report" className="inline-flex items-center rounded-md border px-2 py-1 hover:bg-muted">POD report</Link>
          </div>
        </div>

        {status ? <p className="text-xs text-muted-foreground">{status}</p> : null}
      </CardContent>
      <Dialog open={!!confirmAction} onOpenChange={(open) => !open && setConfirmAction(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {confirmAction === "run_diagnostics"
                ? "Run diagnostics now?"
                : confirmAction === "acknowledge"
                  ? "Save acknowledgement?"
                  : confirmAction === "run_alerts_dry"
                    ? "Run alert check (dry run)?"
                    : confirmAction === "run_alerts_send"
                      ? "Send health alert now?"
                      : confirmAction === "run_alerts_force_send"
                        ? "Force send health alert now?"
                  : "Run auto-heal now?"}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {confirmAction === "run_diagnostics"
              ? "This captures a new diagnostics snapshot and updates trend counters."
              : confirmAction === "acknowledge"
                ? "This assigns ownership and acknowledgement for the current issue fingerprint."
                : confirmAction === "run_alerts_dry"
                  ? "This runs a live preview. After Confirm, check 'Last alert dry run' and 'Alert recipient preview' below for counts and recipient list."
                  : confirmAction === "run_alerts_send"
                    ? "This sends the health issue alert email now (subject to daily duplicate guard)."
                    : confirmAction === "run_alerts_force_send"
                      ? "This bypasses the daily duplicate guard and sends alert email immediately. Reason is required and logged."
                : "This posts missing accounting entries where safe, then reruns diagnostics."}
          </p>
          {confirmAction === "run_alerts_dry" && alertPreview ? (
            <div className="rounded border p-2 text-xs text-muted-foreground space-y-1">
              <p>
                Latest preview: {alertPreview.hasIssues ? "sendable" : "not sendable"} | recipients {alertPreview.recipientCount}
              </p>
              <p>Checked: {fmtTime(alertPreview.checkedAt)}</p>
            </div>
          ) : null}
          {(confirmAction === "run_alerts_dry" || confirmAction === "run_alerts_send" || confirmAction === "run_alerts_force_send") &&
          (opsQuery.data?.alertRecipients || []).length > 0 ? (
            <div className="rounded border p-2 text-xs text-muted-foreground space-y-1">
              <p className="font-medium">Recipients for alert emails</p>
              {(opsQuery.data?.alertRecipients || []).map((recipient) => (
                <p key={recipient.email || recipient.name}>
                  {recipient.name || "Admin"}{recipient.email ? ` (${recipient.email})` : ""}
                </p>
              ))}
            </div>
          ) : null}
          {confirmAction === "run_alerts_force_send" ? (
            <div className="space-y-2">
              <Input
                value={forceSendReason}
                onChange={(e) => setForceSendReason(e.target.value)}
                placeholder="Reason for force send (required)"
              />
              {forceSendReasonError ? <p className="text-xs text-red-600">{forceSendReasonError}</p> : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmAction(null)} disabled={busy !== null}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={
                busy !== null ||
                (confirmAction === "acknowledge" && Boolean(acknowledgementError)) ||
                (confirmAction === "run_alerts_force_send" && (Boolean(forceSendReasonError) || forceSendStale))
              }
              onClick={async () => {
                if (!confirmAction) return;
                await runAction(confirmAction);
                setConfirmAction(null);
              }}
            >
              {confirmAction === "run_alerts_send" || confirmAction === "run_alerts_force_send" ? "Confirm & Send" : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
