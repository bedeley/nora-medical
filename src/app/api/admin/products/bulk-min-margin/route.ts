import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isAdminRole } from "@/lib/permissions";
import { PRODUCT_CATEGORIES } from "@/lib/product-categories";
import { recordAuditLog } from "@/lib/audit-log";
import { assertSameOrigin } from "@/lib/origin";

const payloadSchema = z.object({
  category: z.string().min(1),
  minMarginPct: z.number().min(0).nullable(),
  reason: z.string().min(5),
});

export async function POST(req: Request) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !isAdminRole(user?.role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = payloadSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload." }, { status: 400 });
  }

  const category = parsed.data.category.trim().toLowerCase();
  if (!PRODUCT_CATEGORIES.includes(category as (typeof PRODUCT_CATEGORIES)[number])) {
    return NextResponse.json({ error: "Unknown category." }, { status: 400 });
  }

  const { minMarginPct, reason } = parsed.data;

  try {
    const result = await prisma.product.updateMany({
      where: {
        category,
        archived: false,
        deletedAt: null,
      },
      data: {
        minMarginPct,
      },
    });

    try {
      await recordAuditLog({
        actorId: user?.id,
        action: "PRODUCT_MIN_MARGIN_BULK_UPDATE",
        entityType: "PRODUCT",
        entityId: "bulk",
        meta: {
          category,
          minMarginPct,
          updatedCount: result.count,
          reason,
        },
      });
    } catch {
      // best-effort
    }

    return NextResponse.json({
      success: true,
      count: result.count,
      message: `Updated ${result.count} product(s).`,
    });
  } catch (error) {
    console.error("Bulk min margin update failed:", error);
    return NextResponse.json({ error: "Failed to update minimum margin." }, { status: 500 });
  }
}
