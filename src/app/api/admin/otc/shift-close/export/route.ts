import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

function csvEscape(value: unknown) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

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
  const day = searchParams.get("day") || "";

  const rows = await prisma.auditLog.findMany({
    where: {
      action: "OTC_SHIFT_CLOSE",
      entityType: "OTC_SHIFT",
      ...(day ? { meta: { contains: `"day":"${day}"` } } : {}),
    },
    include: {
      actor: { select: { name: true, email: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 1000,
  });

  const header = [
    "day",
    "closed_at",
    "closed_by",
    "expected_cash",
    "expected_bank",
    "expected_total",
    "actual_cash",
    "actual_bank",
    "actual_total",
    "variance_cash",
    "variance_bank",
    "variance_total",
    "payment_count",
    "walkin_orders",
    "outstanding_walkin_balance",
    "unposted_payment_count",
    "override_used",
    "override_reason",
    "note",
    "shift_close_id",
  ];
  const lines = [header.join(",")];

  for (const row of rows) {
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(row.meta || "{}") as Record<string, unknown>;
    } catch {
      meta = {};
    }
    const expected = (meta.expected || {}) as Record<string, unknown>;
    const actual = (meta.actual || {}) as Record<string, unknown>;
    const variance = (meta.variance || {}) as Record<string, unknown>;

    const closedBy = row.actor?.name || row.actor?.email || "System";
    const values = [
      String(meta.day || ""),
      row.createdAt.toISOString(),
      closedBy,
      Number(expected.cash || 0),
      Number(expected.bank || 0),
      Number(expected.total || 0),
      Number(actual.cash || 0),
      Number(actual.bank || 0),
      Number(actual.total || 0),
      Number(variance.cash || 0),
      Number(variance.bank || 0),
      Number(variance.total || 0),
      Number(meta.paymentCount || 0),
      Number(meta.walkInOrderCount || 0),
      Number(meta.outstandingWalkInBalance || 0),
      Number(meta.unpostedPaymentCount || 0),
      Boolean(meta.overrideUsed),
      String(meta.overrideReason || ""),
      String(meta.note || ""),
      row.entityId,
    ];
    lines.push(values.map(csvEscape).join(","));
  }

  const csv = lines.join("\n");
  const filename = `otc-shift-close-${day || new Date().toISOString().slice(0, 10)}.csv`;

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

