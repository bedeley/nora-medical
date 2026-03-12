import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";

type BackorderLine = {
  productName: string;
  requested: number;
  supplyingNow: number;
  remaining: number;
  etaDays: number | null;
  raw: string;
};

function parseBackorderLines(note: string | null | undefined): BackorderLine[] {
  const text = String(note || "").trim();
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.toLowerCase().startsWith("backorder pending:"))
    .map((line) => {
      const m = line.match(
        /^Backorder pending:\s*(.+?)\s*requested\s*(\d+)\s*,\s*supplying\s*(\d+)\s*now\s*,\s*remaining\s*(\d+)\.\s*(?:ETA\s*(\d+)\s*day\(s\)\.)?$/i,
      );
      if (!m) {
        return {
          productName: line.replace(/^Backorder pending:\s*/i, ""),
          requested: 0,
          supplyingNow: 0,
          remaining: 0,
          etaDays: null,
          raw: line,
        };
      }
      return {
        productName: m[1].trim(),
        requested: Number(m[2] || 0),
        supplyingNow: Number(m[3] || 0),
        remaining: Number(m[4] || 0),
        etaDays: m[5] ? Number(m[5]) : null,
        raw: line,
      };
    })
    .filter((line) => line.remaining > 0);
}

const normalize = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ");

export async function POST(
  req: Request,
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
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "admin-order-backorder-draft", 60_000, 60);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  const params = await context.params;
  const orderId = params.id;
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      status: true,
      userId: true,
      walkInName: true,
      walkInPhone: true,
      adminNote: true,
      user: { select: { id: true, name: true, email: true } },
    },
  });
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });
  if (!order.userId) {
    return NextResponse.json(
      { error: "Backorder fulfillment draft requires a linked customer account." },
      { status: 400 },
    );
  }
  const lines = parseBackorderLines(order.adminNote);
  if (!lines.length) {
    return NextResponse.json({ error: "No backorder lines found on this order." }, { status: 400 });
  }

  const products = await prisma.product.findMany({
    where: { archived: false },
    select: { id: true, name: true, price: true },
    take: 5000,
  });
  const byExact = new Map<string, { id: string; name: string; price: number }>();
  for (const p of products) byExact.set(normalize(p.name), { id: p.id, name: p.name, price: Number(p.price || 0) });

  const draftLines = lines.map((line) => {
    const exact = byExact.get(normalize(line.productName));
    if (exact) {
      return {
        raw: line.raw,
        itemRef: line.productName,
        quantity: line.remaining,
        productId: exact.id,
        productName: exact.name,
        matchedBy: "name" as const,
      };
    }
    return {
      raw: line.raw,
      itemRef: line.productName,
      quantity: line.remaining,
      productId: null,
      productName: null,
      matchedBy: null,
    };
  });

  const matchedCount = draftLines.filter((line) => Boolean(line.productId)).length;
  const unmatchedCount = draftLines.length - matchedCount;

  return NextResponse.json({
    ok: true,
    draft: {
      sourceOrderId: order.id,
      sourceStatus: order.status,
      customerId: order.userId,
      customerName: order.user?.name || order.user?.email || order.userId,
      lines: draftLines,
      matchedCount,
      unmatchedCount,
      note: `Backorder fulfillment for Order ${order.id}`,
    },
  });
}

