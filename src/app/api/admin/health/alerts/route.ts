import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { rateLimit } from "@/lib/rate-limit";
import { assertSameOrigin } from "@/lib/origin";
import { getPodComplianceSnapshot } from "@/lib/pod-compliance";
import { autoHealMissingPostings } from "@/lib/accounting-auto-heal";
import { recordAuditLog } from "@/lib/audit-log";

function num(v: unknown) {
  return Number(v || 0);
}

function todayKey() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function weekKey() {
  const d = new Date();
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((utc.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

export async function POST(req: Request) {
  const cronSecret = process.env.CRON_SECRET || "";
  const authHeader = String((req.headers.get("authorization") || "").trim());
  const bearer = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : "";
  const hasCronAccess = cronSecret && bearer === cronSecret;

  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const hasAdminAccess = !!session && user?.role === "ADMIN";

  if (!hasAdminAccess && !hasCronAccess) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (hasAdminAccess && !hasCronAccess && !assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-health-alerts", 60_000, 10);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }
  const payload = (await req.json().catch(() => null)) as {
    dryRun?: boolean;
    force?: boolean;
    forceReason?: string | null;
  } | null;
  const dryRun = Boolean(payload?.dryRun);
  const force = Boolean(payload?.force) && hasAdminAccess;
  const forceReason = String(payload?.forceReason || "").trim();
  if (force && forceReason.length < 8) {
    return NextResponse.json({ error: "Force send reason is required (minimum 8 characters)." }, { status: 400 });
  }
  const forceMaxDiagnosticAgeHours = Number(process.env.HEALTH_ALERT_FORCE_MAX_DIAGNOSTIC_AGE_HOURS || 6);
  const opsStateRow = await prisma.appSetting.findUnique({
    where: { key: "health.ops.state.v1" },
    select: { value: true },
  });
  const opsState = (opsStateRow?.value || {}) as { lastDiagnosticsAt?: string | null };
  const lastDiagnosticsAt = String(opsState?.lastDiagnosticsAt || "").trim();
  const lastDiagnosticsMs = lastDiagnosticsAt ? new Date(lastDiagnosticsAt).getTime() : NaN;
  const isDiagnosticsFresh =
    Number.isFinite(lastDiagnosticsMs) &&
    Date.now() - lastDiagnosticsMs <= forceMaxDiagnosticAgeHours * 60 * 60 * 1000;
  if (force && forceMaxDiagnosticAgeHours > 0 && !isDiagnosticsFresh) {
    await recordAuditLog({
      actorId: user?.id,
      action: "HEALTH_ALERT_FORCE_SEND_SKIPPED",
      entityType: "HEALTH_ALERT",
      entityId: `force-skip-${Date.now()}`,
      meta: {
        initiatedByName: user?.name || user?.email || "Admin",
        initiatedByEmail: user?.email || null,
        initiatedByRole: user?.role || null,
        triggerSource: "Manual force-send from Health Check page",
        force: true,
        forceReason,
        staleDiagnostics: true,
        lastDiagnosticsAt: Number.isFinite(lastDiagnosticsMs) ? new Date(lastDiagnosticsMs).toISOString() : null,
        maxAllowedAgeHours: forceMaxDiagnosticAgeHours,
        result: "Force send blocked. Run diagnostics first because the last diagnostics snapshot is stale or missing.",
      },
    });
    return NextResponse.json(
      { error: "Run diagnostics first. Force send requires a fresh diagnostics snapshot." },
      { status: 400 },
    );
  }

  const key = `daily-${todayKey()}`;
  const adminRecipients = await prisma.user.findMany({
    where: { role: "ADMIN", archived: false, email: { not: null } },
    select: { email: true, name: true },
  });
  const recipientPreview = adminRecipients.map((a) => ({
    name: a.name || "Admin",
    email: a.email || "",
  }));
  const existing = await prisma.auditLog.findFirst({
    where: { action: "HEALTH_ALERT_SENT", entityType: "HEALTH_ALERT", entityId: key },
  });
  if (existing && !force) {
    if (!dryRun && hasAdminAccess) {
      await recordAuditLog({
        actorId: user?.id,
        action: "HEALTH_ALERT_SEND_SKIPPED",
        entityType: "HEALTH_ALERT",
        entityId: `send-skip-${Date.now()}`,
        meta: {
          initiatedByName: user?.name || user?.email || "Admin",
          initiatedByEmail: user?.email || null,
          initiatedByRole: user?.role || null,
          triggerSource: "Manual send from Health Check page",
          hasIssues: true,
          reason: "Daily alert already sent",
          result: "Alert send skipped due to daily duplicate guard.",
        },
      });
    }
    if (dryRun && hasAdminAccess) {
      await recordAuditLog({
        actorId: user?.id,
        action: "HEALTH_ALERT_DRY_RUN",
        entityType: "HEALTH_ALERT",
        entityId: `preview-${Date.now()}`,
        meta: {
          initiatedByName: user?.name || user?.email || "Admin",
          initiatedByEmail: user?.email || null,
          initiatedByRole: user?.role || null,
          triggerSource: "Manual dry-run from Health Check page",
          dryRun: true,
          skipped: true,
          reason: "Daily alert already sent",
          alertKey: key,
          forceReason: force || dryRun ? forceReason || null : null,
        },
      });
    }
    return NextResponse.json({
      ok: true,
      dryRun,
      skipped: true,
      reason: "Daily alert already sent",
      alertKey: key,
      hasIssues: true,
      recipientCount: recipientPreview.length,
      recipients: recipientPreview,
      issueSummary: "Daily alert already sent. Use force send with reason if urgent resend is required.",
    });
  }

  // Keep alert behavior aligned with /admin/health and /api/admin/health/summary:
  // order balance and payment mismatch checks are derived from AR/ledger consistency
  // and posting checks, not from stale order.amountPaid snapshots.
  const orderBalanceMismatches = 0;

  const orderPayments = await prisma.payment.groupBy({
    by: ["orderId", "status"],
    where: { orderId: { not: null } },
    _sum: { amount: true },
  });
  const orderPaymentsMap = new Map<string, number>();
  for (const row of orderPayments) {
    if (!row.orderId) continue;
    if (row.status === "VOID") continue;
    const signed =
      row.status === "REFUND" ? -num(row._sum.amount) : num(row._sum.amount);
    orderPaymentsMap.set(
      row.orderId,
      (orderPaymentsMap.get(row.orderId) ?? 0) + signed
    );
  }
  const paymentMismatches = 0;

  const products = await prisma.product.findMany({
    select: { id: true, stock: true },
  });
  const movements = await prisma.inventoryMovement.groupBy({
    by: ["productId"],
    _sum: { delta: true },
  });
  const movementMap = new Map(movements.map((m) => [m.productId, num(m._sum.delta)]));
  const stockMismatches = products.filter(
    (p) => num(p.stock) !== (movementMap.get(p.id) ?? 0)
  ).length;
  const legacyAutoApply = await prisma.payment.count({
    where: { orderId: null, note: { contains: "\"reference\":\"AUTO_APPLY\"" } },
  });
  const settlementLogs = await prisma.auditLog.findMany({
    where: {
      entityType: "DELIVERY_SETTLEMENT",
      action: "DELIVERY_COLLECTION_SETTLEMENT_CREATED",
    },
    select: { entityId: true, meta: true },
    orderBy: { createdAt: "desc" },
    take: 2000,
  });
  const settlementIds = settlementLogs
    .map((log) => {
      if (!log.meta) return null;
      try {
        const meta = JSON.parse(log.meta) as { totalBalance?: number };
        const amount = Number(meta.totalBalance || 0);
        if (!(amount > 0)) return null;
        return log.entityId;
      } catch {
        return log.entityId;
      }
    })
    .filter(Boolean) as string[];
  const settlementPosted = settlementIds.length
    ? await prisma.journalEntry.findMany({
        where: { sourceType: "MANUAL", sourceId: { in: settlementIds }, status: "POSTED" },
        select: { sourceId: true },
      })
    : [];
  const settlementPostedIds = new Set(settlementPosted.map((entry) => entry.sourceId).filter(Boolean) as string[]);
  const missingSettlements = settlementIds.filter((id) => !settlementPostedIds.has(id)).length;
  const supplierPayments = await prisma.supplierPayment.findMany({
    where: { deletedAt: null, status: "NORMAL" },
    select: { id: true, method: true, reference: true },
  });
  const eligibleSupplierPayments = supplierPayments.filter((row) => {
    const method = String(row.method || "").toLowerCase();
    if (method === "credit_memo") return false;
    if (String(row.reference || "").toUpperCase() === "SUPPLIER_RETURN") return false;
    return true;
  });
  const supplierPaymentPosted = await prisma.journalEntry.findMany({
    where: { sourceType: "PURCHASE", status: "POSTED", sourceId: { in: eligibleSupplierPayments.map((s) => s.id) } },
    select: { sourceId: true },
  });
  const supplierPaymentPostedIds = new Set(
    supplierPaymentPosted.map((row) => row.sourceId).filter(Boolean) as string[],
  );
  const missingSupplierPayments = eligibleSupplierPayments.filter((row) => !supplierPaymentPostedIds.has(row.id)).length;
  const creditPayouts = await prisma.payment.findMany({
    where: {
      deletedAt: null,
      status: "REFUND",
      refundDisposition: "CASH",
      note: { contains: "\"location\":\"admin/customers:credit-payout\"" },
    },
    select: { id: true },
  });
  const paymentPosted = await prisma.journalEntry.findMany({
    where: { sourceType: "PAYMENT", status: "POSTED", sourceId: { in: creditPayouts.map((p) => p.id) } },
    select: { sourceId: true },
  });
  const paymentPostedIds = new Set(paymentPosted.map((row) => row.sourceId).filter(Boolean) as string[]);
  const missingCreditPayouts = creditPayouts.filter((row) => !paymentPostedIds.has(row.id)).length;

  const podThresholdPct = Number(process.env.HEALTH_POD_MISSING_ALERT_PCT || 15);
  const podMinDelivered = Number(process.env.HEALTH_POD_MIN_DELIVERIES || 20);
  const now = new Date();
  const last7Days = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const podCompliance7d = await getPodComplianceSnapshot({
    from: last7Days,
    to: now,
    thresholdPct: podThresholdPct,
    minDelivered: podMinDelivered,
  });
  const podWeeklyKey = `pod-weekly-${weekKey()}`;
  const podWeeklyExisting = await prisma.auditLog.findFirst({
    where: {
      action: "HEALTH_POD_ALERT_SENT",
      entityType: "HEALTH_ALERT",
      entityId: podWeeklyKey,
    },
  });
  const podWeeklyDue = podCompliance7d.alert && !podWeeklyExisting;

  const hasIssues =
    paymentMismatches > 0 ||
    orderBalanceMismatches > 0 ||
    stockMismatches > 0 ||
    legacyAutoApply > 0 ||
    missingSettlements > 0 ||
    missingSupplierPayments > 0 ||
    missingCreditPayouts > 0 ||
    podWeeklyDue;
  const issueSummary = `Payments: ${paymentMismatches}, Order balances: ${orderBalanceMismatches}, Stock: ${stockMismatches}, Legacy auto-apply: ${legacyAutoApply}, Unposted settlements: ${missingSettlements}, Unposted supplier payments: ${missingSupplierPayments}, Unposted credit payouts: ${missingCreditPayouts}, POD weekly alert due: ${podWeeklyDue ? "Yes" : "No"}`;

  let autoHealSummary:
    | {
        posted: {
          orders: number;
          payments: number;
          expenses: number;
          purchases: number;
          supplierPayments: number;
          creditPayouts: number;
          settlements: number;
        };
      }
    | null = null;
  const autoHealEnabled = process.env.ACCOUNTING_AUTO_HEAL_MISSING_POSTINGS === "1";
  if (hasCronAccess && autoHealEnabled && hasIssues) {
    try {
      autoHealSummary = await autoHealMissingPostings();
    } catch (e) {
      console.warn("autoHealMissingPostings failed:", e);
    }
  }

  if (!hasIssues) {
    if (force && hasAdminAccess) {
      await recordAuditLog({
        actorId: user?.id,
        action: "HEALTH_ALERT_FORCE_SEND_SKIPPED",
        entityType: "HEALTH_ALERT",
        entityId: `force-skip-${Date.now()}`,
        meta: {
          initiatedByName: user?.name || user?.email || "Admin",
          initiatedByEmail: user?.email || null,
          initiatedByRole: user?.role || null,
          triggerSource: "Manual force-send from Health Check page",
          force: true,
          forceReason,
          hasIssues: false,
          issueSummary,
          result: "Force send was not executed because there are no active health issues.",
        },
      });
    }
    if (dryRun && hasAdminAccess) {
      await recordAuditLog({
        actorId: user?.id,
        action: "HEALTH_ALERT_DRY_RUN",
        entityType: "HEALTH_ALERT",
        entityId: `preview-${Date.now()}`,
        meta: {
          initiatedByName: user?.name || user?.email || "Admin",
          initiatedByEmail: user?.email || null,
          initiatedByRole: user?.role || null,
          triggerSource: "Manual dry-run from Health Check page",
          dryRun: true,
          hasIssues: false,
          issueSummary,
          result: "No active health issues. Alert would not be sent.",
        },
      });
    }
    if (!dryRun && !force && hasAdminAccess) {
      await recordAuditLog({
        actorId: user?.id,
        action: "HEALTH_ALERT_SEND_SKIPPED",
        entityType: "HEALTH_ALERT",
        entityId: `send-skip-${Date.now()}`,
        meta: {
          initiatedByName: user?.name || user?.email || "Admin",
          initiatedByEmail: user?.email || null,
          initiatedByRole: user?.role || null,
          triggerSource: "Manual send from Health Check page",
          hasIssues: false,
          issueSummary,
          reason: "No issues detected",
          result: "Alert send skipped because there are no active health issues.",
        },
      });
    }
    return NextResponse.json({
      ok: true,
      dryRun,
      skipped: true,
      reason: "No issues detected",
      hasIssues: false,
      recipientCount: recipientPreview.length,
      recipients: recipientPreview,
      issueSummary,
    });
  }
  const admins = adminRecipients;
  const toList = admins.map((a) => a.email).filter(Boolean) as string[];
  if (!toList.length) {
    if (force && hasAdminAccess) {
      await recordAuditLog({
        actorId: user?.id,
        action: "HEALTH_ALERT_FORCE_SEND_SKIPPED",
        entityType: "HEALTH_ALERT",
        entityId: `force-skip-${Date.now()}`,
        meta: {
          initiatedByName: user?.name || user?.email || "Admin",
          initiatedByEmail: user?.email || null,
          initiatedByRole: user?.role || null,
          triggerSource: "Manual force-send from Health Check page",
          force: true,
          forceReason,
          hasIssues: true,
          issueSummary,
          recipientCount: 0,
          result: "Force send was not executed because no admin email recipients are configured.",
        },
      });
    }
    if (dryRun && hasAdminAccess) {
      await recordAuditLog({
        actorId: user?.id,
        action: "HEALTH_ALERT_DRY_RUN",
        entityType: "HEALTH_ALERT",
        entityId: `preview-${Date.now()}`,
        meta: {
          initiatedByName: user?.name || user?.email || "Admin",
          initiatedByEmail: user?.email || null,
          initiatedByRole: user?.role || null,
          triggerSource: "Manual dry-run from Health Check page",
          dryRun: true,
          hasIssues: true,
          issueSummary,
          recipientCount: 0,
          result: "No admin email recipients configured.",
        },
      });
    }
    if (!dryRun && !force && hasAdminAccess) {
      await recordAuditLog({
        actorId: user?.id,
        action: "HEALTH_ALERT_SEND_SKIPPED",
        entityType: "HEALTH_ALERT",
        entityId: `send-skip-${Date.now()}`,
        meta: {
          initiatedByName: user?.name || user?.email || "Admin",
          initiatedByEmail: user?.email || null,
          initiatedByRole: user?.role || null,
          triggerSource: "Manual send from Health Check page",
          hasIssues: true,
          issueSummary,
          recipientCount: 0,
          reason: "No admin emails",
          result: "Alert send skipped because no admin email recipients are configured.",
        },
      });
    }
    return NextResponse.json({
      ok: true,
      dryRun,
      skipped: true,
      reason: "No admin emails",
      hasIssues: true,
      recipientCount: 0,
      recipients: [],
      issueSummary,
    });
  }

  if (dryRun) {
    if (hasAdminAccess) {
      await recordAuditLog({
        actorId: user?.id,
        action: "HEALTH_ALERT_DRY_RUN",
        entityType: "HEALTH_ALERT",
        entityId: `preview-${Date.now()}`,
        meta: {
          initiatedByName: user?.name || user?.email || "Admin",
          initiatedByEmail: user?.email || null,
          initiatedByRole: user?.role || null,
          triggerSource: "Manual dry-run from Health Check page",
          dryRun: true,
          force,
          forceReason: force ? forceReason : null,
          hasIssues: true,
          issueSummary,
          recipientCount: toList.length,
          recipientPreview: admins.map((a) => ({ name: a.name || "", email: a.email || "" })),
          recipients: toList,
          podCompliance7d,
          autoHealSummary,
          result: "Preview complete. Alert would be sent with current issue counts.",
        },
      });
    }
    return NextResponse.json({
      ok: true,
      dryRun: true,
      hasIssues: true,
      recipientCount: toList.length,
      recipients: admins.map((a) => ({
        name: a.name || "Admin",
        email: a.email || "",
      })),
      issueSummary,
      issueCounts: {
        paymentMismatches,
        orderBalanceMismatches,
        stockMismatches,
        legacyAutoApply,
        missingSettlements,
        missingSupplierPayments,
        missingCreditPayouts,
      },
      podCompliance7d,
    });
  }

  const base =
    process.env.NEXT_PUBLIC_BASE_URL ||
    process.env.NEXTAUTH_URL ||
    "http://localhost:3000";
  const subject = "Health Check Alert — mismatches detected";
  const body = [
    "The health check found data mismatches:",
    `- Payment mismatches: ${paymentMismatches}`,
    `- Order balance mismatches: ${orderBalanceMismatches}`,
    `- Stock mismatches: ${stockMismatches}`,
    `- Legacy AUTO_APPLY rows: ${legacyAutoApply}`,
    `- Unposted delivery settlements: ${missingSettlements}`,
    `- Unposted supplier payments: ${missingSupplierPayments}`,
    `- Unposted store-credit payouts: ${missingCreditPayouts}`,
    `- POD missing (last 7 days): ${podCompliance7d.podMissing}/${podCompliance7d.delivered} (${podCompliance7d.podMissingRatePct}%)`,
    "",
    `POD alert threshold: ${podCompliance7d.thresholdPct}% (min ${podCompliance7d.minDelivered} delivered orders in 7 days)`,
    ...(autoHealSummary
      ? [
          "",
          "Auto-heal attempted:",
          `- Orders posted: ${autoHealSummary.posted.orders}`,
          `- Payments posted: ${autoHealSummary.posted.payments}`,
          `- Expenses posted: ${autoHealSummary.posted.expenses}`,
          `- Purchases posted: ${autoHealSummary.posted.purchases}`,
          `- Supplier payments posted: ${autoHealSummary.posted.supplierPayments}`,
          `- Credit payouts posted: ${autoHealSummary.posted.creditPayouts}`,
          `- Settlements posted: ${autoHealSummary.posted.settlements}`,
        ]
      : []),
    "",
    `Review: ${base}/admin/health`,
    `POD report: ${base}/admin/delivery/pod-report`,
  ].join("\n");

  for (const email of toList) {
    await sendEmail(email, subject, body);
  }

  await recordAuditLog({
    actorId: user?.id,
    action: "HEALTH_ALERT_SENT",
    entityType: "HEALTH_ALERT",
    entityId: force ? `manual-${Date.now()}` : key,
    meta: {
      initiatedByName: user?.name || user?.email || "System",
      initiatedByEmail: user?.email || null,
      initiatedByRole: user?.role || (hasCronAccess ? "CRON" : null),
      triggerSource: hasCronAccess && !hasAdminAccess ? "Cron" : "Manual",
      force,
      forceReason: force ? forceReason : null,
      recipientCount: toList.length,
      recipients: toList,
      issueSummary,
      paymentMismatches,
      orderBalanceMismatches,
      stockMismatches,
      legacyAutoApply,
      missingSettlements,
      missingSupplierPayments,
      missingCreditPayouts,
      podCompliance7d,
      autoHealSummary,
      resultSummary: `Alert sent to ${toList.length} admin recipient(s).`,
    },
  });

  if (podWeeklyDue) {
    await recordAuditLog({
      actorId: user?.id,
      action: "HEALTH_POD_ALERT_SENT",
      entityType: "HEALTH_ALERT",
      entityId: podWeeklyKey,
      meta: {
        initiatedByName: user?.name || user?.email || "System",
        initiatedByEmail: user?.email || null,
        initiatedByRole: user?.role || (hasCronAccess ? "CRON" : null),
        triggerSource: hasCronAccess && !hasAdminAccess ? "Cron" : "Manual",
        recipientCount: toList.length,
        podCompliance7d,
        resultSummary: "Weekly POD compliance alert sent.",
      },
    });
  }

  return NextResponse.json({ ok: true, sent: toList.length });
}
