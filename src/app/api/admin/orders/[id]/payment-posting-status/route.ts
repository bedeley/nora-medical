import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

function toBaseSourceId(value: string | null | undefined) {
  const sourceId = String(value || "").trim();
  if (!sourceId) return "";
  return sourceId.split(":")[0] || sourceId;
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  const isAccountant = role === "ACCOUNTANT";
  if (!session || (!isAdmin && !isStaff && !isAccountant)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const params = await context.params;
    const orderId = params.id;
    const payments = await prisma.payment.findMany({
      where: {
        orderId,
        status: { notIn: ["REFUND", "VOID"] },
        deletedAt: null,
      },
      select: {
        id: true,
        note: true,
      },
    });
    const paymentIds = payments
      .filter((p) => {
        if (!p.note) return true;
        try {
          const meta = JSON.parse(p.note) as {
            method?: string;
            providerRef?: string;
            status?: string;
          };
          const method = String(meta?.method || "").toLowerCase();
          const providerRef = String(meta?.providerRef || "").trim();
          if (method !== "momo" || !providerRef) return true;
          const momoStatus = String(meta?.status || "").toUpperCase();
          return (
            momoStatus === "SUCCESS" ||
            momoStatus === "SUCCESSFUL" ||
            momoStatus === "RESOLVED_TO_CREDIT"
          );
        } catch {
          return true;
        }
      })
      .map((p) => p.id);
    if (paymentIds.length === 0) {
      return NextResponse.json({
        orderId,
        totalPayments: 0,
        postedCount: 0,
        pendingCount: 0,
        postedPaymentIds: [],
        pendingPaymentIds: [],
      });
    }

    const posted = await prisma.journalEntry.findMany({
      where: {
        sourceType: "PAYMENT",
        status: "POSTED",
        OR: [
          { sourceId: { in: paymentIds } },
          ...paymentIds.map((id) => ({ sourceId: { startsWith: `${id}:` } })),
        ],
      },
      select: { sourceId: true },
    });
    const postedSet = new Set(
      posted.map((row) => toBaseSourceId(row.sourceId)).filter(Boolean) as string[]
    );
    const pendingPaymentIds = paymentIds.filter((id) => !postedSet.has(id));
    const postedPaymentIds = paymentIds.filter((id) => postedSet.has(id));

    return NextResponse.json({
      orderId,
      totalPayments: paymentIds.length,
      postedCount: postedPaymentIds.length,
      pendingCount: pendingPaymentIds.length,
      postedPaymentIds,
      pendingPaymentIds,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
