import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";

const schema = z.object({
  area: z.string().min(2).max(120),
  format: z.enum(["CSV", "PDF"]),
  fileName: z.string().min(3).max(220),
  scopeSnapshot: z.string().min(3).max(2000).optional(),
  sourcePage: z.string().min(3).max(120).optional(),
  resultSummary: z.string().min(3).max(240).optional(),
  rowCount: z.number().int().min(0).max(2_000_000).optional(),
  columnCount: z.number().int().min(0).max(2000).optional(),
  byteSize: z.number().int().min(0).max(500_000_000).optional(),
  matchingCount: z.number().int().min(0).max(2_000_000).optional(),
  totalCount: z.number().int().min(0).max(2_000_000).optional(),
  sortKey: z.string().min(1).max(80).optional(),
  sortDir: z.string().min(1).max(20).optional(),
  valuationMode: z.string().min(1).max(20).optional(),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAllowed = role === "ADMIN" || role === "ACCOUNTANT" || role === "STAFF";
  if (!session || !isAllowed) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-audit-export-log", 60_000, 100);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

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
    action: "ADMIN_EXPORT_DOWNLOAD",
    entityType: "REPORT",
    entityId: payload.area.toUpperCase().slice(0, 64),
    request: req,
    meta: {
      area: payload.area,
      format: payload.format,
      fileName: payload.fileName,
      rowCount: payload.rowCount ?? null,
      columnCount: payload.columnCount ?? null,
      byteSize: payload.byteSize ?? null,
      matchingCount: payload.matchingCount ?? null,
      totalCount: payload.totalCount ?? null,
      sortKey: payload.sortKey ?? null,
      sortDir: payload.sortDir ?? null,
      valuationMode: payload.valuationMode ?? null,
      scopeSnapshot: payload.scopeSnapshot || null,
      sourcePage: payload.sourcePage?.trim() || null,
      actorName: user?.name || null,
      actorEmail: user?.email || null,
      actorRole: user?.role || null,
      resultSummary:
        payload.resultSummary?.trim() ||
        `Downloaded ${payload.format} export: ${payload.fileName}`,
    },
  });

  return NextResponse.json({ ok: true });
}
