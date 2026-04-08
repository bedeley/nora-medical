import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";
import { findClosedPeriod } from "@/lib/accounting-periods";
import {
  postDeliverySettlementEntry,
  postExpenseEntry,
  postOrderEntry,
  postPaymentEntry,
  postPurchaseEntry,
  postStoreCreditPayoutEntry,
  postSupplierPaymentEntry,
} from "@/lib/accounting-posting";

type RetryEntityType =
  | "ORDER"
  | "PAYMENT"
  | "EXPENSE"
  | "PURCHASE"
  | "SUPPLIER_PAYMENT"
  | "CREDIT_PAYOUT"
  | "DELIVERY_SETTLEMENT";

type RetryTarget = { entityType: RetryEntityType; entityId: string; source?: string };

type RequestBody =
  | { action: "retryPost"; entityType: RetryEntityType; entityId: string; source?: string }
  | { action: "precheck"; targets: RetryTarget[] }
  | { action: "bulkRetry"; targets: RetryTarget[] }
  | { action: "acknowledgeWarnings"; asOf: string; warningKeys: string[]; note: string }
  | { action: "clearAcknowledgement"; asOf: string };

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

function canRunHighImpact(user?: AuthenticatedUser | null) {
  return user?.role === "ADMIN";
}

async function isPosted(entityType: RetryEntityType, entityId: string) {
  if (entityType === "DELIVERY_SETTLEMENT") {
    const row = await prisma.journalEntry.findFirst({
      where: { status: "POSTED", sourceType: "MANUAL", sourceId: entityId },
      select: { id: true },
    });
    return Boolean(row);
  }
  if (entityType === "SUPPLIER_PAYMENT") {
    const row = await prisma.journalEntry.findFirst({
      where: { status: "POSTED", sourceType: "PURCHASE", sourceId: { startsWith: entityId } },
      select: { id: true },
    });
    return Boolean(row);
  }
  if (entityType === "CREDIT_PAYOUT") {
    const row = await prisma.journalEntry.findFirst({
      where: { status: "POSTED", sourceType: "PAYMENT", sourceId: { startsWith: entityId } },
      select: { id: true },
    });
    return Boolean(row);
  }
  const sourceType =
    entityType === "ORDER"
      ? "ORDER"
      : entityType === "PAYMENT"
        ? "PAYMENT"
        : entityType === "EXPENSE"
          ? "EXPENSE"
          : "PURCHASE";
  const row = await prisma.journalEntry.findFirst({
    where: { status: "POSTED", sourceType, sourceId: { startsWith: entityId } },
    select: { id: true },
  });
  return Boolean(row);
}

async function lookupEntryDate(entityType: RetryEntityType, entityId: string) {
  if (entityType === "ORDER") {
    const row = await prisma.order.findUnique({ where: { id: entityId }, select: { createdAt: true } });
    return row?.createdAt || null;
  }
  if (entityType === "PAYMENT" || entityType === "CREDIT_PAYOUT") {
    const row = await prisma.payment.findUnique({
      where: { id: entityId },
      select: { createdAt: true, deletedAt: true },
    });
    if (!row || row.deletedAt) return null;
    return row.createdAt;
  }
  if (entityType === "EXPENSE") {
    const row = await prisma.expense.findUnique({
      where: { id: entityId },
      select: { createdAt: true, deletedAt: true },
    });
    if (!row || row.deletedAt) return null;
    return row.createdAt;
  }
  if (entityType === "PURCHASE") {
    const row = await prisma.purchase.findUnique({
      where: { id: entityId },
      select: { createdAt: true, deletedAt: true },
    });
    if (!row || row.deletedAt) return null;
    return row.createdAt;
  }
  if (entityType === "SUPPLIER_PAYMENT") {
    const row = await prisma.supplierPayment.findUnique({
      where: { id: entityId },
      select: { paidAt: true, createdAt: true, deletedAt: true },
    });
    if (!row || row.deletedAt) return null;
    return row.paidAt || row.createdAt;
  }
  const log = await prisma.auditLog.findFirst({
    where: {
      entityType: "DELIVERY_SETTLEMENT",
      entityId,
      action: "DELIVERY_COLLECTION_SETTLEMENT_CREATED",
    },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return log?.createdAt || null;
}

async function retryPost(entityType: RetryEntityType, entityId: string) {
  if (entityType === "ORDER") return postOrderEntry({ orderId: entityId });
  if (entityType === "PAYMENT") return postPaymentEntry({ paymentId: entityId });
  if (entityType === "EXPENSE") {
    const expense = await prisma.expense.findUnique({
      where: { id: entityId },
      select: { id: true, amount: true, createdAt: true, category: true, note: true, deletedAt: true },
    });
    if (!expense || expense.deletedAt) throw new Error("Expense not found.");
    return postExpenseEntry({
      expenseId: expense.id,
      amount: Number(expense.amount || 0),
      createdAt: expense.createdAt,
      category: expense.category,
      note: expense.note,
    });
  }
  if (entityType === "PURCHASE") {
    const purchase = await prisma.purchase.findUnique({
      where: { id: entityId },
      select: { id: true, unitCost: true, quantity: true, createdAt: true, status: true, deletedAt: true },
    });
    if (!purchase || purchase.deletedAt) throw new Error("Purchase not found.");
    if (purchase.status !== "RECEIVED") throw new Error("Purchase must be RECEIVED before posting.");
    return postPurchaseEntry({
      purchaseId: purchase.id,
      amount: Number(purchase.unitCost || 0) * Number(purchase.quantity || 0),
      createdAt: purchase.createdAt,
      memo: "Integrity post retry",
    });
  }
  if (entityType === "SUPPLIER_PAYMENT") return postSupplierPaymentEntry({ supplierPaymentId: entityId });
  if (entityType === "CREDIT_PAYOUT") return postStoreCreditPayoutEntry({ paymentId: entityId });
  const settlement = await prisma.auditLog.findFirst({
    where: {
      entityType: "DELIVERY_SETTLEMENT",
      entityId,
      action: "DELIVERY_COLLECTION_SETTLEMENT_CREATED",
    },
    orderBy: { createdAt: "desc" },
    select: { entityId: true, meta: true, createdAt: true },
  });
  if (!settlement) throw new Error("Settlement audit row not found.");
  let meta: {
    totalBalance?: number;
    settledAt?: string;
    receivedBy?: string;
    reference?: string;
    note?: string;
    destination?: "CASH" | "BANK";
  } | null = null;
  try {
    meta = JSON.parse(settlement.meta || "{}") as {
      totalBalance?: number;
      settledAt?: string;
      receivedBy?: string;
      reference?: string;
      note?: string;
      destination?: "CASH" | "BANK";
    };
  } catch {
    meta = null;
  }
  const amount = Number(meta?.totalBalance || 0);
  if (!(amount > 0)) throw new Error("Settlement amount must be greater than zero.");
  return postDeliverySettlementEntry({
    settlementId: settlement.entityId,
    amount,
    settledAt: new Date(String(meta?.settledAt || settlement.createdAt.toISOString())),
    receivedBy: String(meta?.receivedBy || "").trim() || null,
    reference: String(meta?.reference || "").trim() || null,
    note: String(meta?.note || "").trim() || null,
    destination: meta?.destination === "BANK" ? "BANK" : "CASH",
  });
}

async function precheckTarget(target: RetryTarget) {
  const entityId = String(target.entityId || "").trim();
  if (!entityId) {
    return {
      ok: false,
      entityType: target.entityType,
      entityId,
      source: target.source || "",
      reason: "missing_entity_id",
      periodClosed: false,
      posted: false,
    };
  }
  const posted = await isPosted(target.entityType, entityId);
  if (posted) {
    return {
      ok: false,
      entityType: target.entityType,
      entityId,
      source: target.source || "",
      reason: "already_posted",
      periodClosed: false,
      posted: true,
    };
  }
  const entryDate = await lookupEntryDate(target.entityType, entityId);
  if (!entryDate) {
    return {
      ok: false,
      entityType: target.entityType,
      entityId,
      source: target.source || "",
      reason: "source_missing_or_deleted",
      periodClosed: false,
      posted: false,
    };
  }
  const closedPeriod = await findClosedPeriod(entryDate);
  if (closedPeriod) {
    return {
      ok: false,
      entityType: target.entityType,
      entityId,
      source: target.source || "",
      reason: "period_closed",
      periodClosed: true,
      periodName: closedPeriod.name,
      posted: false,
    };
  }
  return {
    ok: true,
    entityType: target.entityType,
    entityId,
    source: target.source || "",
    reason: "",
    periodClosed: false,
    posted: false,
  };
}

type IntegrityAcknowledgement = {
  id: string;
  asOf: string;
  createdAt: string;
  actor: string;
  warningSignature: string;
  warningKeys: string[];
  note: string;
};

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !isAuthorized(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-accounting-integrity-actions", 60_000, 120);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }
  const body = (await req.json().catch(() => null)) as RequestBody | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (body.action === "acknowledgeWarnings") {
    const asOf = String(body.asOf || "").trim();
    const warningKeys = Array.isArray(body.warningKeys)
      ? body.warningKeys.map((row) => String(row || "").trim()).filter(Boolean)
      : [];
    const note = String(body.note || "").trim();
    if (!asOf || !warningKeys.length || !note) {
      return NextResponse.json({ error: "Missing acknowledgement fields." }, { status: 400 });
    }
    const existing = await prisma.appSetting.findUnique({
      where: { key: "accounting.integrity.acknowledgements" },
      select: { value: true },
    });
    const rows = (Array.isArray(existing?.value) ? existing.value : []) as IntegrityAcknowledgement[];
    const warningSignature = warningKeys.slice().sort().join("|");
    const actorLabel =
      String(user?.name || "").trim() ||
      String(user?.email || "").trim() ||
      String(user?.id || "").trim() ||
      "Unknown";
    const nextRow: IntegrityAcknowledgement = {
      id: `ack_${Date.now()}`,
      asOf,
      createdAt: new Date().toISOString(),
      actor: actorLabel,
      warningSignature,
      warningKeys,
      note,
    };
    const next = [nextRow, ...rows].slice(0, 100);
    await prisma.appSetting.upsert({
      where: { key: "accounting.integrity.acknowledgements" },
      update: { value: next },
      create: { key: "accounting.integrity.acknowledgements", value: next },
    });
    await recordAuditLog({
      actorId: user?.id || "",
      action: "ACCOUNTING_INTEGRITY_WARNINGS_ACKNOWLEDGED",
      entityType: "ACCOUNTING_INTEGRITY",
      entityId: asOf,
      meta: {
        sourcePage: "admin/accounting/integrity",
        warningCount: warningKeys.length,
        warningKeys,
        note,
      },
    });
    return NextResponse.json({ ok: true, row: nextRow });
  }

  if (body.action === "clearAcknowledgement") {
    const asOf = String(body.asOf || "").trim();
    const existing = await prisma.appSetting.findUnique({
      where: { key: "accounting.integrity.acknowledgements" },
      select: { value: true },
    });
    const rows = (Array.isArray(existing?.value) ? existing.value : []) as IntegrityAcknowledgement[];
    const next = asOf ? rows.filter((row) => row.asOf !== asOf) : [];
    await prisma.appSetting.upsert({
      where: { key: "accounting.integrity.acknowledgements" },
      update: { value: next },
      create: { key: "accounting.integrity.acknowledgements", value: next },
    });
    await recordAuditLog({
      actorId: user?.id || "",
      action: "ACCOUNTING_INTEGRITY_ACKNOWLEDGEMENT_CLEARED",
      entityType: "ACCOUNTING_INTEGRITY",
      entityId: asOf || "all",
      meta: {
        sourcePage: "admin/accounting/integrity",
        clearedAsOf: asOf || null,
        previousCount: rows.length,
        newCount: next.length,
      },
    });
    return NextResponse.json({ ok: true, cleared: rows.length - next.length });
  }

  if (body.action === "precheck") {
    const targets = Array.isArray(body.targets) ? body.targets : [];
    if (!targets.length) {
      return NextResponse.json({ error: "No targets provided." }, { status: 400 });
    }
    const rows = await Promise.all(targets.slice(0, 300).map((target) => precheckTarget(target)));
    const ready = rows.filter((row) => row.ok).length;
    const blocked = rows.length - ready;
    await recordAuditLog({
      actorId: user?.id || "",
      action: "ACCOUNTING_INTEGRITY_PRECHECK_RUN",
      entityType: "ACCOUNTING_INTEGRITY",
      entityId: `precheck:${new Date().toISOString()}`,
      meta: {
        sourcePage: "admin/accounting/integrity",
        total: rows.length,
        ready,
        blocked,
      },
    });
    return NextResponse.json({
      ok: true,
      summary: { total: rows.length, ready, blocked },
      rows,
    });
  }

  if (body.action === "bulkRetry") {
    if (!canRunHighImpact(user)) {
      return NextResponse.json({ error: "Only ADMIN can run bulk retry." }, { status: 403 });
    }
    const targets = Array.isArray(body.targets) ? body.targets : [];
    if (!targets.length) {
      return NextResponse.json({ error: "No targets provided." }, { status: 400 });
    }
    const results: Array<{
      entityType: RetryEntityType;
      entityId: string;
      source?: string;
      posted: boolean;
      skipped: boolean;
      reason?: string;
      journalEntryId?: string | null;
    }> = [];
    for (const target of targets.slice(0, 300)) {
      const check = await precheckTarget(target);
      if (!check.ok) {
        results.push({
          entityType: target.entityType,
          entityId: target.entityId,
          source: target.source,
          posted: false,
          skipped: true,
          reason: check.reason,
          journalEntryId: null,
        });
        continue;
      }
      try {
        const entry = await retryPost(target.entityType, target.entityId);
        const posted = Boolean(entry) || (await isPosted(target.entityType, target.entityId));
        results.push({
          entityType: target.entityType,
          entityId: target.entityId,
          source: target.source,
          posted,
          skipped: !posted,
          reason: posted ? undefined : "no_entry_created",
          journalEntryId: entry?.id || null,
        });
      } catch (error) {
        results.push({
          entityType: target.entityType,
          entityId: target.entityId,
          source: target.source,
          posted: false,
          skipped: true,
          reason: error instanceof Error ? error.message : "retry_failed",
          journalEntryId: null,
        });
      }
    }
    const posted = results.filter((row) => row.posted).length;
    const skipped = results.filter((row) => row.skipped).length;
    await recordAuditLog({
      actorId: user?.id || "",
      action: "ACCOUNTING_INTEGRITY_BULK_RETRY_RUN",
      entityType: "ACCOUNTING_INTEGRITY",
      entityId: `bulk_retry:${new Date().toISOString()}`,
      meta: {
        sourcePage: "admin/accounting/integrity",
        total: results.length,
        posted,
        skipped,
        reasonBreakdown: results.reduce<Record<string, number>>((acc, row) => {
          const key = String(row.reason || "");
          if (!key) return acc;
          acc[key] = Number(acc[key] || 0) + 1;
          return acc;
        }, {}),
      },
    });
    return NextResponse.json({
      ok: true,
      summary: { total: results.length, posted, skipped },
      rows: results,
    });
  }

  if (body.action === "retryPost") {
    const entityType = body.entityType;
    const entityId = String(body.entityId || "").trim();
    if (!entityType || !entityId) {
      return NextResponse.json({ error: "Missing entity type or id." }, { status: 400 });
    }
    const check = await precheckTarget({ entityType, entityId, source: body.source || "" });
    if (!check.ok) {
      return NextResponse.json({ error: check.reason, precheck: check }, { status: 400 });
    }
    try {
      const entry = await retryPost(entityType, entityId);
      const posted = Boolean(entry) || (await isPosted(entityType, entityId));
      await recordAuditLog({
        actorId: user?.id || "",
        action: "ACCOUNTING_INTEGRITY_RETRY_POST_RUN",
        entityType,
        entityId,
        meta: {
          sourcePage: "admin/accounting/integrity",
          source: body.source || "",
          posted,
          journalEntryId: entry?.id || null,
        },
      });
      return NextResponse.json({ ok: true, posted, journalEntryId: entry?.id || null });
    } catch (error) {
      const message = error instanceof Error ? error.message : "retry_failed";
      await recordAuditLog({
        actorId: user?.id || "",
        action: "ACCOUNTING_INTEGRITY_RETRY_POST_FAILED",
        entityType,
        entityId,
        meta: {
          sourcePage: "admin/accounting/integrity",
          source: body.source || "",
          reason: message,
        },
      });
      return NextResponse.json({ error: message }, { status: 400 });
    }
  }

  return NextResponse.json({ error: "Unsupported action." }, { status: 400 });
}
