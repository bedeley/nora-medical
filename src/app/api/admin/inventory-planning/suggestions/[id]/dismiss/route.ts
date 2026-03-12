import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";
import { rateLimit } from "@/lib/rate-limit";

const bodySchema = z.object({
  reason: z.string().max(300).optional().nullable(),
});

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const resolvedParams = await params;
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-inventory-plan-dismiss", 60_000, 30);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const suggestion = await prisma.restockSuggestion.update({
      where: { id: resolvedParams.id },
      data: {
        status: "dismissed",
        reason: parsed.data.reason ?? undefined,
      },
    });

    try {
      await recordAuditLog({
        actorId: (session.user as AuthenticatedUser).id,
        action: "INVENTORY_SUGGESTION_DISMISS",
        entityType: "RESTOCK_SUGGESTION",
        entityId: suggestion.id,
        meta: { productId: suggestion.productId },
      });
    } catch {
      // best-effort
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Inventory suggestion dismiss error:", error);
    return NextResponse.json({ error: "Failed to dismiss suggestion" }, { status: 500 });
  }
}
