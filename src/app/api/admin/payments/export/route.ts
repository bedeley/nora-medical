import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

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
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const m = searchParams.get("month"); // YYYY-MM
  const method = searchParams.get("method") || undefined; // cash|card|transfer|adjustment
  const status = searchParams.get("status") || undefined; // normal|refund|void
  const delivery = searchParams.get("delivery") || undefined; // not-delivered|partial|delivered
  const range = parseMonth(m || undefined);
  if (!range) {
    return NextResponse.json({ error: "Invalid or missing month (YYYY-MM)" }, { status: 400 });
  }

  const rows = await prisma.payment.findMany({
    where: { createdAt: { gte: range.from, lt: range.to } },
    include: { user: { select: { email: true } }, order: { select: { id: true, deliveryStatus: true, deliveredAt: true } } },
    orderBy: { createdAt: "asc" },
  });

  const header = [
    "id",
    "userId",
    "userEmail",
    "orderId",
    "orderDeliveryStatus",
    "orderDeliveredAt",
    "amount",
    "method",
    "reference",
    "receivedBy",
    "location",
    "status",
    "note",
    "createdAt",
  ];

  const lines: string[] = [];
  lines.push(header.join(","));

  type PaymentMeta = {
    method?: string;
    status?: string;
    reference?: string;
    receivedBy?: string;
    location?: string;
    note?: string;
  };

  const filtered = rows.filter((r) => {
    let meta: PaymentMeta | null = null;
    if (r.note) {
      try {
        meta = JSON.parse(r.note as string) as PaymentMeta;
      } catch {
        // ignore bad JSON; treat as no meta
      }
    }
    if (method && (meta?.method || "") !== method) return false;
    if (status && (meta?.status || "") !== status) return false;
    if (delivery) {
      const ds = ((r.order?.deliveryStatus || "") as string).toUpperCase();
      if (delivery === "not-delivered" && ds !== "NOT_DELIVERED") return false;
      if (delivery === "partial" && ds !== "PARTIALLY_DELIVERED") return false;
      if (delivery === "delivered" && ds !== "DELIVERED") return false;
    }
    return true;
  });

  for (const r of filtered) {
    let note = r.note as string | null;
    let method = "";
    let reference = "";
    let receivedBy = "";
    let location = "";
    let status = "";
    if (note) {
      try {
        const meta = JSON.parse(note) as PaymentMeta;
        method = meta.method || "";
        reference = meta.reference || "";
        receivedBy = meta.receivedBy || "";
        location = meta.location || "";
        status = meta.status || "";
        note = meta.note || "";
      } catch {
        // keep original note string
      }
    }
    const csv = [
      r.id,
      r.userId,
      r.user?.email || "",
      r.orderId || "",
      (r.order?.deliveryStatus || "") as string,
      (r.order?.deliveredAt
        ? r.order?.deliveredAt.toISOString?.() ||
          new Date(r.order?.deliveredAt as unknown as string).toISOString()
        : "") as string,
      String(r.amount),
      method,
      reference,
      receivedBy,
      location,
      status,
      (note || "").replaceAll('"', '""'),
      r.createdAt.toISOString(),
    ]
      .map((v) => `"${v}"`)
      .join(",");
    lines.push(csv);
  }

  // Totals row
  const totalAmount = filtered.reduce((sum, r) => sum + Number(r.amount || 0), 0);
  const totals = [
    "TOTAL",
    "",
    "",
    "",
    "",
    "",
    String(totalAmount),
    "",
    "",
    "",
    "",
    "",
    "",
    "",
  ];
  lines.push("");
  lines.push(totals.map((v) => `"${v}"`).join(","));

  const body = lines.join("\n");
  return new NextResponse(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename=payments-${m}.csv`,
    },
  });
}
