import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { hasPermission } from "@/lib/permissions";
import { recordAuditLog } from "@/lib/audit-log";

const schema = z.object({
  fileName: z.string().min(3).max(180),
  rowCount: z.number().int().min(0).max(200000).optional(),
  columnCount: z.number().int().min(0).max(200).optional(),
  byteSize: z.number().int().min(0).max(50_000_000).optional(),
  scopeSnapshot: z.string().min(3).max(1200).optional(),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !hasPermission(user?.role, "inventory.adjust")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "admin-stock-adjustments-export-log", 60_000, 20);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const payload = parsed.data;
  await recordAuditLog({
    actorId: user?.id || null,
    action: "STOCK_ADJUSTMENTS_EXPORT_CSV",
    entityType: "PRODUCT",
    entityId: "SUMMARY",
    request: req,
    meta: {
      sourcePage: "admin/stock-adjustments",
      section: "recent-adjustments",
      operation: "export_stock_adjustments_csv",
      fileName: payload.fileName,
      format: "CSV",
      rowCount: payload.rowCount ?? null,
      columnCount: payload.columnCount ?? null,
      byteSize: payload.byteSize ?? null,
      scopeSnapshot: payload.scopeSnapshot || null,
      resultSummary: `Exported stock-adjustments CSV: ${payload.fileName}.`,
      actorName: user?.name || null,
      actorEmail: user?.email || null,
      actorRole: user?.role || null,
    },
  });

  return NextResponse.json({ ok: true });
}
