import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";

const claimSchema = z.object({
  amount: z.number().positive("Amount must be greater than 0"),
  method: z.enum(["cash", "momo", "transfer", "card"]).default("cash"),
  reference: z.string().max(120).optional(),
  note: z.string().max(240).optional(),
});

function parseMeta(raw?: string | null) {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizePhone(v?: string | null) {
  return String(v || "").replace(/\D+/g, "");
}

function normalizeName(v?: string | null) {
  return String(v || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "dispatch-collection-claim", 60_000, 60);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = String(user?.role || "");
  const isPrivileged = role === "ADMIN" || role === "STAFF";
  const isDispatcher = role === "DISPATCHER";
  if (!session || (!isPrivileged && !isDispatcher)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = claimSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }
  const payload = parsed.data;
  if (payload.method !== "cash" && !String(payload.reference || "").trim()) {
    return NextResponse.json(
      { error: "Payment reference is required for MoMo, transfer, or card collections." },
      { status: 400 },
    );
  }

  const params = await context.params;
  const orderId = params.id;
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      deletedAt: true,
      status: true,
      balance: true,
    },
  });
  if (!order || order.deletedAt) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }
  if (String(order.status || "").toUpperCase() === "CANCELLED") {
    return NextResponse.json({ error: "Cancelled orders cannot be collected." }, { status: 400 });
  }

  const claimAmount = Number(payload.amount || 0);
  const balance = Number(order.balance || 0);
  if (claimAmount > balance + 0.01) {
    return NextResponse.json({ error: "Collection claim cannot exceed current order balance." }, { status: 400 });
  }

  if (isDispatcher) {
    const me = user?.id
      ? await prisma.user.findUnique({
          where: { id: user.id },
          select: { phone: true, name: true },
        })
      : null;
    const lastAssign = await prisma.auditLog.findFirst({
      where: {
        entityType: "ORDER",
        entityId: order.id,
        action: "ORDER_DELIVERY_ASSIGN",
      },
      orderBy: { createdAt: "desc" },
      select: { meta: true },
    });
    const a = parseMeta(lastAssign?.meta);
    const assignedById = String(a?.riderUserId || "") === String(user?.id || "");
    const assignedByPhone =
      normalizePhone(String(a?.riderPhone || "")) &&
      normalizePhone(String(a?.riderPhone || "")) === normalizePhone(me?.phone || "");
    const assignedByName =
      normalizeName(String(a?.riderName || "")) &&
      normalizeName(String(a?.riderName || "")) === normalizeName(me?.name || user?.name || "");
    if (!assignedById && !assignedByPhone && !assignedByName) {
      return NextResponse.json({ error: "This order is not assigned to you." }, { status: 403 });
    }
  }

  const latestClaim = await prisma.auditLog.findFirst({
    where: {
      entityType: "ORDER",
      entityId: order.id,
      action: "ORDER_DELIVERY_COLLECTION_RECORDED",
    },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const latestConfirm = await prisma.auditLog.findFirst({
    where: {
      entityType: "ORDER",
      entityId: order.id,
      action: "ORDER_DELIVERY_COLLECTION_CONFIRMED",
    },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (latestClaim && (!latestConfirm || latestConfirm.createdAt < latestClaim.createdAt)) {
    return NextResponse.json(
      { error: "A collection claim is already pending admin confirmation." },
      { status: 409 },
    );
  }

  await recordAuditLog({
    actorId: user?.id,
    action: "ORDER_DELIVERY_COLLECTION_RECORDED",
    entityType: "ORDER",
    entityId: order.id,
    meta: {
      amount: claimAmount,
      method: payload.method,
      reference: String(payload.reference || "").trim() || null,
      note: String(payload.note || "").trim() || null,
      status: "PENDING_ADMIN_CONFIRM",
      collectedAt: new Date().toISOString(),
      collectorRole: role,
      collectorId: user?.id || null,
      collectorName: user?.name || null,
    },
  });

  return NextResponse.json({ ok: true });
}

