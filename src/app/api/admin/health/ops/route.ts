import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { Prisma, IssueStatus } from "@prisma/client";
import { PDFDocument, StandardFonts, rgb, type PDFPage } from "pdf-lib";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";
import { autoHealMissingPostings } from "@/lib/accounting-auto-heal";
import { sendEmail } from "@/lib/email";

type Summary = {
  stockMismatches: number;
  negativeStock: number;
  orderBalanceMismatches: number;
  paymentMismatches: number;
  legacyAutoApply: number;
  ledgerMismatches: number;
  missingPostings?: Record<string, number>;
  podCompliance7d?: {
    alert: boolean;
  };
};

type Snapshot = {
  at: string;
  issueCount: number;
};

type OpsState = {
  owner?: string | null;
  note?: string | null;
  acknowledgedAt?: string | null;
  acknowledgedById?: string | null;
  acknowledgedByName?: string | null;
  issueFingerprint?: string | null;
  lastDiagnosticsAt?: string | null;
  lastDiagnosticsById?: string | null;
  lastDiagnosticsByName?: string | null;
  lastAutoHealAt?: string | null;
  lastAutoHealById?: string | null;
  lastAutoHealByName?: string | null;
  lastAutoHealResult?: {
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
  workflowStatus?: "OPEN" | "IN_PROGRESS" | "RESOLVED";
  workflowDueAt?: string | null;
  workflowStatusUpdatedAt?: string | null;
  workflowStatusUpdatedByName?: string | null;
  incidentTimeline?: Array<{
    at: string;
    byName: string;
    note: string;
  }>;
};

const OPS_STATE_KEY = "health.ops.state.v1";
const OPS_SNAPSHOTS_KEY = "health.ops.snapshots.v1";
const OPS_ESCALATION_STATE_KEY = "health.ops.escalation.sent.v1";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

function issueCount(summary: Summary) {
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

function fingerprint(summary: Summary) {
  const posting = Object.values(summary.missingPostings || {}).reduce((sum, n) => sum + Number(n || 0), 0);
  return [
    summary.stockMismatches,
    summary.orderBalanceMismatches,
    summary.paymentMismatches,
    summary.legacyAutoApply,
    summary.ledgerMismatches,
    posting,
    summary.podCompliance7d?.alert ? 1 : 0,
  ].join(":");
}

function buildIssueBreakdown(summary: Summary) {
  const posting = summary.missingPostings || {};
  return {
    stockMismatches: Number(summary.stockMismatches || 0),
    orderBalanceMismatches: Number(summary.orderBalanceMismatches || 0),
    paymentMismatches: Number(summary.paymentMismatches || 0),
    legacyAutoApply: Number(summary.legacyAutoApply || 0),
    ledgerMismatches: Number(summary.ledgerMismatches || 0),
    negativeStock: Number(summary.negativeStock || 0),
    podAlertActive: Boolean(summary.podCompliance7d?.alert),
    missingPostings: {
      orders: Number(posting.orders || 0),
      payments: Number(posting.payments || 0),
      expenses: Number(posting.expenses || 0),
      purchases: Number(posting.purchases || 0),
      supplierPayments: Number(posting.supplierPayments || 0),
      creditPayouts: Number(posting.creditPayouts || 0),
      settlements: Number(posting.settlements || 0),
    },
  };
}

function summarizeIssueSignals(summary: Summary) {
  const posting = summary.missingPostings || {};
  const parts: string[] = [];
  if (Number(summary.stockMismatches || 0) > 0) parts.push(`${summary.stockMismatches} stock mismatch(es)`);
  if (Number(summary.orderBalanceMismatches || 0) > 0) {
    parts.push(`${summary.orderBalanceMismatches} order balance mismatch(es)`);
  }
  if (Number(summary.paymentMismatches || 0) > 0) parts.push(`${summary.paymentMismatches} payment mismatch(es)`);
  if (Number(summary.legacyAutoApply || 0) > 0) parts.push(`${summary.legacyAutoApply} legacy auto-apply record(s)`);
  if (Number(summary.ledgerMismatches || 0) > 0) parts.push(`${summary.ledgerMismatches} ledger mismatch(es)`);
  if (Number(summary.negativeStock || 0) > 0) parts.push(`${summary.negativeStock} negative stock item(s)`);
  if (Number(posting.orders || 0) > 0) parts.push(`${posting.orders} missing order posting(s)`);
  if (Number(posting.payments || 0) > 0) parts.push(`${posting.payments} missing payment posting(s)`);
  if (Number(posting.expenses || 0) > 0) parts.push(`${posting.expenses} missing expense posting(s)`);
  if (Number(posting.purchases || 0) > 0) parts.push(`${posting.purchases} missing purchase posting(s)`);
  if (Number(posting.supplierPayments || 0) > 0) {
    parts.push(`${posting.supplierPayments} missing supplier payment posting(s)`);
  }
  if (Number(posting.creditPayouts || 0) > 0) parts.push(`${posting.creditPayouts} missing credit payout posting(s)`);
  if (Number(posting.settlements || 0) > 0) parts.push(`${posting.settlements} missing settlement posting(s)`);
  if (summary.podCompliance7d?.alert) parts.push("POD compliance alert is active");
  if (parts.length === 0) return "No issue signals detected.";
  return parts.join("; ");
}

function mapWorkflowStatusToIncidentStatus(status?: "OPEN" | "IN_PROGRESS" | "RESOLVED" | null): IssueStatus {
  if (status === "IN_PROGRESS") return "IN_PROGRESS";
  if (status === "RESOLVED") return "RESOLVED";
  return "OPEN";
}

async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await prisma.appSetting.findUnique({ where: { key }, select: { value: true } });
  if (!row?.value) return fallback;
  return row.value as T;
}

async function setSetting(key: string, value: unknown) {
  await prisma.appSetting.upsert({
    where: { key },
    update: { value: value as Prisma.InputJsonValue },
    create: { key, value: value as Prisma.InputJsonValue },
  });
}

async function fetchSummary(req: Request): Promise<Summary> {
  const origin = new URL(req.url).origin;
  const cookie = req.headers.get("cookie") || "";
  const res = await fetch(`${origin}/api/admin/health/summary`, {
    headers: cookie ? { cookie } : undefined,
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error("Summary fetch failed");
  }
  return (await res.json()) as Summary;
}

function trimSnapshots(items: Snapshot[]) {
  return items.slice(-30);
}

function toTrend(items: Snapshot[]) {
  const last7 = items.slice(-7);
  const trend = last7.map((s) => ({
    date: new Date(s.at).toISOString().slice(5, 10),
    issueCount: Number(s.issueCount || 0),
  }));
  while (trend.length < 7) {
    trend.unshift({ date: "--", issueCount: 0 });
  }
  return trend;
}

function csvValue(value: unknown) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, "\"\"")}"`;
  }
  return s;
}

function toMetaRecord(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" ? (value as Record<string, unknown>) : {};
}

async function maybeSendEscalationEmail(args: {
  user: AuthenticatedUser | undefined;
  summary: Summary;
  state: OpsState;
  activeIncidentId: string | null;
}) {
  const { user, summary, state, activeIncidentId } = args;
  const activeSignals = issueCount(summary);
  const dueAt = state.workflowDueAt ? new Date(state.workflowDueAt) : null;
  if (!activeIncidentId || activeSignals <= 0 || !dueAt || Number.isNaN(dueAt.getTime())) {
    return { sent: false, reason: "No active overdue incident." };
  }
  if (String(state.workflowStatus || "OPEN").toUpperCase() === "RESOLVED") {
    return { sent: false, reason: "Workflow already resolved." };
  }
  const overdueMs = Date.now() - dueAt.getTime();
  if (overdueMs <= 0) return { sent: false, reason: "Incident is not overdue." };

  const thresholdL1 = Math.max(1, Number(process.env.HEALTH_INCIDENT_ESCALATE_HOURS_L1 || 4));
  const thresholdL2 = Math.max(thresholdL1, Number(process.env.HEALTH_INCIDENT_ESCALATE_HOURS_L2 || 24));
  const overdueHours = overdueMs / (1000 * 60 * 60);
  const level = overdueHours >= thresholdL2 ? 2 : overdueHours >= thresholdL1 ? 1 : 0;
  if (level <= 0) {
    return { sent: false, reason: `Overdue less than escalation threshold (${thresholdL1}h).` };
  }

  const escalationState = await getSetting<Record<string, { level: number; sentAt: string }>>(OPS_ESCALATION_STATE_KEY, {});
  const existing = escalationState[activeIncidentId];
  if (existing && existing.level >= level) {
    return { sent: false, reason: `Escalation level ${existing.level} already sent for this incident.` };
  }

  const adminRecipients = await prisma.user.findMany({
    where: { role: "ADMIN", archived: false, email: { not: null } },
    select: { email: true, name: true },
  });
  const toList = adminRecipients
    .map((row) => ({ email: String(row.email || "").trim(), name: row.name || "Admin" }))
    .filter((row) => row.email);
  if (!toList.length) {
    return { sent: false, reason: "No admin email recipients configured." };
  }

  const subject = `Health incident escalation (L${level}) - ${activeIncidentId}`;
  const body = [
    `Health incident escalation triggered.`,
    `Incident ID: ${activeIncidentId}`,
    `Escalation level: L${level}`,
    `Overdue hours: ${overdueHours.toFixed(1)}`,
    `Owner: ${state.owner || "Unassigned"}`,
    `Status: ${String(state.workflowStatus || "OPEN").replace(/_/g, " ")}`,
    `Due at: ${state.workflowDueAt || "-"}`,
    `Issue summary: ${summarizeIssueSignals(summary)}`,
    `Open incident: /admin/health/incidents/${activeIncidentId}`,
    `Triggered by: ${user?.name || user?.email || "System"}`,
  ].join("\n");

  await Promise.all(toList.map((row) => sendEmail(row.email, subject, body)));
  escalationState[activeIncidentId] = { level, sentAt: new Date().toISOString() };
  await setSetting(OPS_ESCALATION_STATE_KEY, escalationState);
  return {
    sent: true,
    level,
    overdueHours,
    recipientCount: toList.length,
    recipients: toList.map((row) => `${row.name} (${row.email})`),
  };
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !isAuthorized(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const format = (searchParams.get("format") || "").trim().toLowerCase();
  const handoffScope = (searchParams.get("scope") || "full").trim().toLowerCase();
  const handoffTimelineLimitRaw = Number(searchParams.get("timeline") || 10);
  const handoffTimelineLimit = Number.isFinite(handoffTimelineLimitRaw)
    ? Math.max(1, Math.min(50, Math.floor(handoffTimelineLimitRaw)))
    : 10;

  const [state, snapshots, summary, lastAlert, lastAlertActivity, lastPodAlert, adminRecipients] = await Promise.all([
    getSetting<OpsState>(OPS_STATE_KEY, {}),
    getSetting<Snapshot[]>(OPS_SNAPSHOTS_KEY, []),
    fetchSummary(req),
    prisma.auditLog.findFirst({
      where: { action: "HEALTH_ALERT_SENT", entityType: "HEALTH_ALERT" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, meta: true },
    }),
    prisma.auditLog.findFirst({
      where: {
        entityType: "HEALTH_ALERT",
        action: { in: ["HEALTH_ALERT_SENT", "HEALTH_ALERT_SEND_SKIPPED", "HEALTH_ALERT_FORCE_SEND_SKIPPED"] },
      },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, action: true, meta: true },
    }),
    prisma.auditLog.findFirst({
      where: { action: "HEALTH_POD_ALERT_SENT", entityType: "HEALTH_ALERT" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    prisma.user.findMany({
      where: { role: "ADMIN", archived: false, email: { not: null } },
      select: { name: true, email: true },
      orderBy: { name: "asc" },
    }),
  ]);
  const lastAlertMeta = toMetaRecord(lastAlert?.meta);
  const lastAlertActivityMeta = toMetaRecord(lastAlertActivity?.meta);

  const currentFingerprint = fingerprint(summary);
  const activeIssueSignals = issueCount(summary);
  const stillCurrent = Boolean(state.issueFingerprint && state.issueFingerprint === currentFingerprint);
  const workflowDueAt = state.workflowDueAt ? new Date(state.workflowDueAt) : null;
  const dueAtValid = Boolean(workflowDueAt && !Number.isNaN(workflowDueAt.getTime()));
  const workflowOverdue = Boolean(
    activeIssueSignals > 0 &&
    dueAtValid &&
      state.workflowStatus !== "RESOLVED" &&
      (workflowDueAt as Date).getTime() < Date.now(),
  );
  const workflowNeedsAssignment = activeIssueSignals > 0 && !String(state.owner || "").trim();
  const activeIncident = await prisma.healthIncident.findFirst({
    where: { status: { in: ["OPEN", "IN_PROGRESS"] } },
    orderBy: { createdAt: "desc" },
    include: { notes: { orderBy: { createdAt: "desc" }, take: 20 } },
  });
  const latestIncident =
    activeIncident ||
    (await prisma.healthIncident.findFirst({
      orderBy: { createdAt: "desc" },
      include: { notes: { orderBy: { createdAt: "desc" }, take: 20 } },
    }));
  const incidentTimeline = (latestIncident?.notes || [])
    .slice()
    .reverse()
    .map((note) => ({
      at: note.createdAt.toISOString(),
      byName: note.createdByName,
      note: note.note,
    }));
  const activeIncidentLink = activeIncident ? `/admin/health/incidents/${activeIncident.id}` : null;
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [incidents30d, reopened30dCount] = await Promise.all([
    prisma.healthIncident.findMany({
      where: { openedAt: { gte: since } },
      include: { notes: { orderBy: { createdAt: "asc" }, take: 1 } },
      orderBy: { openedAt: "desc" },
      take: 200,
    }),
    prisma.auditLog.count({
      where: {
        action: "HEALTH_INCIDENT_REOPENED",
        entityType: "HEALTH_ALERT",
        createdAt: { gte: since },
      },
    }),
  ]);
  const mttrPool = incidents30d
    .filter((row) => Boolean(row.resolvedAt))
    .map((row) => (new Date(row.resolvedAt as Date).getTime() - row.openedAt.getTime()) / (1000 * 60 * 60))
    .filter((v) => Number.isFinite(v) && v >= 0);
  const mttaPool = incidents30d
    .map((row) => {
      const firstNoteAt = row.notes[0]?.createdAt?.getTime();
      const firstStatusAt = row.statusUpdatedAt?.getTime();
      const firstActionAt = [firstNoteAt, firstStatusAt].filter((n): n is number => Number.isFinite(n)).sort((a, b) => a - b)[0];
      if (!firstActionAt) return null;
      return (firstActionAt - row.openedAt.getTime()) / (1000 * 60 * 60);
    })
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0);
  const overdueRelevant = incidents30d.filter((row) => Boolean(row.followUpDueAt));
  const overdueCount = overdueRelevant.filter((row) => {
    const dueAt = row.followUpDueAt as Date;
    const resolvedOrNow = row.resolvedAt || row.closedAt || new Date();
    return dueAt.getTime() < resolvedOrNow.getTime();
  }).length;
  const resolvedOrClosedCount = incidents30d.filter((row) => row.status === "RESOLVED" || row.status === "CLOSED").length;
  const kpis = {
    windowDays: 30,
    incidentCount: incidents30d.length,
    mttaHours: mttaPool.length ? Number((mttaPool.reduce((a, b) => a + b, 0) / mttaPool.length).toFixed(1)) : null,
    mttrHours: mttrPool.length ? Number((mttrPool.reduce((a, b) => a + b, 0) / mttrPool.length).toFixed(1)) : null,
    reopenRatePct: resolvedOrClosedCount > 0 ? Number(((reopened30dCount / resolvedOrClosedCount) * 100).toFixed(1)) : 0,
    overdueRatePct: overdueRelevant.length > 0 ? Number(((overdueCount / overdueRelevant.length) * 100).toFixed(1)) : 0,
  };
  const weekStart = (d: Date) => {
    const copy = new Date(d);
    const day = copy.getDay() || 7;
    copy.setDate(copy.getDate() - day + 1);
    copy.setHours(0, 0, 0, 0);
    return copy;
  };
  const kpiTrendMap = new Map<string, { label: string; mtta: number[]; mttr: number[] }>();
  incidents30d.forEach((row) => {
    const wk = weekStart(row.openedAt);
    const key = wk.toISOString().slice(0, 10);
    const bucket = kpiTrendMap.get(key) || { label: key.slice(5), mtta: [], mttr: [] };
    const firstNoteAt = row.notes[0]?.createdAt?.getTime();
    const firstStatusAt = row.statusUpdatedAt?.getTime();
    const firstActionAt = [firstNoteAt, firstStatusAt]
      .filter((n): n is number => Number.isFinite(n))
      .sort((a, b) => a - b)[0];
    if (firstActionAt) {
      const mtta = (firstActionAt - row.openedAt.getTime()) / (1000 * 60 * 60);
      if (Number.isFinite(mtta) && mtta >= 0) bucket.mtta.push(mtta);
    }
    if (row.resolvedAt) {
      const mttr = (new Date(row.resolvedAt).getTime() - row.openedAt.getTime()) / (1000 * 60 * 60);
      if (Number.isFinite(mttr) && mttr >= 0) bucket.mttr.push(mttr);
    }
    kpiTrendMap.set(key, bucket);
  });
  const kpiTrend = [...kpiTrendMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-8)
    .map(([, bucket]) => ({
      week: bucket.label,
      mttaHours: bucket.mtta.length ? Number((bucket.mtta.reduce((x, y) => x + y, 0) / bucket.mtta.length).toFixed(1)) : 0,
      mttrHours: bucket.mttr.length ? Number((bucket.mttr.reduce((x, y) => x + y, 0) / bucket.mttr.length).toFixed(1)) : 0,
    }));

  if (format === "export" || format === "json") {
    return NextResponse.json(
      {
        exportedAt: new Date().toISOString(),
        currentSummary: summary,
        state,
        snapshots,
      },
      {
        headers: {
          "Content-Disposition": `attachment; filename="health-snapshots-${new Date().toISOString().slice(0, 10)}.json"`,
        },
      },
    );
  }
  if (format === "csv") {
    const posting = summary.missingPostings || {};
    const trend = toTrend(snapshots);
    const lines = [
      ["Health Report", new Date().toLocaleString()].join(","),
      "",
      ["Section", "Metric", "Value"].join(","),
      ["Current status", "Total issue signals", activeIssueSignals].map(csvValue).join(","),
      ["Current status", "Stock mismatches", summary.stockMismatches].map(csvValue).join(","),
      ["Current status", "Order balance mismatches", summary.orderBalanceMismatches].map(csvValue).join(","),
      ["Current status", "Payment mismatches", summary.paymentMismatches].map(csvValue).join(","),
      ["Current status", "Legacy auto-apply", summary.legacyAutoApply].map(csvValue).join(","),
      ["Current status", "Ledger mismatches", summary.ledgerMismatches].map(csvValue).join(","),
      ["Current status", "Negative stock", summary.negativeStock].map(csvValue).join(","),
      ["Current status", "Missing postings - orders", posting.orders ?? 0].map(csvValue).join(","),
      ["Current status", "Missing postings - payments", posting.payments ?? 0].map(csvValue).join(","),
      ["Current status", "Missing postings - expenses", posting.expenses ?? 0].map(csvValue).join(","),
      ["Current status", "Missing postings - purchases", posting.purchases ?? 0].map(csvValue).join(","),
      ["Current status", "Missing postings - supplier payments", posting.supplierPayments ?? 0].map(csvValue).join(","),
      ["Current status", "Missing postings - credit payouts", posting.creditPayouts ?? 0].map(csvValue).join(","),
      ["Current status", "Missing postings - settlements", posting.settlements ?? 0].map(csvValue).join(","),
      ["Ownership", "Owner", state.owner || "-"].map(csvValue).join(","),
      ["Ownership", "Note", state.note || "-"].map(csvValue).join(","),
      ["Ownership", "Acknowledged at", state.acknowledgedAt || "-"].map(csvValue).join(","),
      ["Ownership", "Acknowledged by", state.acknowledgedByName || "-"].map(csvValue).join(","),
      ["Ownership", "Acknowledge still current", stillCurrent ? "Yes" : "No"].map(csvValue).join(","),
      ["Ownership", "Workflow status", state.workflowStatus || "OPEN"].map(csvValue).join(","),
      ["Ownership", "Workflow due date", state.workflowDueAt || "-"].map(csvValue).join(","),
      ["Ownership", "Workflow overdue", workflowOverdue ? "Yes" : "No"].map(csvValue).join(","),
      ["Ownership", "Workflow needs assignment", workflowNeedsAssignment ? "Yes" : "No"].map(csvValue).join(","),
      ["Freshness", "Last diagnostics run", state.lastDiagnosticsAt || "-"].map(csvValue).join(","),
      ["Freshness", "Last alert sent", lastAlert?.createdAt?.toISOString() || "-"].map(csvValue).join(","),
      ["Freshness", "Last POD alert", lastPodAlert?.createdAt?.toISOString() || "-"].map(csvValue).join(","),
      ["Freshness", "Last auto-heal run", state.lastAutoHealAt || "-"].map(csvValue).join(","),
      "",
      ["Trend date", "Issue count"].join(","),
      ...trend.map((t) => [t.date, t.issueCount].map(csvValue).join(",")),
    ];
    const csvText = lines.join("\n");
    const fileName = `health-report-${new Date().toISOString().slice(0, 10)}.csv`;
    const byteSize = new TextEncoder().encode(csvText).length;
    await recordAuditLog({
      actorId: user?.id,
      action: "HEALTH_EXPORT_CSV",
      entityType: "HEALTH_ALERT",
      entityId: `health-export-${Date.now()}`,
      meta: {
        actorName: user?.name || user?.email || "Admin",
        actorEmail: user?.email || null,
        actorRole: user?.role || null,
        exportLabel: "Health report export",
        format: "CSV",
        fileName,
        rowCount: lines.length,
        columnCount: 3,
        byteSize,
        scopeSnapshot: `Issue signals: ${activeIssueSignals} | Workflow status: ${state.workflowStatus || "OPEN"} | Owner: ${state.owner || "Unassigned"}`,
        resultSummary: "Health report exported successfully.",
      },
    });
    return new NextResponse(csvText, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${fileName}"`,
      },
    });
  }
  if (format === "pdf") {
    const posting = summary.missingPostings || {};
    const trend = toTrend(snapshots);
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const pageSize: [number, number] = [595.28, 841.89]; // A4 portrait
    const margin = 36;
    const bodyWidth = pageSize[0] - margin * 2;
    const textColor = rgb(0.1, 0.1, 0.1);
    const muted = rgb(0.35, 0.35, 0.35);
    let page: PDFPage = pdf.addPage(pageSize);
    let y = pageSize[1] - margin;

    const ensureSpace = (requiredHeight: number) => {
      if (y - requiredHeight > margin) return;
      page = pdf.addPage(pageSize);
      y = pageSize[1] - margin;
    };

    const writeLine = (label: string, value: string | number) => {
      const text = `${label}: ${String(value)}`;
      const maxChars = 96;
      const lines: string[] = [];
      let remaining = text.trim();
      while (remaining.length > maxChars) {
        let splitAt = remaining.lastIndexOf(" ", maxChars);
        if (splitAt <= 0) splitAt = maxChars;
        lines.push(remaining.slice(0, splitAt));
        remaining = remaining.slice(splitAt).trim();
      }
      if (remaining) lines.push(remaining);
      ensureSpace(lines.length * 12 + 4);
      lines.forEach((line, idx) => {
        page.drawText(line, {
          x: margin,
          y,
          size: 10,
          font: idx === 0 ? fontBold : font,
          color: textColor,
        });
        y -= 12;
      });
    };

    page.drawText("Health Summary Report", {
      x: margin,
      y,
      size: 16,
      font: fontBold,
      color: textColor,
    });
    y -= 18;
    page.drawText(`Generated: ${new Date().toLocaleString()}`, {
      x: margin,
      y,
      size: 10,
      font,
      color: muted,
    });
    y -= 16;

    page.drawLine({
      start: { x: margin, y },
      end: { x: margin + bodyWidth, y },
      thickness: 0.7,
      color: rgb(0.78, 0.78, 0.78),
    });
    y -= 14;

    page.drawText("Current Status", { x: margin, y, size: 12, font: fontBold, color: textColor });
    y -= 14;
    writeLine("Total issue signals", activeIssueSignals);
    writeLine("Stock mismatches", summary.stockMismatches);
    writeLine("Order balance mismatches", summary.orderBalanceMismatches);
    writeLine("Payment mismatches", summary.paymentMismatches);
    writeLine("Legacy auto-apply", summary.legacyAutoApply);
    writeLine("Ledger mismatches", summary.ledgerMismatches);
    writeLine("Negative stock", summary.negativeStock);
    writeLine("Missing postings - orders", posting.orders ?? 0);
    writeLine("Missing postings - payments", posting.payments ?? 0);
    writeLine("Missing postings - expenses", posting.expenses ?? 0);
    writeLine("Missing postings - purchases", posting.purchases ?? 0);
    writeLine("Missing postings - supplier payments", posting.supplierPayments ?? 0);
    writeLine("Missing postings - credit payouts", posting.creditPayouts ?? 0);
    writeLine("Missing postings - settlements", posting.settlements ?? 0);

    y -= 8;
    ensureSpace(20);
    page.drawText("Ownership and Freshness", { x: margin, y, size: 12, font: fontBold, color: textColor });
    y -= 14;
    writeLine("Owner", state.owner || "-");
    writeLine("Note", state.note || "-");
    writeLine("Acknowledged at", state.acknowledgedAt || "-");
    writeLine("Acknowledged by", state.acknowledgedByName || "-");
    writeLine("Acknowledge still current", stillCurrent ? "Yes" : "No");
    writeLine("Workflow status", state.workflowStatus || "OPEN");
    writeLine("Workflow due date", state.workflowDueAt || "-");
    writeLine("Workflow overdue", workflowOverdue ? "Yes" : "No");
    writeLine("Workflow needs assignment", workflowNeedsAssignment ? "Yes" : "No");
    writeLine("Last diagnostics run", state.lastDiagnosticsAt || "-");
    writeLine("Last alert sent", lastAlert?.createdAt?.toISOString() || "-");
    writeLine("Last POD alert", lastPodAlert?.createdAt?.toISOString() || "-");
    writeLine("Last auto-heal run", state.lastAutoHealAt || "-");

    y -= 8;
    ensureSpace(20);
    page.drawText("Trend (last 7 diagnostics)", { x: margin, y, size: 12, font: fontBold, color: textColor });
    y -= 14;
    trend.forEach((t) => writeLine(t.date, t.issueCount));

    const bytes = await pdf.save();
    const fileName = `health-summary-${new Date().toISOString().slice(0, 10)}.pdf`;
    await recordAuditLog({
      actorId: user?.id,
      action: "HEALTH_EXPORT_PDF",
      entityType: "HEALTH_ALERT",
      entityId: `health-export-${Date.now()}`,
      meta: {
        actorName: user?.name || user?.email || "Admin",
        actorEmail: user?.email || null,
        actorRole: user?.role || null,
        exportLabel: "Health summary export",
        format: "PDF",
        fileName,
        rowCount: trend.length,
        columnCount: 2,
        byteSize: bytes.length,
        scopeSnapshot: `Issue signals: ${activeIssueSignals} | Workflow status: ${state.workflowStatus || "OPEN"} | Owner: ${state.owner || "Unassigned"}`,
        resultSummary: "Health summary PDF exported successfully.",
      },
    });
    return new Response(Uint8Array.from(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${fileName}"`,
      },
    });
  }
  if (format === "handoff") {
    const posting = summary.missingPostings || {};
    const lines: string[] = [];
    lines.push("Health Incident Handoff Bundle");
    lines.push(`Generated At: ${new Date().toLocaleString()}`);
    lines.push(`Generated By: ${user?.name || user?.email || "Admin"}`);
    lines.push("");
    const incidentOnly = handoffScope === "incident";
    lines.push(`Scope: ${incidentOnly ? "Incident only" : "Full snapshot"}`);
    lines.push(`Timeline note limit: ${handoffTimelineLimit}`);
    lines.push("");
    if (!incidentOnly) {
      lines.push("Current Snapshot");
      lines.push(`Issue signals: ${activeIssueSignals}`);
      lines.push(`Issue summary: ${summarizeIssueSignals(summary)}`);
      lines.push(`Workflow owner: ${state.owner || "Unassigned"}`);
      lines.push(`Workflow status: ${state.workflowStatus || "OPEN"}`);
      lines.push(`Workflow due: ${state.workflowDueAt || "-"}`);
      lines.push(`Workflow overdue: ${workflowOverdue ? "Yes" : "No"}`);
      lines.push("");
      lines.push("Signal Breakdown");
      lines.push(`Stock mismatches: ${Number(summary.stockMismatches || 0)}`);
      lines.push(`Order balance mismatches: ${Number(summary.orderBalanceMismatches || 0)}`);
      lines.push(`Payment mismatches: ${Number(summary.paymentMismatches || 0)}`);
      lines.push(`Legacy auto-apply: ${Number(summary.legacyAutoApply || 0)}`);
      lines.push(`Ledger mismatches: ${Number(summary.ledgerMismatches || 0)}`);
      lines.push(`Negative stock: ${Number(summary.negativeStock || 0)}`);
      lines.push(`Missing postings - orders: ${Number(posting.orders || 0)}`);
      lines.push(`Missing postings - payments: ${Number(posting.payments || 0)}`);
      lines.push(`Missing postings - expenses: ${Number(posting.expenses || 0)}`);
      lines.push(`Missing postings - purchases: ${Number(posting.purchases || 0)}`);
      lines.push(`Missing postings - supplier payments: ${Number(posting.supplierPayments || 0)}`);
      lines.push(`Missing postings - credit payouts: ${Number(posting.creditPayouts || 0)}`);
      lines.push(`Missing postings - settlements: ${Number(posting.settlements || 0)}`);
      lines.push(`POD alert active: ${summary.podCompliance7d?.alert ? "Yes" : "No"}`);
      lines.push("");
    }
    lines.push("Incident Context");
    lines.push(`Active incident link: ${activeIncidentLink || "None"}`);
    lines.push(`Latest incident status: ${latestIncident?.status || "-"}`);
    lines.push(`Latest incident opened: ${latestIncident?.openedAt?.toISOString() || "-"}`);
    lines.push(`Latest incident resolved: ${latestIncident?.resolvedAt?.toISOString() || "-"}`);
    lines.push("");
    lines.push("Timeline (latest notes)");
    const limitedTimeline = incidentTimeline.slice(-handoffTimelineLimit);
    if (!limitedTimeline.length) {
      lines.push("- No incident notes yet.");
    } else {
      limitedTimeline.forEach((row) => {
        lines.push(`- ${row.at} | ${row.byName}: ${row.note}`);
      });
    }
    if (!incidentOnly) {
      lines.push("");
      lines.push("Diagnostics Trend (last 7 runs)");
      toTrend(snapshots).forEach((row) => {
        lines.push(`- ${row.date}: ${row.issueCount}`);
      });
    }

    const text = lines.join("\n");
    const fileName = `health-handoff-${new Date().toISOString().slice(0, 10)}.txt`;
    const byteSize = new TextEncoder().encode(text).length;
    await recordAuditLog({
      actorId: user?.id,
      action: "HEALTH_EXPORT_HANDOFF_BUNDLE",
      entityType: "HEALTH_ALERT",
      entityId: `health-handoff-${Date.now()}`,
      meta: {
        actorName: user?.name || user?.email || "Admin",
        actorEmail: user?.email || null,
        actorRole: user?.role || null,
        exportLabel: "Health handoff bundle export",
        format: "TXT",
        fileName,
        lineCount: lines.length,
        byteSize,
        activeIncidentLink,
        handoffScope: incidentOnly ? "incident" : "full",
        timelineLimit: handoffTimelineLimit,
        scopeSnapshot: `Issue signals: ${activeIssueSignals} | Workflow status: ${state.workflowStatus || "OPEN"} | Owner: ${state.owner || "Unassigned"}`,
        resultSummary: "Health handoff bundle exported successfully.",
      },
    });
    return new NextResponse(text, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${fileName}"`,
      },
    });
  }

  return NextResponse.json({
    freshness: {
      diagnosticsAt: state.lastDiagnosticsAt || (snapshots.length ? snapshots[snapshots.length - 1]?.at : null) || null,
      alertSentAt: lastAlert?.createdAt?.toISOString() || null,
      podAlertSentAt: lastPodAlert?.createdAt?.toISOString() || null,
      autoHealAt: state.lastAutoHealAt || null,
    },
    acknowledgement: {
      owner: state.owner || null,
      note: state.note || null,
      acknowledgedAt: state.acknowledgedAt || null,
      acknowledgedByName: state.acknowledgedByName || null,
      stillCurrent,
      status: state.workflowStatus || "OPEN",
      dueAt: state.workflowDueAt || null,
      statusUpdatedAt: state.workflowStatusUpdatedAt || null,
      statusUpdatedByName: state.workflowStatusUpdatedByName || null,
      overdue: workflowOverdue,
      needsAssignment: workflowNeedsAssignment,
    },
    trend: toTrend(snapshots),
    autoHeal: {
      enabled: process.env.ACCOUNTING_AUTO_HEAL_MISSING_POSTINGS === "1",
      lastRunAt: state.lastAutoHealAt || null,
      lastRunByName: state.lastAutoHealByName || null,
      lastResult: state.lastAutoHealResult || null,
    },
    kpis,
    kpiTrend,
    lastSentAlert: {
      at: lastAlert?.createdAt?.toISOString() || null,
      byName: String(lastAlertMeta.initiatedByName || "Not provided"),
      recipientCount: Number(lastAlertMeta.recipientCount || 0),
      recipients: Array.isArray(lastAlertMeta.recipients)
        ? (lastAlertMeta.recipients as unknown[]).map((item) => String(item || "")).filter(Boolean)
        : [],
      issueSummary: String(lastAlertMeta.issueSummary || ""),
      triggerSource: String(lastAlertMeta.triggerSource || ""),
      resultSummary: String(lastAlertMeta.resultSummary || ""),
    },
    lastAlertActivity: {
      at: lastAlertActivity?.createdAt?.toISOString() || null,
      action: String(lastAlertActivity?.action || ""),
      byName: String(lastAlertActivityMeta.initiatedByName || "Not provided"),
      recipientCount: Number(lastAlertActivityMeta.recipientCount || 0),
      issueSummary: String(lastAlertActivityMeta.issueSummary || ""),
      reason: String(lastAlertActivityMeta.reason || ""),
      result: String(lastAlertActivityMeta.result || ""),
    },
    alertRecipients: adminRecipients.map((row) => ({
      name: row.name || "Admin",
      email: row.email || "",
    })),
    alertGuard: {
      forceSendMaxDiagnosticsAgeHours: Number(process.env.HEALTH_ALERT_FORCE_MAX_DIAGNOSTIC_AGE_HOURS || 6),
    },
    incident: latestIncident
      ? {
          id: latestIncident.id,
          status: latestIncident.status,
          isManual: latestIncident.isManual,
          openedAt: latestIncident.openedAt.toISOString(),
          resolvedAt: latestIncident.resolvedAt?.toISOString() || null,
          followUpDueAt: latestIncident.followUpDueAt?.toISOString() || null,
          issueSummary: latestIncident.issueSummary,
          issueCount: latestIncident.issueCount,
        }
      : null,
    activeIncidentLink,
    incidentTimeline,
    exportLinks: {
      csv: "/api/admin/health/ops?format=csv",
      pdf: "/api/admin/health/ops?format=pdf",
      handoff: "/api/admin/health/ops?format=handoff",
    },
  });
}

export async function POST(req: Request) {
  const configuredSecret = String(process.env.CRON_SECRET || "").trim();
  const authHeader = String((req.headers.get("authorization") || "").trim());
  const bearer = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : authHeader;
  const headerSecret = String((req.headers.get("x-cron-secret") || "").trim());
  const hasCronAccess =
    Boolean(configuredSecret) &&
    (bearer === configuredSecret || headerSecret === configuredSecret);

  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const hasSessionAccess = Boolean(session && isAuthorized(user));
  if (!hasSessionAccess && !hasCronAccess) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (hasSessionAccess && !hasCronAccess && !assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-health-ops", 60_000, 30);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as {
    action?: "run_diagnostics" | "acknowledge" | "run_auto_heal" | "add_incident_note" | "run_escalation_check";
    owner?: string | null;
    note?: string | null;
    workflowStatus?: "OPEN" | "IN_PROGRESS" | "RESOLVED" | null;
    workflowDueAt?: string | null;
    incidentNote?: string | null;
    incidentMode?: "DETECTOR_BACKED" | "OPERATIONAL_FOLLOW_UP" | null;
    followUpDueAt?: string | null;
  } | null;
  const action = body?.action || "run_diagnostics";
  if (hasCronAccess && action !== "run_escalation_check") {
    return NextResponse.json({ error: "Cron access is limited to escalation checks." }, { status: 403 });
  }

  const state = await getSetting<OpsState>(OPS_STATE_KEY, {});
  const snapshots = await getSetting<Snapshot[]>(OPS_SNAPSHOTS_KEY, []);

  if (action === "run_diagnostics") {
    const summary = await fetchSummary(req);
    const nowIso = new Date().toISOString();
    const totalIssueSignals = issueCount(summary);
    const nextSnapshots = trimSnapshots([
      ...snapshots,
      { at: nowIso, issueCount: totalIssueSignals },
    ]);
    const nextState: OpsState = {
      ...state,
      lastDiagnosticsAt: nowIso,
      lastDiagnosticsById: user?.id || null,
      lastDiagnosticsByName: user?.name || user?.email || "Admin",
    };
    if (totalIssueSignals > 0) {
      const existingIncident = await prisma.healthIncident.findFirst({
        where: {
          fingerprint: fingerprint(summary),
          status: { in: ["OPEN", "IN_PROGRESS"] },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (existingIncident) {
        await prisma.healthIncident.update({
          where: { id: existingIncident.id },
          data: {
            issueCount: totalIssueSignals,
            issueSummary: summarizeIssueSignals(summary),
          },
        });
      } else {
        await prisma.healthIncident.create({
          data: {
            fingerprint: fingerprint(summary),
            isManual: false,
            issueCount: totalIssueSignals,
            issueSummary: summarizeIssueSignals(summary),
            status: "OPEN",
            openedById: user?.id || null,
          },
        });
      }
    } else {
      const openIncident = await prisma.healthIncident.findFirst({
        where: { status: { in: ["OPEN", "IN_PROGRESS"] } },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (openIncident) {
        await prisma.healthIncident.update({
          where: { id: openIncident.id },
          data: {
            status: "RESOLVED",
            resolvedAt: nowIso,
            resolvedById: user?.id || null,
          },
        });
      }
    }
    await Promise.all([
      setSetting(OPS_SNAPSHOTS_KEY, nextSnapshots),
      setSetting(OPS_STATE_KEY, nextState),
      recordAuditLog({
        actorId: user?.id,
        action: "HEALTH_DIAGNOSTICS_RUN",
        entityType: "HEALTH_ALERT",
        entityId: `manual-${Date.now()}`,
        meta: {
          initiatedByName: user?.name || user?.email || "Admin",
          initiatedByEmail: user?.email || null,
          initiatedByRole: user?.role || null,
          triggerSource: "Manual diagnostics run from Health Check page",
          diagnosticsRunAt: nowIso,
          issueCount: totalIssueSignals,
          issueSummary: summarizeIssueSignals(summary),
          issueBreakdown: buildIssueBreakdown(summary),
          result: totalIssueSignals > 0 ? "Issues detected. Follow triage workflow." : "Healthy. No issues detected.",
        },
      }),
    ]);
    const activeIncidentAfter = await prisma.healthIncident.findFirst({
      where: { status: { in: ["OPEN", "IN_PROGRESS"] } },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    const escalation = await maybeSendEscalationEmail({
      user,
      summary,
      state: nextState,
      activeIncidentId: activeIncidentAfter?.id || null,
    });
    if (escalation.sent) {
      await recordAuditLog({
        actorId: user?.id,
        action: "HEALTH_INCIDENT_ESCALATION_SENT",
        entityType: "HEALTH_ALERT",
        entityId: activeIncidentAfter?.id || `esc-${Date.now()}`,
        meta: {
          initiatedByName: user?.name || user?.email || "Admin",
          initiatedByEmail: user?.email || null,
          escalationLevel: escalation.level,
          overdueHours: escalation.overdueHours,
          recipientCount: escalation.recipientCount,
          recipients: escalation.recipients,
          triggerSource: "Auto check after diagnostics run",
          result: "Escalation email sent.",
        },
      });
    }
    return NextResponse.json({ ok: true });
  }

  if (action === "acknowledge") {
    const summary = await fetchSummary(req);
    const nowIso = new Date().toISOString();
    const requestedStatus = String(body?.workflowStatus || state.workflowStatus || "OPEN").toUpperCase();
    const workflowStatus =
      requestedStatus === "IN_PROGRESS" || requestedStatus === "RESOLVED" ? requestedStatus : "OPEN";
    const acknowledgementNote = String(body?.note || "").trim();
    if (workflowStatus === "RESOLVED" && acknowledgementNote.length < 12) {
      return NextResponse.json(
        { error: "Resolution evidence note is required when status is Resolved (minimum 12 characters)." },
        { status: 400 },
      );
    }
    const dueAtRaw = String(body?.workflowDueAt || "").trim();
    let workflowDueAt: string | null = null;
    if (dueAtRaw) {
      const due = new Date(dueAtRaw);
      if (Number.isNaN(due.getTime())) {
        return NextResponse.json({ error: "Invalid workflow due date." }, { status: 400 });
      }
      workflowDueAt = due.toISOString();
    }
    let nextState: OpsState = {
      ...state,
      owner: body?.owner?.trim() || null,
      note: acknowledgementNote || null,
      acknowledgedAt: nowIso,
      acknowledgedById: user?.id || null,
      acknowledgedByName: user?.name || user?.email || "Admin",
      issueFingerprint: fingerprint(summary),
      workflowStatus: workflowStatus as "OPEN" | "IN_PROGRESS" | "RESOLVED",
      workflowDueAt,
      workflowStatusUpdatedAt: nowIso,
      workflowStatusUpdatedByName: user?.name || user?.email || "Admin",
    };
    const beforeOwner = state.owner || null;
    const beforeStatus = state.workflowStatus || "OPEN";
    const beforeDueAt = state.workflowDueAt || null;
    const afterOwner = nextState.owner || null;
    const afterStatus = nextState.workflowStatus || "OPEN";
    const totalIssueSignals = issueCount(summary);
    if (workflowStatus === "RESOLVED" && totalIssueSignals === 0) {
      nextState = { ...nextState, workflowDueAt: null };
    }
    const afterDueAt = nextState.workflowDueAt || null;
    if (totalIssueSignals > 0) {
      const incidentStatus = mapWorkflowStatusToIncidentStatus(nextState.workflowStatus || "OPEN");
      const existingIncident = await prisma.healthIncident.findFirst({
        where: {
          fingerprint: fingerprint(summary),
          status: { in: ["OPEN", "IN_PROGRESS", "RESOLVED"] },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (existingIncident) {
        await prisma.healthIncident.update({
          where: { id: existingIncident.id },
          data: {
            status: incidentStatus,
            issueCount: totalIssueSignals,
            issueSummary: summarizeIssueSignals(summary),
            resolvedAt: incidentStatus === "RESOLVED" ? nowIso : null,
            resolvedById: incidentStatus === "RESOLVED" ? user?.id || null : null,
          },
        });
      } else {
        await prisma.healthIncident.create({
          data: {
            fingerprint: fingerprint(summary),
            isManual: false,
            issueCount: totalIssueSignals,
            issueSummary: summarizeIssueSignals(summary),
            status: incidentStatus,
            openedById: user?.id || null,
            resolvedAt: incidentStatus === "RESOLVED" ? nowIso : null,
            resolvedById: incidentStatus === "RESOLVED" ? user?.id || null : null,
          },
        });
      }
    }
    await Promise.all([
      setSetting(OPS_STATE_KEY, nextState),
      recordAuditLog({
        actorId: user?.id,
        action: "HEALTH_ACKNOWLEDGED",
        entityType: "HEALTH_ALERT",
        entityId: `ack-${Date.now()}`,
        meta: {
          initiatedByName: user?.name || user?.email || "Admin",
          initiatedByEmail: user?.email || null,
          initiatedByRole: user?.role || null,
          acknowledgementAt: nowIso,
          issueCount: totalIssueSignals,
          issueSummary: summarizeIssueSignals(summary),
          issueBreakdown: buildIssueBreakdown(summary),
          workflowBefore: {
            owner: beforeOwner,
            status: beforeStatus,
            dueAt: beforeDueAt,
            note: state.note || null,
          },
          workflowAfter: {
            owner: afterOwner,
            status: afterStatus,
            dueAt: afterDueAt,
            note: nextState.note || null,
          },
          changeSummary: `Owner ${beforeOwner || "Unassigned"} -> ${afterOwner || "Unassigned"}; status ${String(beforeStatus)
            .replace(/_/g, " ")
            .toLowerCase()} -> ${String(afterStatus).replace(/_/g, " ").toLowerCase()}; due date ${beforeDueAt || "Not set"} -> ${afterDueAt || "Not set"}`,
          requiresFollowUp: totalIssueSignals > 0,
          followUpGuidance:
            totalIssueSignals > 0
              ? "Issues remain. Keep status In Progress or Open until diagnostics return healthy."
              : "No issue signals remain. Resolution can be closed with evidence.",
        },
      }),
    ]);
    const activeIncidentAfter = await prisma.healthIncident.findFirst({
      where: { status: { in: ["OPEN", "IN_PROGRESS"] } },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    const escalation = await maybeSendEscalationEmail({
      user,
      summary,
      state: nextState,
      activeIncidentId: activeIncidentAfter?.id || null,
    });
    if (escalation.sent) {
      await recordAuditLog({
        actorId: user?.id,
        action: "HEALTH_INCIDENT_ESCALATION_SENT",
        entityType: "HEALTH_ALERT",
        entityId: activeIncidentAfter?.id || `esc-${Date.now()}`,
        meta: {
          initiatedByName: user?.name || user?.email || "Admin",
          initiatedByEmail: user?.email || null,
          escalationLevel: escalation.level,
          overdueHours: escalation.overdueHours,
          recipientCount: escalation.recipientCount,
          recipients: escalation.recipients,
          triggerSource: "Auto check after acknowledgement save",
          result: "Escalation email sent.",
        },
      });
    }
    const clearNote = workflowStatus === "RESOLVED" && totalIssueSignals === 0;
    return NextResponse.json({
      ok: true,
      acknowledgement: {
        owner: nextState.owner || null,
        note: clearNote ? null : nextState.note || null,
        status: nextState.workflowStatus || "OPEN",
        dueAt: nextState.workflowDueAt || null,
        acknowledgedAt: nextState.acknowledgedAt || null,
        acknowledgedByName: nextState.acknowledgedByName || null,
      },
      issueCount: totalIssueSignals,
      clearNote,
    });
  }

  if (action === "run_auto_heal") {
    if (process.env.ACCOUNTING_AUTO_HEAL_MISSING_POSTINGS !== "1") {
      return NextResponse.json({ error: "Auto-heal is disabled" }, { status: 400 });
    }
    const beforeSummary = await fetchSummary(req);
    const beforeIssueCount = issueCount(beforeSummary);
    const heal = await autoHealMissingPostings();
    const summary = await fetchSummary(req);
    const afterIssueCount = issueCount(summary);
    const nowIso = new Date().toISOString();
    const nextSnapshots = trimSnapshots([
      ...snapshots,
      { at: nowIso, issueCount: afterIssueCount },
    ]);
    const nextState: OpsState = {
      ...state,
      lastAutoHealAt: nowIso,
      lastAutoHealById: user?.id || null,
      lastAutoHealByName: user?.name || user?.email || "Admin",
      lastAutoHealResult: heal,
      lastDiagnosticsAt: nowIso,
      lastDiagnosticsById: user?.id || null,
      lastDiagnosticsByName: user?.name || user?.email || "Admin",
    };

    await Promise.all([
      setSetting(OPS_SNAPSHOTS_KEY, nextSnapshots),
      setSetting(OPS_STATE_KEY, nextState),
      recordAuditLog({
        actorId: user?.id,
        action: "HEALTH_AUTO_HEAL_RUN",
        entityType: "HEALTH_ALERT",
        entityId: `heal-${Date.now()}`,
        meta: {
          initiatedByName: user?.name || user?.email || "Admin",
          initiatedByEmail: user?.email || null,
          initiatedByRole: user?.role || null,
          triggerSource: "Manual auto-heal run from Health Check page",
          autoHealRunAt: nowIso,
          beforeIssueCount,
          afterIssueCount,
          issueCountDelta: afterIssueCount - beforeIssueCount,
          beforeIssueSummary: summarizeIssueSignals(beforeSummary),
          afterIssueSummary: summarizeIssueSignals(summary),
          beforeIssueBreakdown: buildIssueBreakdown(beforeSummary),
          afterIssueBreakdown: buildIssueBreakdown(summary),
          postingRepairs: heal?.posted || null,
          result:
            afterIssueCount < beforeIssueCount
              ? "Auto-heal reduced issue signals."
              : afterIssueCount === beforeIssueCount
                ? "Auto-heal completed with no net issue-count change."
                : "Issue signals increased after auto-heal. Investigate manually.",
        },
      }),
    ]);

    return NextResponse.json({ ok: true, heal });
  }

  if (action === "run_escalation_check") {
    const summary = await fetchSummary(req);
    const latestState = await getSetting<OpsState>(OPS_STATE_KEY, {});
    const activeIncident = await prisma.healthIncident.findFirst({
      where: { status: { in: ["OPEN", "IN_PROGRESS"] } },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    const escalation = await maybeSendEscalationEmail({
      user,
      summary,
      state: latestState,
      activeIncidentId: activeIncident?.id || null,
    });
    if (!escalation.sent) {
      await recordAuditLog({
        actorId: user?.id,
        action: "HEALTH_INCIDENT_ESCALATION_SKIPPED",
        entityType: "HEALTH_ALERT",
        entityId: activeIncident?.id || `esc-${Date.now()}`,
        meta: {
          initiatedByName: user?.name || user?.email || "Admin",
          initiatedByEmail: user?.email || null,
          triggerSource: "Manual escalation check from Health page",
          reason: escalation.reason || "Escalation criteria not met.",
          result: "Escalation not sent.",
        },
      });
      return NextResponse.json({ ok: true, skipped: true, reason: escalation.reason || "Escalation not sent." });
    }
    await recordAuditLog({
      actorId: user?.id,
      action: "HEALTH_INCIDENT_ESCALATION_SENT",
      entityType: "HEALTH_ALERT",
      entityId: activeIncident?.id || `esc-${Date.now()}`,
      meta: {
        initiatedByName: user?.name || user?.email || "Admin",
        initiatedByEmail: user?.email || null,
        escalationLevel: escalation.level,
        overdueHours: escalation.overdueHours,
        recipientCount: escalation.recipientCount,
        recipients: escalation.recipients,
        triggerSource: "Manual escalation check from Health page",
        result: "Escalation email sent.",
      },
    });
    return NextResponse.json({ ok: true, escalation });
  }

  if (action === "add_incident_note") {
    const note = String(body?.incidentNote || "").trim();
    if (note.length < 8) {
      return NextResponse.json({ error: "Incident note must be at least 8 characters." }, { status: 400 });
    }
    const incidentMode = String(body?.incidentMode || "DETECTOR_BACKED").toUpperCase();
    if (incidentMode !== "DETECTOR_BACKED" && incidentMode !== "OPERATIONAL_FOLLOW_UP") {
      return NextResponse.json({ error: "Invalid incident mode." }, { status: 400 });
    }
    const nowIso = new Date().toISOString();
    const actorName = user?.name || user?.email || "Admin";
    const summary = await fetchSummary(req);
    const totalIssueSignals = issueCount(summary);
    const currentFingerprint = fingerprint(summary);
    if (totalIssueSignals <= 0 && incidentMode !== "OPERATIONAL_FOLLOW_UP") {
      return NextResponse.json(
        {
          error:
            "No active health signals. Choose Operational follow-up for manual documentation or run diagnostics during an active incident.",
        },
        { status: 400 },
      );
    }
    const followUpDueAtRaw = String(body?.followUpDueAt || "").trim();
    let followUpDueAt: string | null = null;
    if (followUpDueAtRaw) {
      const due = new Date(followUpDueAtRaw);
      if (Number.isNaN(due.getTime())) {
        return NextResponse.json({ error: "Invalid follow-up due date." }, { status: 400 });
      }
      followUpDueAt = due.toISOString();
    }
    let incident = await prisma.healthIncident.findFirst({
      where: totalIssueSignals > 0
        ? {
            fingerprint: currentFingerprint,
            status: { in: ["OPEN", "IN_PROGRESS", "RESOLVED"] },
          }
        : {
            status: { in: ["OPEN", "IN_PROGRESS"] },
            isManual: true,
          },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (!incident && totalIssueSignals > 0) {
      incident = await prisma.healthIncident.create({
        data: {
          fingerprint: currentFingerprint,
          issueCount: totalIssueSignals,
          issueSummary: summarizeIssueSignals(summary),
          status: "OPEN",
          openedById: user?.id || null,
        },
        select: { id: true },
      });
    }
    if (!incident) {
      incident = await prisma.healthIncident.create({
        data: {
          fingerprint: totalIssueSignals > 0 ? currentFingerprint : `manual:${nowIso.slice(0, 10)}`,
          isManual: totalIssueSignals <= 0,
          issueCount: totalIssueSignals,
          issueSummary:
            totalIssueSignals > 0
              ? summarizeIssueSignals(summary)
              : "Manual health follow-up (no active issue signals at note time).",
          followUpDueAt,
          status: "OPEN",
          openedById: user?.id || null,
        },
        select: { id: true },
      });
    }
    await Promise.all([
      prisma.healthIncidentNote.create({
        data: {
          incidentId: incident.id,
          note,
          createdById: user?.id || null,
          createdByName: actorName,
        },
      }),
      recordAuditLog({
        actorId: user?.id,
        action: "HEALTH_INCIDENT_NOTE_ADDED",
        entityType: "HEALTH_ALERT",
        entityId: `note-${Date.now()}`,
        meta: {
          initiatedByName: actorName,
          initiatedByEmail: user?.email || null,
          initiatedByRole: user?.role || null,
          addedAt: nowIso,
          incidentId: incident.id,
          incidentMode,
          followUpDueAt,
          note,
          result: "Incident timeline note added.",
        },
      }),
    ]);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
}
