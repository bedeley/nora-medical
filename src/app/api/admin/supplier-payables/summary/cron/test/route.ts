import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { executeSupplierPayablesSummarySend } from "@/lib/supplier-payables-summary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseRecipients(value: string | undefined) {
  if (!value) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value.split(/[,\n;]+/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  if (!session || !hasPermission(role, "supplierPayments.manage")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  return NextResponse.json({
    to: parseRecipients(process.env.SUPPLIER_PAYABLES_SUMMARY_TO),
    cc: parseRecipients(process.env.SUPPLIER_PAYABLES_SUMMARY_CC),
  });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  if (!session || !hasPermission(role, "supplierPayments.manage")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-supplier-payables-summary-cron-test", 60_000, 6);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  try {
    const result = await executeSupplierPayablesSummarySend({
      actorId: user?.id || null,
      auditAction: "SUPPLIER_PAYABLES_SUMMARY_CRON_TEST_SEND",
      subjectPrefix: "Supplier payables summary (test run)",
      sourcePage: "admin/supplier-payments",
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to send test summary." },
      { status: 500 },
    );
  }
}
