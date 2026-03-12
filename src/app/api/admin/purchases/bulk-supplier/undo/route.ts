import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";
import { hasPermission } from "@/lib/permissions";

type UndoRow = { id: string; supplierId: string | null; supplier: string | null };

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = String(user?.role || "");
  const canManagePurchases = hasPermission(role, "purchases.manage");
  if (!session || !canManagePurchases) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "admin-purchase-bulk-supplier-undo", 60_000, 30);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  try {
    const body = (await req.json().catch(() => ({}))) as { rows?: UndoRow[] };
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) {
      return NextResponse.json({ error: "No rows to undo." }, { status: 400 });
    }

    const result = await prisma.$transaction(async (tx) => {
      let updatedCount = 0;
      for (const row of rows) {
        const id = String(row.id || "").trim();
        if (!id) continue;
        await tx.purchase.update({
          where: { id },
          data: {
            supplierId: row.supplierId ? String(row.supplierId) : null,
            supplier: row.supplier ? String(row.supplier) : null,
          },
        });
        updatedCount += 1;
      }
      return { updatedCount };
    });

    try {
      await recordAuditLog({
        actorId: user?.id ?? null,
        action: "PURCHASE_BULK_SUPPLIER_ASSIGN_UNDO",
        entityType: "PURCHASE",
        entityId: "BULK",
        meta: {
          restoredCount: result.updatedCount,
          rowIds: rows.map((r) => r.id),
        },
      });
    } catch {
      // best effort
    }

    return NextResponse.json({ ok: true, restoredCount: result.updatedCount });
  } catch (error) {
    console.error("Bulk supplier undo error:", error);
    return NextResponse.json({ error: "Failed to undo supplier assignment." }, { status: 500 });
  }
}

