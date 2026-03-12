import { NextResponse } from "next/server";
import { executeSupplierPayablesSummarySend } from "@/lib/supplier-payables-summary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const configuredSecret = (
    process.env.SUPPLIER_PAYABLES_CRON_SECRET ||
    process.env.CRON_SECRET ||
    ""
  ).trim();
  const authHeader = req.headers.get("authorization") || "";
  const headerSecret = req.headers.get("x-cron-secret") || "";
  const providedSecret = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : headerSecret.trim();

  if (!configuredSecret || providedSecret !== configuredSecret) {
    return NextResponse.json({ enabled: false }, { status: 200 });
  }

  try {
    const result = await executeSupplierPayablesSummarySend({
      actorId: null,
      auditAction: "SUPPLIER_PAYABLES_SUMMARY_CRON_SEND",
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to send summary." },
      { status: 500 },
    );
  }
}

