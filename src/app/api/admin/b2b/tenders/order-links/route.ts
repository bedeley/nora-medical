import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  if (!session || (!isAdmin && !isStaff)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const idsRaw = (url.searchParams.get("ids") || "").trim();
  const ids = idsRaw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, 200);
  if (ids.length === 0) return NextResponse.json({ items: [] });

  const logs = await prisma.auditLog.findMany({
    where: {
      action: "B2B_TENDER_ORDER_CREATED",
      entityType: "B2B_TENDER",
      entityId: { in: ids },
    },
    orderBy: { createdAt: "desc" },
    select: {
      entityId: true,
      createdAt: true,
      meta: true,
    },
    take: 1000,
  });

  const firstByTender = new Map<string, { tenderId: string; orderId: string; createdAt: string }>();
  for (const log of logs) {
    if (firstByTender.has(log.entityId)) continue;
    let orderId = "";
    try {
      const meta = log.meta ? (JSON.parse(log.meta) as { orderId?: string }) : null;
      orderId = String(meta?.orderId || "").trim();
    } catch {
      orderId = "";
    }
    if (!orderId) continue;
    firstByTender.set(log.entityId, {
      tenderId: log.entityId,
      orderId,
      createdAt: log.createdAt.toISOString(),
    });
  }

  return NextResponse.json({
    items: Array.from(firstByTender.values()),
  });
}

