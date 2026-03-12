import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { isLiveStage } from "@/lib/env";
import { prisma } from "@/lib/prisma";

type MomoPending = {
  id: string;
  amount: number;
  createdAt: string;
  status: string;
  settlement: "PENDING" | "SETTLED" | "FAILED";
  posted: boolean;
  source: "MANUAL" | "PROVIDER";
  canCancel: boolean;
  canResolveLate: boolean;
  canSimulateLate: boolean;
  canPostNow: boolean;
  provider: string;
  providerRef: string;
  user: { id: string; name: string | null; email: string | null } | null;
  order: { id: string; status: string | null; total: number } | null;
};

function parseMeta(note: string | null) {
  if (!note) return null;
  try {
    return JSON.parse(note) as {
      method?: string;
      status?: string;
      providerRef?: string;
    };
  } catch {
    return null;
  }
}

function isPendingProviderMomo(note: string | null) {
  const meta = parseMeta(note);
  return (
    String(meta?.method || "").toLowerCase() === "momo" &&
    String(meta?.status || "").toUpperCase() === "PENDING" &&
    Boolean(String(meta?.providerRef || "").trim())
  );
}

export async function GET() {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isAccountant = role === "ACCOUNTANT";
  if (!session || (!isAdmin && !isAccountant)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const allowTestTools = process.env.MOMO_TEST_TOOLS_ENABLED === "1" && !isLiveStage();
    const payments = await prisma.payment.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        user: { select: { id: true, name: true, email: true } },
        order: { select: { id: true, status: true, total: true } },
      },
    });
    const orderIds = Array.from(
      new Set(payments.map((p) => p.orderId).filter(Boolean) as string[]),
    );
    const orderPayments = orderIds.length
      ? await prisma.payment.findMany({
          where: { orderId: { in: orderIds } },
          select: { id: true, orderId: true, amount: true, status: true, note: true },
        })
      : [];
    const paymentsByOrderId = new Map<string, typeof orderPayments>();
    for (const p of orderPayments) {
      const key = String(p.orderId || "");
      if (!key) continue;
      const list = paymentsByOrderId.get(key) || [];
      list.push(p);
      paymentsByOrderId.set(key, list);
    }
    const momo = payments
      .map((p: (typeof payments)[number]) => {
        let meta: Record<string, unknown> | null = null;
        if (p.note) {
          try {
            meta = JSON.parse(p.note) as Record<string, unknown>;
          } catch {
            meta = null;
          }
        }
        if (!meta || meta.method !== "momo") return null;
        const status = String((meta.status as string | undefined) ?? "").trim();
        const providerRef = String((meta.providerRef as string | undefined) ?? "").trim();
        const hasProviderRef = providerRef.length > 0;
        const isManualRecordedMomo = !status && !hasProviderRef;
        const normalizedStatus = isManualRecordedMomo ? "RECORDED" : status || "PENDING";
        const normalized = normalizedStatus.toUpperCase();
        let settlement: MomoPending["settlement"] =
          isManualRecordedMomo
            ? "SETTLED"
            : normalized === "SUCCESSFUL" || normalized === "SUCCESS"
            ? "SETTLED"
            : normalized === "RESOLVED_TO_CREDIT"
            ? "SETTLED"
            : normalized === "CANCELLED_BY_STAFF" || normalized === "LATE_SUCCESS_AFTER_CANCEL"
            ? "FAILED"
            : ["FAILED", "DENIED", "TIMEOUT"].includes(normalized)
            ? "FAILED"
            : "PENDING";
        let displayStatus = normalizedStatus;
        if (
          settlement === "PENDING" &&
          p.order?.id &&
          Number(p.order.total || 0) > 0
        ) {
          const peers = paymentsByOrderId.get(p.order.id) || [];
          const paidExcludingCurrentPending = peers.reduce((sum, peer) => {
            if (peer.id === p.id) return sum;
            if (peer.status === "VOID") return sum;
            if (isPendingProviderMomo(peer.note)) return sum;
            const amt = Number(peer.amount || 0);
            return sum + (peer.status === "REFUND" ? -Math.abs(amt) : amt);
          }, 0);
          if (paidExcludingCurrentPending >= Number(p.order.total || 0) - 0.01) {
            settlement = "SETTLED";
            displayStatus = "SUPERSEDED";
          }
        }
        const item: MomoPending = {
          id: p.id,
          amount: Number(p.amount || 0),
          createdAt: p.createdAt.toISOString(),
          status: displayStatus,
          settlement,
          posted: false,
          source: isManualRecordedMomo ? "MANUAL" : "PROVIDER",
          canCancel: !isManualRecordedMomo && settlement === "PENDING" && hasProviderRef,
          canResolveLate: normalized === "LATE_SUCCESS_AFTER_CANCEL",
          canSimulateLate: allowTestTools && normalized === "CANCELLED_BY_STAFF",
          canPostNow: settlement === "SETTLED",
          provider: (meta.provider as string | undefined) ?? "mtn",
          providerRef,
          user: p.user,
          order: p.order
            ? {
                id: p.order.id,
                status: p.order.status,
                total: Number(p.order.total || 0),
              }
            : null,
        };
        return item;
      })
      .filter((item: MomoPending | null): item is MomoPending => item !== null);

    if (momo.length) {
      const sourceIdOr = momo.flatMap((p) => [
        { sourceId: p.id },
        { sourceId: { startsWith: `${p.id}:` } },
      ]);
      const posted = await prisma.journalEntry.findMany({
        where: {
          sourceType: "PAYMENT",
          status: "POSTED",
          OR: sourceIdOr,
        },
        select: { sourceId: true },
      });
      const postedIds = new Set(
        posted.map((entry) => String(entry.sourceId || "").split(":")[0]).filter(Boolean),
      );
      momo.forEach((item) => {
        item.posted = postedIds.has(item.id);
        if (item.posted) item.canPostNow = false;
      });
    }

    return NextResponse.json({ items: momo });
  } catch {
    return NextResponse.json({ error: "Failed to load MoMo payments" }, { status: 500 });
  }
}
