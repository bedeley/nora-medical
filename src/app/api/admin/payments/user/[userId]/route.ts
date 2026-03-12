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
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isAccountant = role === "ACCOUNTANT";
  if (!session || (!isAdmin && !isAccountant)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = params.userId;
  try {
    type AppliedMeta = { orderId?: string; applied?: number };
    type PaymentMeta = {
      applied?: AppliedMeta[];
      refundDisposition?: string;
      method?: string;
      reference?: string;
      location?: string;
    };

    function normalizeAppliedForRow(opts: {
      amount: number;
      orderId: string | null;
      applied: Array<{ orderId: string; applied: number }>;
    }) {
      const amount = Math.abs(Number(opts.amount || 0));
      const raw = Array.isArray(opts.applied) ? opts.applied : [];
      const valid = raw
        .map((a) => ({
          orderId: String(a?.orderId || ""),
          applied: Number(a?.applied || 0),
        }))
        .filter((a) => a.orderId && a.applied > 0);

      if (valid.length === 0 && opts.orderId && amount > 0) {
        return [{ orderId: String(opts.orderId), applied: amount }];
      }

      let remaining = amount;
      const out: Array<{ orderId: string; applied: number }> = [];
      for (const entry of valid) {
        if (remaining <= 0.0001) break;
        const take = Math.min(entry.applied, remaining);
        if (take > 0) out.push({ orderId: entry.orderId, applied: take });
        remaining -= take;
      }
      return out;
    }

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
      const parsedApplied: Array<{ orderId: string; applied: number }> = (meta?.applied || []).map(
        (a: { orderId?: unknown; applied?: unknown }) => ({
          orderId: String(a?.orderId || ""),
          applied: Number(a?.applied || 0),
        })
      );
      const applied = normalizeAppliedForRow({
        amount: Number(p.amount || 0),
        orderId: p.orderId || null,
        applied: parsedApplied,
      });
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
