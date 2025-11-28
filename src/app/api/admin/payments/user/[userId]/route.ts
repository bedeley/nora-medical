import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(
  _req: Request,
  { params }: { params: { userId: string } }
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = params.userId;
  try {
    type AppliedMeta = { orderId?: string; applied?: number };
    type PaymentMeta = {
      applied?: AppliedMeta[];
      refundDisposition?: string;
    };

    const payments = await prisma.payment.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });

    const rows = payments.map((p: {
      id: string;
      amount: unknown;
      orderId: string | null;
      createdAt: Date;
      note: string | null;
      status: string | null;
      refundDisposition: string | null;
    }) => {
      let meta: PaymentMeta | undefined;
      try {
        meta = p.note ? (JSON.parse(p.note) as PaymentMeta) : undefined;
      } catch {
        meta = undefined;
      }
      let applied: Array<{ orderId: string; applied: number }> = (meta?.applied || []).map(
        (a: { orderId?: unknown; applied?: unknown }) => ({
          orderId: String(a?.orderId || ""),
          applied: Number(a?.applied || 0),
        })
      );
      // Backfill applied info for older/manual payments that have an orderId
      // but no structured "applied" metadata yet.
      if ((!applied || applied.length === 0) && p.orderId && Number(p.amount || 0) !== 0) {
        applied = [{
          orderId: String(p.orderId),
          applied: Number(p.amount || 0),
        }];
      }
      return {
        id: p.id,
        amount: Number(p.amount),
        orderId: p.orderId || null,
        createdAt: p.createdAt.toISOString(),
        applied,
        meta,
        status: p.status || null,
        refundDisposition: p.refundDisposition || meta?.refundDisposition || null,
      };
    });

    // Match the same semantics used on /admin/customers for "Store Credit":
    // exclude internal auto-apply adjustment entries (reference: "AUTO_APPLY")
    // from the aggregate payment total used for balances/credit.
    const total = payments.reduce(
      (
        s: number,
        p: { amount: unknown; note: string | null },
      ) => {
        const note = p.note || "";
        if (note.includes("\"reference\":\"AUTO_APPLY\"")) return s;
        return s + Number(p.amount || 0);
      },
      0,
    );
    return NextResponse.json({ payments: rows, total });
  } catch (e) {
    console.error("List user payments error:", e);
    return NextResponse.json({ error: "Failed to list payments" }, { status: 500 });
  }
}
