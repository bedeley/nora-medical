import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { PDFDocument, StandardFonts, rgb, type PDFPage } from "pdf-lib";
import { evaluateAuditRisk, matchesRiskMode, type AuditRiskMode } from "@/lib/audit-risk";
import type { AuditRiskSettings } from "@/lib/audit-risk-config";
import { getEffectiveAuditRiskSettings } from "@/lib/audit-risk-settings.server";
import { canAccessAdminAudit } from "@/lib/admin-audit-access";

export const runtime = "nodejs";

function toCurrency(value: unknown) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return String(value ?? "-");
  return amount.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function toFriendlyLabel(key: string) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

function flattenMeta(value: unknown, prefix = "", out: Array<[string, string]> = []) {
  if (!value || typeof value !== "object") return out;
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, raw] of entries) {
    const label = prefix ? `${prefix} ${toFriendlyLabel(key)}` : toFriendlyLabel(key);
    if (raw === null || raw === undefined) {
      out.push([label, "-"]);
      continue;
    }
    if (Array.isArray(raw)) {
      const rendered = raw
        .map((item) => (typeof item === "object" ? JSON.stringify(item) : String(item)))
        .join(", ");
      out.push([label, rendered || "-"]);
      continue;
    }
    if (typeof raw === "object") {
      flattenMeta(raw, label, out);
      continue;
    }
    out.push([label, String(raw)]);
  }
  return out;
}

function summarizeMeta(action: string, entityType: string, meta: Record<string, unknown> | null) {
  if (!meta) return "No additional details.";

  if (entityType === "PRODUCT" && action === "PRODUCT_CREATE") {
    const name = String(meta.name || "Unknown product");
    const sku = String(meta.sku || "-");
    const category = String(meta.category || "-");
    const brand = String(meta.brand || "-");
    const supplier = String(meta.supplier || "-");
    const price = toCurrency(meta.price);
    const cost = toCurrency(meta.cost);
    const stock = Number(meta.stock ?? meta.stockAfter ?? 0);
    return `Created product "${name}" (SKU: ${sku}) in ${category}. Brand: ${brand}. Supplier: ${supplier}. Price: ${price}. Cost: ${cost}. Opening stock: ${Number.isFinite(stock) ? stock : 0}.`;
  }

  if (entityType === "PRODUCT" && action === "PRODUCT_STOCK_UPDATE") {
    const name = String(meta.name || "Unknown product");
    const from = Number(meta.from);
    const to = Number(meta.to);
    const delta = Number(meta.delta);
    const reason = String(meta.reason || "Not specified");
    const unitCost = meta.unitCost !== undefined ? toCurrency(meta.unitCost) : "-";
    const newCost = meta.newCost !== undefined ? toCurrency(meta.newCost) : "-";
    const supplier = String(meta.supplier || "-");
    const deltaLabel = Number.isFinite(delta) ? (delta > 0 ? `+${delta}` : `${delta}`) : "0";
    return `Updated stock for "${name}": ${Number.isFinite(from) ? from : "-"} -> ${Number.isFinite(to) ? to : "-"} (${deltaLabel}). Reason: ${reason}. Supplier: ${supplier}. Unit cost: ${unitCost}. New cost: ${newCost}.`;
  }

  if (entityType === "PRODUCT" && action === "PRODUCT_DELETE") {
    const name = String(meta.name || "Unknown product");
    const price = meta.price !== undefined ? toCurrency(meta.price) : "-";
    const stock = Number(meta.stock);
    return `Deleted product "${name}". Last price: ${price}. Stock at deletion: ${Number.isFinite(stock) ? stock : "-"}.`;
  }

  const flattened = flattenMeta(meta).slice(0, 12);
  if (!flattened.length) return "No additional details.";
  return flattened.map(([k, v]) => `${k}: ${v}`).join(". ");
}

function csvEscape(value: unknown) {
  const text = String(value ?? "");
  if (text.includes(",") || text.includes('"') || text.includes("\n")) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function truncateText(value: string, max = 190) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}...`;
}

function buildSourcePageMetaFilter(sourcePage: string): Prisma.AuditLogWhereInput {
  const normalized = sourcePage.trim().replace(/^\/+/, "");
  if (!normalized) return {};
  const withLeadingSlash = `/${normalized}`;
  return {
    OR: [
      { meta: { contains: `"sourcePage":"${normalized}"` } },
      { meta: { contains: `"sourcePage":"${withLeadingSlash}"` } },
      { meta: { contains: `"page":"${normalized}"` } },
      { meta: { contains: `"page":"${withLeadingSlash}"` } },
    ],
  };
}

function resolveAuditSourceLink(entityType: string, entityId: string) {
  const type = String(entityType || "").toUpperCase();
  const id = String(entityId || "").trim();
  if (!id) return null;
  switch (type) {
    case "ORDER":
      return `/admin/orders/${id}`;
    case "PAYMENT":
      return `/admin/orders?paymentId=${encodeURIComponent(id)}`;
    case "PURCHASE":
      return `/admin/purchases?purchaseId=${encodeURIComponent(id)}`;
    case "EXPENSE":
      return `/admin/expenses/${id}`;
    case "PAYROLL_RUN":
      return `/admin/hr/payroll/${id}`;
    case "PAYROLLRUNREPORT":
      return `/admin/hr/payroll/${id}`;
    case "PAYSLIP":
      return `/admin/hr/paystubs/${id}`;
    case "SUPPLIER_PAYMENT":
      return `/admin/supplier-payments`;
    case "PRODUCT":
      return `/admin/products?q=${encodeURIComponent(id)}`;
    case "PRODUCT_IMAGE":
      return `/admin/products`;
    case "SUPPLIER":
      return `/admin/suppliers?focus=${encodeURIComponent(id)}`;
    case "JOURNALENTRY":
      return `/admin/accounting/journal?entryId=${encodeURIComponent(id)}`;
    case "INVENTORY_LOT":
      return `/admin/inventory-lots?focus=${encodeURIComponent(id)}`;
    case "REPORT":
      return `/admin/audit?entityType=REPORT&entityId=${encodeURIComponent(id)}`;
    case "APPSETTING":
      return id === "audit.risk.settings" ? "/admin/audit/settings" : "/admin/settings/features";
    default:
      return null;
  }
}

type AuditQueueMode =
  | "all"
  | "critical_unreviewed"
  | "archive_soon_unreviewed"
  | "needs_assignment"
  | "overdue_tasks"
  | "overdue_reviews_critical"
  | "overdue_reviews_high"
  | "overdue_reviews_medium";

function normalizeQueueMode(value: string | null): AuditQueueMode {
  const mode = String(value || "all").toLowerCase();
  if (
    mode === "critical_unreviewed" ||
    mode === "archive_soon_unreviewed" ||
    mode === "needs_assignment" ||
    mode === "overdue_tasks" ||
    mode === "overdue_reviews_critical" ||
    mode === "overdue_reviews_high" ||
    mode === "overdue_reviews_medium"
  ) {
    return mode;
  }
  return "all";
}

function filterByQueueMode(logs: RawAuditLog[], queueMode: AuditQueueMode, settings: AuditRiskSettings) {
  if (queueMode === "all") return logs;
  const nowMs = Date.now();
  return logs.filter((row) => {
    const meta = parseMeta(row.meta) || {};
    const risk = evaluateAuditRisk({
      action: row.action,
      entityType: row.entityType,
      meta,
      settings,
    });
    if (risk.severity === "LOW") return false;
    const reviewed = Boolean(risk.reviewed);
    const createdAtMs = row.createdAt.getTime();
    const archiveAtMs = createdAtMs + RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const remainingMs = archiveAtMs - nowMs;
    const taskAssigneeId = String(meta.reviewTaskAssigneeId || "").trim();
    const taskDueAtRaw = String(meta.reviewTaskDueAt || "").trim();
    const taskDueAtMs =
      taskDueAtRaw && !Number.isNaN(new Date(taskDueAtRaw).getTime())
        ? new Date(taskDueAtRaw).getTime()
        : null;

    if (queueMode === "critical_unreviewed") {
      return risk.severity === "CRITICAL" && !reviewed;
    }
    if (queueMode === "archive_soon_unreviewed") {
      return !reviewed && remainingMs > 0 && remainingMs <= settings.archiveWindowDays.reminder * 24 * 60 * 60 * 1000;
    }
    if (queueMode === "needs_assignment") {
      return (
        !reviewed &&
        remainingMs > 0 &&
        remainingMs <= settings.archiveWindowDays.escalation * 24 * 60 * 60 * 1000 &&
        !taskAssigneeId
      );
    }
    if (queueMode === "overdue_tasks") {
      return !reviewed && Boolean(taskDueAtMs && taskDueAtMs < nowMs);
    }
    if (
      queueMode === "overdue_reviews_critical" ||
      queueMode === "overdue_reviews_high" ||
      queueMode === "overdue_reviews_medium"
    ) {
      const slaHours =
        risk.severity === "CRITICAL"
          ? settings.reviewSlaHours.critical
          : risk.severity === "HIGH"
            ? settings.reviewSlaHours.high
            : settings.reviewSlaHours.medium;
      const isOverdue = nowMs > createdAtMs + slaHours * 60 * 60 * 1000;
      if (!isOverdue || reviewed) return false;
      if (queueMode === "overdue_reviews_critical") return risk.severity === "CRITICAL";
      if (queueMode === "overdue_reviews_high") return risk.severity === "HIGH";
      return risk.severity === "MEDIUM";
    }
    return true;
  });
}

function wrapByWords(text: string, maxChars: number) {
  const source = text.replace(/\s+/g, " ").trim();
  if (!source) return [""];
  const words = source.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    if (`${current} ${word}`.length <= maxChars) {
      current = `${current} ${word}`;
      continue;
    }
    lines.push(current);
    current = word;
  }
  if (current) lines.push(current);
  return lines;
}

type RawAuditLog = {
  id: string;
  actor: { id: string; email: string | null; name: string | null; role: string } | null;
  action: string;
  entityType: string;
  entityId: string;
  meta: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  outcome?: string | null;
  createdAt: Date;
};

type AuditRiskSummary = {
  needsReview: number;
  critical: number;
  reviewedToday: number;
  overdueCritical: number;
  overdueHigh: number;
  overdueMedium: number;
  archiveReminder: number;
  archiveEscalation: number;
  archiveNeedsAssignment: number;
  eligibleForArchiveUnreviewed: number;
  openTasks: number;
  inProgressTasks: number;
  overdueTasks: number;
};

function parsePositiveInt(value: string | undefined, fallback: number) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

const RETENTION_DAYS = parsePositiveInt(process.env.AUDIT_LOG_RETENTION_DAYS, 365);

function parseMeta(raw: string | null) {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function filterByRiskMode(logs: RawAuditLog[], riskMode: AuditRiskMode, settings: AuditRiskSettings) {
  if (riskMode === "all") return logs;
  return logs.filter((row) =>
    matchesRiskMode(
      evaluateAuditRisk({
        action: row.action,
        entityType: row.entityType,
        meta: parseMeta(row.meta),
        settings,
      }),
      riskMode,
    ),
  );
}

function summarizeRisk(logs: RawAuditLog[], settings: AuditRiskSettings): AuditRiskSummary {
  const now = new Date();
  let needsReview = 0;
  let critical = 0;
  let reviewedToday = 0;
  let overdueCritical = 0;
  let overdueHigh = 0;
  let overdueMedium = 0;
  let archiveReminder = 0;
  let archiveEscalation = 0;
  let archiveNeedsAssignment = 0;
  let eligibleForArchiveUnreviewed = 0;
  let openTasks = 0;
  let inProgressTasks = 0;
  let overdueTasks = 0;
  logs.forEach((row) => {
    const meta = parseMeta(row.meta) || {};
    const risk = evaluateAuditRisk({
      action: row.action,
      entityType: row.entityType,
      meta,
      settings,
    });
    if (risk.severity === "LOW") return;
    const taskStatus = String(meta.reviewTaskStatus || "").toUpperCase();
    const taskAssigneeId = String(meta.reviewTaskAssigneeId || "").trim();
    const taskDueAtRaw = String(meta.reviewTaskDueAt || "").trim();
    const taskDueAt = taskDueAtRaw && !Number.isNaN(new Date(taskDueAtRaw).getTime())
      ? new Date(taskDueAtRaw)
      : null;
    if (!risk.reviewed) {
      if (taskStatus === "IN_PROGRESS") inProgressTasks += 1;
      else openTasks += 1;
      if (taskDueAt && taskDueAt.getTime() < now.getTime()) overdueTasks += 1;
    }
    if (!risk.reviewed) needsReview += 1;
    if (risk.severity === "CRITICAL") critical += 1;
    if (risk.reviewedAt) {
      const reviewedAt = new Date(risk.reviewedAt);
      if (
        reviewedAt.getFullYear() === now.getFullYear() &&
        reviewedAt.getMonth() === now.getMonth() &&
        reviewedAt.getDate() === now.getDate()
      ) {
        reviewedToday += 1;
      }
    }
    if (!risk.reviewed) {
      const createdAtMs = row.createdAt.getTime();
      const nowMs = now.getTime();
      const slaHours =
        risk.severity === "CRITICAL"
          ? settings.reviewSlaHours.critical
          : risk.severity === "HIGH"
            ? settings.reviewSlaHours.high
            : settings.reviewSlaHours.medium;
      const dueAtMs = createdAtMs + slaHours * 60 * 60 * 1000;
      if (nowMs > dueAtMs) {
        if (risk.severity === "CRITICAL") overdueCritical += 1;
        else if (risk.severity === "HIGH") overdueHigh += 1;
        else if (risk.severity === "MEDIUM") overdueMedium += 1;
      }

      const archiveAtMs = createdAtMs + RETENTION_DAYS * 24 * 60 * 60 * 1000;
      const remainingMs = archiveAtMs - nowMs;
      if (remainingMs <= 0) {
        eligibleForArchiveUnreviewed += 1;
      } else {
        const remainingDays = remainingMs / (24 * 60 * 60 * 1000);
        if (remainingDays <= settings.archiveWindowDays.escalation) {
          if (taskAssigneeId) archiveEscalation += 1;
          else archiveNeedsAssignment += 1;
        }
        else if (remainingDays <= settings.archiveWindowDays.reminder) archiveReminder += 1;
      }
    }
  });
  return {
    needsReview,
    critical,
    reviewedToday,
    overdueCritical,
    overdueHigh,
    overdueMedium,
    archiveReminder,
    archiveEscalation,
    archiveNeedsAssignment,
    eligibleForArchiveUnreviewed,
    openTasks,
    inProgressTasks,
    overdueTasks,
  };
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !canAccessAdminAudit(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const entityType = searchParams.get("entityType") || undefined;
  const entityId = searchParams.get("entityId") || undefined;
  const employeeId = searchParams.get("employeeId") || undefined;
  const payrollRunId = searchParams.get("payrollRunId") || undefined;
  const logId = searchParams.get("logId") || undefined;
  const customerId = searchParams.get("customerId") || undefined;
  const customerQuery = (searchParams.get("customerQuery") || "").trim();
  const action = searchParams.get("action") || undefined;
  const outcomeParam = (searchParams.get("outcome") || "").toUpperCase();
  const outcome =
    outcomeParam === "SUCCESS" || outcomeParam === "FAILED" || outcomeParam === "PARTIAL"
      ? outcomeParam
      : undefined;
  const correlationId = (searchParams.get("correlationId") || "").trim();
  const actorId = searchParams.get("actorId") || undefined;
  const actorType = (searchParams.get("actorType") || "").toUpperCase();
  const scope = (searchParams.get("scope") || "").toLowerCase();
  const settingSection = (searchParams.get("settingSection") || "").trim();
  const sourcePage = (searchParams.get("sourcePage") || "").trim();
  const metaStatus = searchParams.get("metaStatus") || undefined;
  const riskMode = (searchParams.get("riskMode") || "all").toLowerCase() as AuditRiskMode;
  const queueMode = normalizeQueueMode(searchParams.get("queueMode"));
  const normalizedRiskMode: AuditRiskMode = ["all", "exceptions", "critical", "needs_review"].includes(riskMode)
    ? riskMode
    : "all";
  const limit = Math.max(1, Math.min(5000, Number(searchParams.get("limit") || 100)));
  const page = Math.max(1, Number(searchParams.get("page") || 1));
  const pageSize = Math.max(1, Math.min(200, Number(searchParams.get("pageSize") || limit || 50)));
  const paginate =
    searchParams.get("paginate") === "1" ||
    searchParams.has("page") ||
    searchParams.has("pageSize");
  const start = searchParams.get("start") || undefined;
  const end = searchParams.get("end") || undefined;
  const format = searchParams.get("format") || "";
  const includeSummary = searchParams.get("includeSummary") === "1";
  const { settings: riskSettings, mode: settingsMode, editable: settingsEditable } = await getEffectiveAuditRiskSettings();

  const andWhere: Prisma.AuditLogWhereInput[] = [];
  if (entityType) {
    andWhere.push({
      entityType: { equals: entityType, mode: "insensitive" },
    });
  }
  if (payrollRunId) {
    andWhere.push({
      OR: [
        {
          entityType: { equals: "PAYROLL_RUN", mode: "insensitive" },
          entityId: payrollRunId,
        },
        {
          entityType: { equals: "PayrollRunReport", mode: "insensitive" },
          entityId: payrollRunId,
        },
        { meta: { contains: `"payrollRunId":"${payrollRunId}"` } },
        { meta: { contains: `"adjustmentForId":"${payrollRunId}"` } },
      ],
    });
  }
  if (logId) andWhere.push({ id: logId });
  if (entityId) andWhere.push({ entityId });
  if (employeeId) {
    andWhere.push({
      OR: [
        {
          entityType: { equals: "EMPLOYEE", mode: "insensitive" },
          entityId: employeeId,
        },
        { meta: { contains: `"employeeId":"${employeeId}"` } },
      ],
    });
  }
  if (action) andWhere.push({ action });
  if (outcome) andWhere.push({ outcome: outcome as "SUCCESS" | "FAILED" | "PARTIAL" });
  if (correlationId) {
    andWhere.push({ meta: { contains: `"correlationId":"${correlationId}"` } });
  }
  if (actorId === "system") {
    andWhere.push({ actorId: null });
  } else if (actorId) {
    andWhere.push({ actorId });
  }
  if (metaStatus) {
    const token = `"status":"${metaStatus}"`;
    andWhere.push({ meta: { contains: token } });
  }
  if (start || end) {
    const createdAt: { gte?: Date; lte?: Date } = {};
    if (start) {
      const s = new Date(start);
      if (!Number.isNaN(s.getTime())) createdAt.gte = s;
    }
    if (end) {
      const e = new Date(end);
      if (!Number.isNaN(e.getTime())) {
        e.setHours(23, 59, 59, 999);
        createdAt.lte = e;
      }
    }
    andWhere.push({ createdAt });
  }
  if (actorType) {
    if (actorType === "SYSTEM") {
      andWhere.push({
        OR: [{ actorId: null }, { meta: { contains: `"actorType":"SYSTEM"` } }],
      });
    } else if (["CUSTOMER", "ADMIN", "STAFF", "ACCOUNTANT"].includes(actorType)) {
      andWhere.push({
        OR: [{ actor: { role: actorType as "CUSTOMER" | "ADMIN" | "STAFF" | "ACCOUNTANT" } }, { meta: { contains: `"actorType":"${actorType}"` } }],
      });
    }
  }
  if (scope === "accounting_periods") {
    andWhere.push({
      OR: [{ action: { startsWith: "fiscal-period." } }, { action: { startsWith: "fiscal-month." } }],
    });
  }
  if (scope === "accounting_settings") {
    andWhere.push({ action: "app-setting.update" });
    if (sourcePage) {
      andWhere.push(buildSourcePageMetaFilter(sourcePage));
    } else {
      andWhere.push({
        OR: [
          { meta: { contains: `"sourcePage":"admin/accounting/settings"` } },
          { meta: { contains: `"sourcePage":"admin/accounting/periods"` } },
          { meta: { contains: `"sourcePage":"admin/accounting/reports/pl"` } },
        ],
      });
    }
    if (settingSection) {
      andWhere.push({ meta: { contains: `"section":"${settingSection}"` } });
    }
  }
  if (sourcePage && scope !== "accounting_settings") {
    andWhere.push(buildSourcePageMetaFilter(sourcePage));
  }
  const where: Prisma.AuditLogWhereInput = andWhere.length > 0 ? { AND: andWhere } : {};
  const appendAnd = (clause: Prisma.AuditLogWhereInput) => {
    if (Array.isArray(where.AND)) {
      where.AND.push(clause);
      return;
    }
    const existingWhere = { ...where };
    Object.keys(where).forEach((key) => {
      delete (where as Record<string, unknown>)[key];
    });
    where.AND = [existingWhere, clause];
  };
  if (customerId) {
    const token = `"customerId":"${customerId}"`;
    const [orders, payments] = await Promise.all([
      prisma.order.findMany({
        where: { userId: customerId },
        select: { id: true },
      }),
      prisma.payment.findMany({
        where: { userId: customerId },
        select: { id: true },
      }),
    ]);
    const orderIds = orders.map((o) => o.id);
    const paymentIds = payments.map((p) => p.id);
    const or: Prisma.AuditLogWhereInput[] = [
      { entityType: "USER", entityId: customerId },
      { entityType: "CUSTOMER", entityId: customerId },
      { meta: { contains: token } },
    ];
    if (orderIds.length > 0) {
      or.push({ entityType: "ORDER", entityId: { in: orderIds } });
    }
    if (paymentIds.length > 0) {
      or.push({ entityType: "PAYMENT", entityId: { in: paymentIds } });
    }
    appendAnd({ OR: or });
  } else if (customerQuery.length >= 2) {
    const likeDigits = customerQuery.replace(/\D/g, "");
    const customers = await prisma.user.findMany({
      where: {
        role: "CUSTOMER",
        OR: [
          { name: { contains: customerQuery, mode: "insensitive" } },
          { email: { contains: customerQuery, mode: "insensitive" } },
          ...(likeDigits ? [{ phone: { contains: likeDigits } }] : []),
        ],
      },
      select: { id: true },
      take: 50,
    });
    const customerIds = customers.map((c) => c.id);
    const customerMetaQueryOr: Prisma.AuditLogWhereInput[] = [
      { meta: { contains: `"customerName":"${customerQuery}`, mode: "insensitive" } },
      { meta: { contains: `"customerEmail":"${customerQuery}`, mode: "insensitive" } },
      ...(likeDigits ? [{ meta: { contains: likeDigits } }] : []),
    ];
    if (customerIds.length === 0) {
      appendAnd({ OR: customerMetaQueryOr });
    } else {
      const [orders, payments] = await Promise.all([
        prisma.order.findMany({
          where: { userId: { in: customerIds } },
          select: { id: true },
          take: 300,
        }),
        prisma.payment.findMany({
          where: { userId: { in: customerIds } },
          select: { id: true },
          take: 300,
        }),
      ]);
      const orderIds = orders.map((o) => o.id);
      const paymentIds = payments.map((p) => p.id);
      const or: Prisma.AuditLogWhereInput[] = [
        { actorId: { in: customerIds } },
        { entityType: "USER", entityId: { in: customerIds } },
        { entityType: "CUSTOMER", entityId: { in: customerIds } },
        ...customerMetaQueryOr,
      ];
      if (orderIds.length > 0) {
        or.push({ entityType: "ORDER", entityId: { in: orderIds } });
      }
      if (paymentIds.length > 0) {
        or.push({ entityType: "PAYMENT", entityId: { in: paymentIds } });
      }
      appendAnd({ OR: or });
    }
  }

  const toRows = (
    logs: RawAuditLog[],
  ) =>
    logs.map((l) => ({
      id: l.id,
      actor: l.actor,
      action: l.action,
      entityType: l.entityType,
      entityId: l.entityId,
      meta: parseMeta(l.meta),
      ipAddress: l.ipAddress ?? null,
      userAgent: l.userAgent ?? null,
      requestId: l.requestId ?? null,
      outcome: l.outcome ?? null,
      createdAt: l.createdAt.toISOString(),
    }));

  if (format.toLowerCase() === "csv") {
    const csvLimit = Math.max(limit, 1000);
    const rawLogs = await prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: csvLimit,
      include: {
        actor: { select: { id: true, email: true, name: true, role: true } },
      },
    });
    const logs = filterByQueueMode(
      filterByRiskMode(rawLogs, normalizedRiskMode, riskSettings),
      queueMode,
      riskSettings,
    );
    const rows = toRows(logs);
    const header = ["When", "Actor", "Action", "Entity Type", "Entity ID", "Severity", "Review status", "Details", "Source link"];
    const lines = [header.join(",")];
    for (const row of rows) {
      const actor =
        row.actor?.email ||
        row.actor?.name ||
        row.actor?.id ||
        "System";
      const details = summarizeMeta(row.action, row.entityType, row.meta);
      const sourceLink = resolveAuditSourceLink(row.entityType, row.entityId) || "";
      const risk = evaluateAuditRisk({
        action: row.action,
        entityType: row.entityType,
        meta: row.meta,
        settings: riskSettings,
      });
      const reviewStatus = risk.reviewed
        ? `Reviewed${risk.reviewedByName ? ` by ${risk.reviewedByName}` : ""}${risk.reviewedAt ? ` on ${new Date(risk.reviewedAt).toLocaleString()}` : ""}`
        : "Not reviewed";
      lines.push([
        csvEscape(new Date(row.createdAt).toLocaleString()),
        csvEscape(actor),
        csvEscape(row.action),
        csvEscape(row.entityType),
        csvEscape(row.entityId),
        csvEscape(risk.severity),
        csvEscape(reviewStatus),
        csvEscape(details),
        csvEscape(sourceLink),
      ].join(","));
    }
    const csv = lines.join("\n");
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename=audit_${Date.now()}.csv`,
      },
    });
  }

  if (format.toLowerCase() === "pdf") {
    try {
      const pdfLimit = Math.max(limit, 1000);
      const rawLogs = await prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: pdfLimit,
        include: {
          actor: { select: { id: true, email: true, name: true, role: true } },
        },
      });
      const logs = filterByQueueMode(
        filterByRiskMode(rawLogs, normalizedRiskMode, riskSettings),
        queueMode,
        riskSettings,
      );
      const rows = toRows(logs);
      const pdf = await PDFDocument.create();
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
      const pageSize: [number, number] = [841.89, 595.28];
      const margin = 36;
      const bodyWidth = pageSize[0] - margin * 2;
      const textColor = rgb(0.1, 0.1, 0.1);
      const muted = rgb(0.35, 0.35, 0.35);
      let page: PDFPage = pdf.addPage(pageSize);
      let y = pageSize[1] - margin;

      const drawHeader = () => {
        page.drawText("Audit Log Export (Plain Language)", {
          x: margin,
          y,
          size: 14,
          font: fontBold,
          color: textColor,
        });
        y -= 18;
        page.drawText(`Generated: ${new Date().toLocaleString()}`, {
          x: margin,
          y,
          size: 9,
          font,
          color: muted,
        });
        y -= 12;
        page.drawText(`Filters applied: ${truncateText(searchParams.toString() || "None", 180)}`, {
          x: margin,
          y,
          size: 9,
          font,
          color: muted,
        });
        y -= 12;
        page.drawText(`Rows exported: ${rows.length}`, {
          x: margin,
          y,
          size: 9,
          font,
          color: muted,
        });
        y -= 12;
        page.drawLine({
          start: { x: margin, y },
          end: { x: margin + bodyWidth, y },
          thickness: 0.7,
          color: rgb(0.78, 0.78, 0.78),
        });
        y -= 12;
      };

      const ensureSpace = (requiredHeight: number) => {
        if (y - requiredHeight > margin) return;
        page = pdf.addPage(pageSize);
        y = pageSize[1] - margin;
        drawHeader();
      };

      drawHeader();

      rows.forEach((row, index) => {
        const actor =
          row.actor?.name ||
          row.actor?.email ||
          row.actor?.id ||
          "System";
        const details = summarizeMeta(row.action, row.entityType, row.meta);
        const sourceLink = resolveAuditSourceLink(row.entityType, row.entityId);
        const risk = evaluateAuditRisk({
          action: row.action,
          entityType: row.entityType,
          meta: row.meta,
          settings: riskSettings,
        });
        const heading = `${index + 1}. ${new Date(row.createdAt).toLocaleString()} | ${row.action}`;
        const line1 = `Actor: ${truncateText(actor, 100)}`;
        const line2 = `Entity: ${row.entityType} (${row.entityId})`;
        const line3 = `Severity: ${risk.severity} | Review: ${
          risk.reviewed
            ? `Reviewed${risk.reviewedByName ? ` by ${risk.reviewedByName}` : ""}`
            : "Not reviewed"
        }`;
        const detailLines = wrapByWords(`Details: ${details}`, 150).slice(0, 4);
        const sourceLines = sourceLink
          ? wrapByWords(`Source link: ${sourceLink}`, 150).slice(0, 2)
          : ["Source link: No linked page"];
        const needed = 14 + 10 + 10 + 10 + detailLines.length * 10 + sourceLines.length * 10 + 10;

        ensureSpace(needed);

        page.drawText(heading, { x: margin, y, size: 10, font: fontBold, color: textColor });
        y -= 12;
        page.drawText(line1, { x: margin, y, size: 9, font, color: textColor });
        y -= 10;
        page.drawText(line2, { x: margin, y, size: 9, font, color: textColor });
        y -= 10;
        page.drawText(line3, { x: margin, y, size: 9, font, color: textColor });
        y -= 10;
        detailLines.forEach((line) => {
          page.drawText(line, { x: margin, y, size: 9, font, color: textColor });
          y -= 10;
        });
        sourceLines.forEach((line) => {
          page.drawText(line, { x: margin, y, size: 9, font, color: muted });
          y -= 10;
        });
        page.drawLine({
          start: { x: margin, y: y + 2 },
          end: { x: margin + bodyWidth, y: y + 2 },
          thickness: 0.4,
          color: rgb(0.9, 0.9, 0.9),
        });
        y -= 8;
      });

      const bytes = await pdf.save();
      return new Response(Uint8Array.from(bytes), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename=audit_${Date.now()}.pdf`,
        },
      });
    } catch (error) {
      return NextResponse.json(
        {
          error: error instanceof Error ? error.message : "Failed to generate audit PDF.",
        },
        { status: 500 },
      );
    }
  }

  if (paginate) {
    const buildSummary = async () => {
      if (!includeSummary) return null;
      const allForSummary = await prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          action: true,
          entityType: true,
          entityId: true,
          meta: true,
          createdAt: true,
          actor: { select: { id: true, email: true, name: true, role: true } },
        },
      });
      return summarizeRisk(
        filterByQueueMode(
          filterByRiskMode(allForSummary, normalizedRiskMode, riskSettings),
          queueMode,
          riskSettings,
        ),
        riskSettings,
      );
    };

    if (normalizedRiskMode !== "all" || queueMode !== "all") {
      const fetchCount = Math.max(1000, pageSize * 30);
      const [rawLogs, summary] = await Promise.all([
        prisma.auditLog.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: fetchCount,
          include: {
            actor: { select: { id: true, email: true, name: true, role: true } },
          },
        }),
        buildSummary(),
      ]);
      const filtered = filterByQueueMode(
        filterByRiskMode(rawLogs, normalizedRiskMode, riskSettings),
        queueMode,
        riskSettings,
      );
      const total = filtered.length;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const startIndex = (page - 1) * pageSize;
      const endIndex = startIndex + pageSize;
      const rows = toRows(filtered.slice(startIndex, endIndex));
      return NextResponse.json({
        items: rows,
        total,
        page,
        pageSize,
        totalPages,
        summary,
        riskSettings,
        settingsMode,
        settingsEditable,
      });
    }
    const [total, logs, summary] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          actor: { select: { id: true, email: true, name: true, role: true } },
        },
      }),
      buildSummary(),
    ]);
    const rows = toRows(logs);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    return NextResponse.json({
      items: rows,
      total,
      page,
      pageSize,
      totalPages,
      summary,
      riskSettings,
      settingsMode,
      settingsEditable,
    });
  }

  const rawLogs = await prisma.auditLog.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      actor: { select: { id: true, email: true, name: true, role: true } },
    },
  });

  const logs = filterByQueueMode(
    filterByRiskMode(rawLogs, normalizedRiskMode, riskSettings),
    queueMode,
    riskSettings,
  );
  return NextResponse.json(toRows(logs));
}
