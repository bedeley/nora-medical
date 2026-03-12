import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { postDeliverySettlementEntry } from "@/lib/accounting-posting";

type SettlementMeta = {
  settlementId?: string;
  settledAt?: string;
  receivedBy?: string;
  destination?: "CASH" | "BANK";
  reference?: string | null;
  note?: string | null;
  totalBalance?: number;
  totalClaimed?: number;
};

function parseMeta(raw?: string | null) {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SettlementMeta;
  } catch {
    return null;
  }
}

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-delivery-settlement-post", 60_000, 30);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isAccountant = role === "ACCOUNTANT";
  if (!session || (!isAdmin && !isAccountant)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = await context.params;
  const settlementId = params.id;
  const settlementLog = await prisma.auditLog.findFirst({
    where: {
      entityType: "DELIVERY_SETTLEMENT",
      entityId: settlementId,
      action: "DELIVERY_COLLECTION_SETTLEMENT_CREATED",
    },
    orderBy: { createdAt: "desc" },
  });
  if (!settlementLog) {
    return NextResponse.json({ error: "Settlement not found" }, { status: 404 });
  }

  const meta = parseMeta(settlementLog.meta);
  const amount = Number(meta?.totalBalance ?? meta?.totalClaimed ?? 0);
  if (!(amount > 0)) {
    return NextResponse.json({ ok: true, skipped: true, reason: "No settlement amount to post" });
  }

  try {
    const posted = await postDeliverySettlementEntry({
      settlementId,
      amount,
      settledAt: new Date(String(meta?.settledAt || settlementLog.createdAt.toISOString())),
      receivedBy: String(meta?.receivedBy || "").trim() || null,
      reference: String(meta?.reference || "").trim() || null,
      note: String(meta?.note || "").trim() || null,
      destination: meta?.destination === "BANK" ? "BANK" : "CASH",
    });

    await prisma.auditLog.create({
      data: {
        actorId: user?.id || null,
        action: "DELIVERY_COLLECTION_SETTLEMENT_POSTED",
        entityType: "DELIVERY_SETTLEMENT",
        entityId: settlementId,
        meta: JSON.stringify({
          posted: true,
          journalEntryId: posted?.id || null,
          amount,
        }),
      },
    });

    return NextResponse.json({
      ok: true,
      posted: Boolean(posted?.id),
      journalEntryId: posted?.id || null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to post settlement journal";
    await prisma.auditLog.create({
      data: {
        actorId: user?.id || null,
        action: "DELIVERY_COLLECTION_SETTLEMENT_POST_FAILED",
        entityType: "DELIVERY_SETTLEMENT",
        entityId: settlementId,
        meta: JSON.stringify({
          posted: false,
          error: message,
          amount,
        }),
      },
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
