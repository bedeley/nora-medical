import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type ShiftCloseMeta = {
  day?: string;
  expected?: { cash?: number; bank?: number; total?: number };
  actual?: { cash?: number; bank?: number; total?: number };
  variance?: { cash?: number; bank?: number; total?: number };
  paymentCount?: number;
  walkInOrderCount?: number;
  outstandingWalkInBalance?: number;
  unpostedPaymentCount?: number;
  note?: string | null;
};

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  const isAccountant = role === "ACCOUNTANT";
  if (!session || (!isAdmin && !isStaff && !isAccountant)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const limit = Math.max(1, Math.min(100, Number(searchParams.get("limit") || 20)));

  const rows = await prisma.auditLog.findMany({
    where: {
      action: "OTC_SHIFT_CLOSE",
      entityType: "OTC_SHIFT",
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      actor: { select: { id: true, name: true, email: true, role: true } },
    },
  });

  const items = rows.map((row) => {
    let meta: ShiftCloseMeta | null = null;
    if (row.meta) {
      try {
        meta = JSON.parse(row.meta) as ShiftCloseMeta;
      } catch {
        meta = null;
      }
    }
    return {
      id: row.id,
      shiftCloseId: row.entityId,
      createdAt: row.createdAt.toISOString(),
      actor: row.actor
        ? {
            id: row.actor.id,
            name: row.actor.name,
            email: row.actor.email,
            role: row.actor.role,
          }
        : null,
      day: String(meta?.day || ""),
      expected: {
        cash: Number(meta?.expected?.cash || 0),
        bank: Number(meta?.expected?.bank || 0),
        total: Number(meta?.expected?.total || 0),
      },
      actual: {
        cash: Number(meta?.actual?.cash || 0),
        bank: Number(meta?.actual?.bank || 0),
        total: Number(meta?.actual?.total || 0),
      },
      variance: {
        cash: Number(meta?.variance?.cash || 0),
        bank: Number(meta?.variance?.bank || 0),
        total: Number(meta?.variance?.total || 0),
      },
      paymentCount: Number(meta?.paymentCount || 0),
      walkInOrderCount: Number(meta?.walkInOrderCount || 0),
      outstandingWalkInBalance: Number(meta?.outstandingWalkInBalance || 0),
      unpostedPaymentCount: Number(meta?.unpostedPaymentCount || 0),
      note: meta?.note || null,
    };
  });

  return NextResponse.json({ items });
}

