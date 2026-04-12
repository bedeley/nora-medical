import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { hasPermission } from "@/lib/permissions";
import { recordAuditLog } from "@/lib/audit-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  action: z.enum([
    "SUPPLIER_PAYABLES_EXPORT_CURRENT_VIEW_CSV",
    "SUPPLIER_PAYABLES_EXPORT_CURRENT_VIEW_PDF",
    "SUPPLIER_PAYABLES_EXPORT_SUMMARY_CSV",
    "SUPPLIER_PAYABLES_EXPORT_SUMMARY_PDF",
  ]),
  format: z.enum(["CSV", "PDF"]),
  fileName: z.string().min(3).max(180),
  scopeSnapshot: z.string().min(3).max(1200).optional(),
  rowCount: z.number().int().min(0).max(200000).optional(),
  columnCount: z.number().int().min(0).max(200).optional(),
  byteSize: z.number().int().min(0).max(200_000_000).optional(),
  exportLabel: z.string().min(3).max(120).optional(),
  sourcePage: z.string().min(3).max(160).optional(),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  if (!session || !hasPermission(role, "supplierPayments.manage")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "admin-supplier-payables-export-log", 60_000, 40);
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
    action: payload.action,
    entityType: "SUPPLIER_PAYMENT",
    entityId: "SUMMARY",
    request: req,
    meta: {
      exportLabel: payload.exportLabel || null,
      format: payload.format,
      fileName: payload.fileName,
      sourcePage: payload.sourcePage || "admin/supplier-payments",
      section: "exports",
      operation: "export_supplier_payables_view",
      scopeSnapshot: payload.scopeSnapshot || null,
      rowCount: payload.rowCount ?? null,
      columnCount: payload.columnCount ?? null,
      byteSize: payload.byteSize ?? null,
      resultSummary: `Downloaded ${payload.format} export: ${payload.fileName}`,
      actorName: user?.name || null,
      actorEmail: user?.email || null,
      actorRole: user?.role || null,
    },
  });

  return NextResponse.json({ ok: true });
}
