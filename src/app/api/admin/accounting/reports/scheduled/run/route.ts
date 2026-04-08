import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { assertSameOrigin } from "@/lib/origin";
import { loadAccountTotals, parseDateRange, toNet } from "@/app/api/admin/accounting/reports/utils";

type Schedule = {
  id: string;
  name: string;
  reportType: "VAT" | "TRIAL_BALANCE" | "INTEGRITY" | "PL" | "BALANCE_SHEET";
  frequency: "WEEKLY" | "MONTHLY";
  recipients: string;
  enabled: boolean;
  lastSentAt?: string;
};

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

const parseRecipients = (raw: string) =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const formatDate = (d: Date) => d.toISOString().slice(0, 10);

const resolveBaseUrl = (req: Request) => {
  const envBase = (process.env.NEXT_PUBLIC_BASE_URL || process.env.NEXTAUTH_URL || "").trim();
  if (envBase) return envBase.replace(/\/+$/, "");
  try {
    const origin = new URL(req.url).origin;
    return origin.replace(/\/+$/, "");
  } catch {
    return "";
  }
};

const toAbsoluteUrl = (baseUrl: string, path: string) => {
  if (!path) return baseUrl;
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  if (!baseUrl) return path;
  return `${baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
};

const computeRange = (frequency: Schedule["frequency"]) => {
  const now = new Date();
  if (frequency === "WEEKLY") {
    const end = new Date(now);
    end.setDate(end.getDate() - 1);
    const start = new Date(end);
    start.setDate(end.getDate() - 6);
    return { start, end };
  }
  const end = new Date(now.getFullYear(), now.getMonth(), 0);
  const start = new Date(end.getFullYear(), end.getMonth(), 1);
  return { start, end };
};

const buildVatSummary = async (start: Date, end: Date) => {
  const dateRange = parseDateRange(formatDate(start), formatDate(end));
  const lines = await prisma.journalLine.findMany({
    where: {
      taxCodeId: { not: null },
      entry: {
        status: "POSTED",
        entryDate: dateRange.gte || dateRange.lte ? dateRange : undefined,
      },
    },
    include: { taxCode: true },
  });

  let outputVat = 0;
  let inputVat = 0;
  for (const line of lines) {
    if (!line.taxCode) continue;
    const rate = Number(line.taxCode.rate || 0);
    const base = Math.abs(Number(line.debit || 0) - Number(line.credit || 0));
    const vatTotal =
      line.taxCode.type === "OUTPUT" || line.taxCode.type === "INPUT"
        ? base * (rate / 100)
        : 0;
    if (line.taxCode.type === "OUTPUT") outputVat += vatTotal;
    if (line.taxCode.type === "INPUT") inputVat += vatTotal;
  }
  return { outputVat, inputVat, netVat: outputVat - inputVat };
};

const buildTrialBalanceSummary = async (start: Date, end: Date) => {
  const totals = await loadAccountTotals(parseDateRange(formatDate(start), formatDate(end)));
  const debit = totals.reduce((sum, row) => sum + row.debit, 0);
  const credit = totals.reduce((sum, row) => sum + row.credit, 0);
  return { debit, credit };
};

const buildIntegritySummary = async () => {
  const [draftEntries, totals, orderSums, products] = await Promise.all([
    prisma.journalEntry.count({ where: { status: "DRAFT" } }),
    loadAccountTotals(),
    prisma.order.aggregate({
      where: { status: { not: "CANCELLED" } },
      _sum: { total: true, amountPaid: true },
    }),
    prisma.product.findMany({ select: { stock: true, cost: true } }),
  ]);

  const totalsByCode = new Map(totals.map((row) => [row.code, row]));
  const arRow = totalsByCode.get("1100");
  const inventoryRow = totalsByCode.get("1200");
  const arLedger = arRow ? toNet(arRow) : 0;
  const inventoryLedger = inventoryRow ? toNet(inventoryRow) : 0;

  const customerBalances = Math.max(
    0,
    Number(orderSums._sum.total ?? 0) - Number(orderSums._sum.amountPaid ?? 0),
  );
  const inventoryValuation = products.reduce(
    (sum, product) => sum + Number(product.cost || 0) * Number(product.stock || 0),
    0,
  );
  const negativeStockCount = products.filter((product) => Number(product.stock || 0) < 0).length;

  return {
    draftEntries,
    arDifference: arLedger - customerBalances,
    inventoryDifference: inventoryLedger - inventoryValuation,
    negativeStockCount,
  };
};

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const { verifyCronSecret } = await import("@/lib/cron-auth");
  const hasCronAccess = verifyCronSecret(req);
  if (!hasCronAccess && (!session || !isAuthorized(session.user as AuthenticatedUser))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasCronAccess && !assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const targetId = String(body?.scheduleId || "");
  const baseUrl = resolveBaseUrl(req);

  const setting = await prisma.appSetting.findUnique({
    where: { key: "accounting.scheduledReports" },
    select: { value: true },
  });
  const schedules = (setting?.value || []) as Schedule[];
  const filtered = schedules.filter((s) => s.enabled && (!targetId || s.id === targetId));
  if (filtered.length === 0) {
    return NextResponse.json({ ok: true, sent: 0 });
  }

  const nextSchedules = schedules.map((schedule) => {
    if (!filtered.find((s) => s.id === schedule.id)) return schedule;
    return { ...schedule, lastSentAt: new Date().toISOString() };
  });

  let sent = 0;
  for (const schedule of filtered) {
    const recipients = parseRecipients(schedule.recipients);
    if (recipients.length === 0) continue;
    const range = computeRange(schedule.frequency);
    let subject = `Scheduled ${schedule.reportType} report`;
    let text = `${schedule.name}\nRange: ${formatDate(range.start)} - ${formatDate(range.end)}\n`;
    let reportPath = "";
    if (schedule.reportType === "VAT") {
      const summary = await buildVatSummary(range.start, range.end);
      subject = `VAT report (${formatDate(range.start)} - ${formatDate(range.end)})`;
      text += `Output VAT: ${summary.outputVat.toFixed(2)}\nInput VAT: ${summary.inputVat.toFixed(2)}\nNet VAT: ${summary.netVat.toFixed(2)}\n`;
      reportPath = `/admin/accounting/reports/vat?start=${formatDate(range.start)}&end=${formatDate(range.end)}`;
    } else if (schedule.reportType === "TRIAL_BALANCE") {
      const summary = await buildTrialBalanceSummary(range.start, range.end);
      subject = `Trial balance (${formatDate(range.start)} - ${formatDate(range.end)})`;
      text += `Debits: ${summary.debit.toFixed(2)}\nCredits: ${summary.credit.toFixed(2)}\n`;
      reportPath = `/admin/accounting/reports/trial-balance?start=${formatDate(range.start)}&end=${formatDate(range.end)}`;
    } else if (schedule.reportType === "PL") {
      subject = `Profit & Loss (${formatDate(range.start)} - ${formatDate(range.end)})`;
      reportPath = `/admin/accounting/reports/pl?start=${formatDate(range.start)}&end=${formatDate(range.end)}`;
    } else if (schedule.reportType === "BALANCE_SHEET") {
      subject = `Balance sheet (as of ${formatDate(range.end)})`;
      reportPath = `/admin/accounting/reports/balance-sheet?asOf=${formatDate(range.end)}`;
    } else {
      const summary = await buildIntegritySummary();
      subject = "Integrity report";
      text += `Draft entries: ${summary.draftEntries}\nAR diff: ${summary.arDifference.toFixed(2)}\nInventory diff: ${summary.inventoryDifference.toFixed(2)}\nNegative stock: ${summary.negativeStockCount}\n`;
      reportPath = "/admin/accounting/integrity";
    }
    const reportUrl = toAbsoluteUrl(baseUrl, reportPath);
    text += `Report: ${reportUrl}`;
    const html =
      `<div>` +
      `<p><strong>${schedule.name}</strong></p>` +
      `<p>Range: ${formatDate(range.start)} - ${formatDate(range.end)}</p>` +
      `<p><a href="${reportUrl}">Open report</a></p>` +
      `<p>${reportUrl}</p>` +
      `</div>`;
    for (const recipient of recipients) {
      const result = await sendEmail(recipient, subject, text, html);
      if (result.ok) sent += 1;
    }
  }

  await prisma.appSetting.upsert({
    where: { key: "accounting.scheduledReports" },
    update: { value: schedules.length ? nextSchedules : [] },
    create: { key: "accounting.scheduledReports", value: nextSchedules },
  });

  return NextResponse.json({ ok: true, sent });
}
