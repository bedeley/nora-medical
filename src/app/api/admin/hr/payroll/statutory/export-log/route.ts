import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";

const schema = z.object({
  monthKey: z.string().min(7).max(7),
  liability: z.enum(["PAYE", "SSNIT", "MONTHLY_SUMMARY"]),
  fileName: z.string().min(5).max(220),
  format: z.enum(["csv"]),
  rowCount: z.number().int().min(0).max(2_000_000),
  columnCount: z.number().int().min(0).max(2000),
  byteSize: z.number().int().min(0).max(500_000_000),
  scopeSnapshot: z.string().min(1).max(2000),
  sourcePage: z.string().min(3).max(120).optional(),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-hr-payroll-remittance-export-log", 60_000, 100);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }
  const payload = parsed.data;
  const operation =
    payload.liability === "PAYE"
      ? "export_paye_schedule_csv"
      : payload.liability === "SSNIT"
        ? "export_ssnit_schedule_csv"
        : "export_monthly_remittance_summary_csv";

  await recordAuditLog({
    actorId: user.id,
    action: "HR_PAYROLL_REMITTANCE_EXPORT_CSV",
    entityType: "HRPayrollRemittance",
    entityId: payload.monthKey,
    meta: {
      actor: { id: user.id, role: user.role },
      sourcePage: payload.sourcePage?.trim() || "admin/hr/payroll/remittance",
      section: "statutory-remittance",
      operation,
      before: {
        month: payload.monthKey,
        liability: payload.liability,
      },
      after: {
        fileName: payload.fileName,
        format: payload.format,
        rowCount: payload.rowCount,
        columnCount: payload.columnCount,
        byteSize: payload.byteSize,
        scopeSnapshot: payload.scopeSnapshot,
      },
      status: "SUCCESS",
      resultSummary: `${payload.liability} remittance CSV export completed.`,
    },
  });

  return NextResponse.json({ ok: true });
}
