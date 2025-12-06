import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PaymentStatus } from "@/lib/prisma-enums";

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
  const m = searchParams.get("month"); // YYYY-MM
  const method = searchParams.get("method") || undefined; // cash|card|transfer|adjustment
  const status = searchParams.get("status") || undefined; // normal|refund|void
  const range = parseMonth(m || undefined);
  if (!range) {
    return NextResponse.json({ error: "Invalid or missing month (YYYY-MM)" }, { status: 400 });
  }

  const statusFilter = status ? (status.toUpperCase() as keyof typeof PaymentStatus) : undefined;
  const rows = await prisma.payment.findMany({
    where: {
      createdAt: { gte: range.from, lt: range.to },
      ...(statusFilter ? { status: PaymentStatus[statusFilter] } : {}),
    },
    orderBy: { createdAt: "asc" },
  });

  type PaymentMeta = { method?: string };

  let count = 0;
  let total = 0;
  for (const r of rows) {
    let meta: PaymentMeta | null = null;
    if (r.note) {
      try {
        meta = JSON.parse(r.note as string) as PaymentMeta;
      } catch {
        // ignore invalid JSON; treat as no meta
      }
    }
    if (method && (meta?.method || "") !== method) continue;
    count++;
    total += Number(r.amount || 0);
  }

  return NextResponse.json({ count, total, month: m, method: method || null, status: status || null });
}
