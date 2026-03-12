import { prisma } from "@/lib/prisma";
import { PaymentStatus } from "@/lib/prisma-enums";
import type { Role } from "@prisma/client";

export type OtcShiftRange = {
  from: Date;
  to: Date;
};

export type OtcShiftSummary = {
  expectedCash: number;
  expectedBank: number;
  expectedTotal: number;
  paymentCount: number;
  walkInOrderCount: number;
  outstandingWalkInBalance: number;
  unpostedPaymentCount: number;
};

function parsePaymentMethod(note: string | null): string {
  if (!note) return "cash";
  try {
    const parsed = JSON.parse(note) as { method?: string };
    return String(parsed.method || "cash").toLowerCase();
  } catch {
    return "cash";
  }
}

function toBucket(method: string): "cash" | "bank" {
  return method === "momo" || method === "transfer" || method === "bank"
    ? "bank"
    : "cash";
}

export function buildUtcDayRange(dayYmd?: string): OtcShiftRange {
  if (dayYmd) {
    const ymd = String(dayYmd).trim();
    const from = new Date(`${ymd}T00:00:00.000Z`);
    const to = new Date(`${ymd}T23:59:59.999Z`);
    if (!Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime())) {
      return { from, to };
    }
  }
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const from = new Date(`${yyyy}-${mm}-${dd}T00:00:00.000Z`);
  const to = new Date(`${yyyy}-${mm}-${dd}T23:59:59.999Z`);
  return { from, to };
}

export async function getLatestOtcPaymentDayUtcYmd(): Promise<string | null> {
  const latestPayment = await prisma.payment.findFirst({
    where: {
      deletedAt: null,
      status: { not: PaymentStatus.VOID },
      order: { customerType: "WALK_IN" },
    },
    select: { createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  if (!latestPayment?.createdAt) return null;
  return latestPayment.createdAt.toISOString().slice(0, 10);
}

export function getUtcTodayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

export type OtcShiftClosedStatus = {
  closed: boolean;
  day: string;
  shiftCloseId: string | null;
  closedAt: string | null;
  closedBy: { id: string; name: string | null; email: string | null; role: Role } | null;
};

export type OtcShiftDayStatus = {
  day: string;
  isOpen: boolean;
  isClosed: boolean;
  openEventId: string | null;
  closeEventId: string | null;
  openedAt: string | null;
  closedAt: string | null;
  openedBy: { id: string; name: string | null; email: string | null; role: Role } | null;
  closedBy: { id: string; name: string | null; email: string | null; role: Role } | null;
};

export async function getOtcShiftDayStatus(dayYmd?: string): Promise<OtcShiftDayStatus> {
  const day = String(dayYmd || getUtcTodayYmd()).trim();
  const marker = `"day":"${day}"`;
  const [openRow, closeRow] = await Promise.all([
    prisma.auditLog.findFirst({
      where: {
        action: "OTC_SHIFT_OPEN",
        entityType: "OTC_SHIFT",
        meta: { contains: marker },
      },
      orderBy: { createdAt: "desc" },
      include: {
        actor: {
          select: { id: true, name: true, email: true, role: true },
        },
      },
    }),
    prisma.auditLog.findFirst({
      where: {
        action: "OTC_SHIFT_CLOSE",
        entityType: "OTC_SHIFT",
        meta: { contains: marker },
      },
      orderBy: { createdAt: "desc" },
      include: {
        actor: {
          select: { id: true, name: true, email: true, role: true },
        },
      },
    }),
  ]);

  const latestIsOpen =
    !!openRow && (!closeRow || openRow.createdAt.getTime() >= closeRow.createdAt.getTime());

  return {
    day,
    isOpen: latestIsOpen,
    isClosed: !!closeRow && !latestIsOpen,
    openEventId: openRow?.entityId || null,
    closeEventId: closeRow?.entityId || null,
    openedAt: openRow?.createdAt?.toISOString() || null,
    closedAt: closeRow?.createdAt?.toISOString() || null,
    openedBy: openRow?.actor
      ? {
          id: openRow.actor.id,
          name: openRow.actor.name,
          email: openRow.actor.email,
          role: openRow.actor.role,
        }
      : null,
    closedBy: closeRow?.actor
      ? {
          id: closeRow.actor.id,
          name: closeRow.actor.name,
          email: closeRow.actor.email,
          role: closeRow.actor.role,
        }
      : null,
  };
}

export async function getOtcShiftClosedStatus(dayYmd?: string): Promise<OtcShiftClosedStatus> {
  const status = await getOtcShiftDayStatus(dayYmd);
  if (!status.closeEventId) {
    return {
      closed: false,
      day: status.day,
      shiftCloseId: null,
      closedAt: null,
      closedBy: null,
    };
  }
  return {
    closed: status.isClosed,
    day: status.day,
    shiftCloseId: status.closeEventId,
    closedAt: status.closedAt,
    closedBy: status.closedBy,
  };
}

export function canStaffOpenShiftNow(now = new Date()): boolean {
  return now.getUTCHours() >= 6;
}

export async function getOtcShiftOpenGuard(now = new Date()) {
  const day = getUtcTodayYmd();
  const status = await getOtcShiftDayStatus(day);
  return {
    day,
    status,
    staffAllowedNow: canStaffOpenShiftNow(now),
    openWindowStartHourUtc: 6,
  };
}

export async function getLatestOtcShiftCloseForDay(dayYmd?: string) {
  const day = String(dayYmd || getUtcTodayYmd()).trim();
  const marker = `"day":"${day}"`;
  return prisma.auditLog.findFirst({
    where: {
      action: "OTC_SHIFT_CLOSE",
      entityType: "OTC_SHIFT",
      meta: { contains: marker },
    },
    orderBy: { createdAt: "desc" },
    include: {
        actor: {
          select: { id: true, name: true, email: true, role: true },
        },
      },
  });
}

export async function getLatestOtcShiftCloseGlobal() {
  return prisma.auditLog.findFirst({
    where: {
      action: "OTC_SHIFT_CLOSE",
      entityType: "OTC_SHIFT",
    },
    orderBy: { createdAt: "desc" },
    include: {
      actor: {
        select: { id: true, name: true, email: true, role: true },
      },
    },
  });
}

export async function getOtcShiftSummary(range: OtcShiftRange): Promise<OtcShiftSummary> {
  const payments = await prisma.payment.findMany({
    where: {
      createdAt: { gte: range.from, lte: range.to },
      deletedAt: null,
      status: { not: PaymentStatus.VOID },
      order: { customerType: "WALK_IN" },
    },
    select: {
      id: true,
      amount: true,
      note: true,
      orderId: true,
    },
  });

  let expectedCash = 0;
  let expectedBank = 0;
  const orderIds = new Set<string>();
  const paymentIds = payments.map((p) => p.id);

  for (const payment of payments) {
    const amount = Number(payment.amount || 0);
    const method = parsePaymentMethod(payment.note);
    const bucket = toBucket(method);
    if (bucket === "bank") expectedBank += amount;
    else expectedCash += amount;
    if (payment.orderId) orderIds.add(payment.orderId);
  }

  const outstanding = await prisma.order.aggregate({
    where: {
      customerType: "WALK_IN",
      status: { not: "CANCELLED" },
    },
    _sum: { balance: true },
  });

  let unpostedPaymentCount = 0;
  if (paymentIds.length > 0) {
    const posted = await prisma.journalEntry.findMany({
      where: {
        sourceType: "PAYMENT",
        sourceId: { in: paymentIds },
        status: "POSTED",
      },
      select: { sourceId: true },
    });
    const postedIds = new Set(posted.map((p) => p.sourceId).filter(Boolean));
    unpostedPaymentCount = paymentIds.filter((id) => !postedIds.has(id)).length;
  }

  return {
    expectedCash,
    expectedBank,
    expectedTotal: expectedCash + expectedBank,
    paymentCount: payments.length,
    walkInOrderCount: orderIds.size,
    outstandingWalkInBalance: Number(outstanding._sum.balance || 0),
    unpostedPaymentCount,
  };
}
