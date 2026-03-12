import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PaymentStatus, RefundDestination } from "@/lib/prisma-enums";

function parseMonth(m?: string) {
  if (!m) return null;
  const [y, mm] = m.split("-");
  const year = Number(y);
  const month = Number(mm);
  if (!year || !month || month < 1 || month > 12) return null;
  const from = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const to = new Date(Date.UTC(year, month, 1, 0, 0, 0));
  return { from, to };
}

type PaymentMeta = {
  method?: string;
  provider?: string;
  reference?: string;
  receivedBy?: string;
  location?: string;
  status?: string;
  refundDisposition?: string | null;
  note?: string;
};

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isAccountant = role === "ACCOUNTANT";
  if (!session || (!isAdmin && !isAccountant)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const month = searchParams.get("month") || "";
  const paymentId = searchParams.get("id") || "";
  const method = searchParams.get("method") || "";
  const status = searchParams.get("status") || "";
  const disposition = searchParams.get("disposition") || "";
  const q = searchParams.get("q") || "";
  const sortDir = (searchParams.get("sort") as "asc" | "desc") || "desc";
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);
  const pageSize = Math.max(1, Math.min(200, parseInt(searchParams.get("pageSize") || "25", 10) || 25));

  const range = parseMonth(month || undefined);
  let dateFilter: { gte?: Date; lt?: Date } | undefined;
  if (!paymentId) {
    if (range) {
      dateFilter = { gte: range.from, lt: range.to };
    } else {
      const now = new Date();
      const start = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      dateFilter = { gte: start, lt: now };
    }
  }

  const statusFilter = status
    ? PaymentStatus[status.toUpperCase() as keyof typeof PaymentStatus]
    : undefined;
  const dispositionFilter = disposition
    ? RefundDestination[disposition.toUpperCase() as keyof typeof RefundDestination]
    : undefined;

  const where = {
    deletedAt: null,
    ...(paymentId ? { id: paymentId } : {}),
    ...(dateFilter ? { createdAt: dateFilter } : {}),
    ...(statusFilter ? { status: statusFilter } : {}),
    ...(dispositionFilter ? { refundDisposition: dispositionFilter } : {}),
    ...(q
      ? {
          OR: [
            { id: { contains: q, mode: "insensitive" } },
            { user: { name: { contains: q, mode: "insensitive" } } },
            { user: { email: { contains: q, mode: "insensitive" } } },
            { order: { invoiceNumber: { contains: q, mode: "insensitive" } } },
            { orderId: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  } satisfies NonNullable<Parameters<typeof prisma.payment.findMany>[0]>["where"];

  const payments = await prisma.payment.findMany({
    where,
    include: {
      user: { select: { id: true, name: true, email: true } },
      order: { select: { id: true, invoiceNumber: true, receiptHash: true } },
    },
    orderBy: { createdAt: sortDir },
  });

  const rows = payments
    .map((p) => {
      let meta: PaymentMeta | undefined;
      if (p.note) {
        try {
          meta = JSON.parse(p.note) as PaymentMeta;
        } catch {
          meta = undefined;
        }
      }
      return {
        id: p.id,
        amount: Number(p.amount || 0),
        status: p.status || null,
        refundDisposition: p.refundDisposition || meta?.refundDisposition || null,
        createdAt: p.createdAt.toISOString(),
        user: p.user,
        order: p.order,
        method: meta?.method || "",
        provider: meta?.provider || "",
        reference: meta?.reference || "",
        location: meta?.location || "",
        note: meta?.note || "",
      };
    })
    .filter((row) => {
      if (method && row.method !== method) return false;
      if (status && row.status?.toLowerCase() !== status.toLowerCase()) return false;
      return true;
    });

  const total = rows.length;
  const totalAmount = rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const totals = rows.reduce(
    (acc, row) => {
      const amount = Number(row.amount || 0);
      const status = String(row.status || "").toUpperCase();
      const disposition = String(row.refundDisposition || "").toUpperCase();
      const reference = String(row.reference || "").toUpperCase();
      if (reference === "AUTO_APPLY") {
        acc.storeCreditApplied += amount;
      } else if (amount < 0 || status === "REFUND") {
        acc.cashOut += Math.abs(amount);
      } else if (disposition === "CREDIT") {
        acc.storeCreditIssued += amount;
      } else if (amount > 0) {
        acc.cashIn += amount;
      }
      return acc;
    },
    { cashIn: 0, cashOut: 0, storeCreditIssued: 0, storeCreditApplied: 0 },
  );
  const netCash = totals.cashIn - totals.cashOut;
  const startIdx = (page - 1) * pageSize;
  const paged = rows.slice(startIdx, startIdx + pageSize);

  return NextResponse.json({
    rows: paged,
    total,
    totalAmount,
    totals: {
      cashIn: totals.cashIn,
      cashOut: totals.cashOut,
      storeCreditIssued: totals.storeCreditIssued,
      storeCreditApplied: totals.storeCreditApplied,
      netCash,
    },
    page,
    pageSize,
  });
}
