import { NextResponse } from "next/server";
import { executeSupplierPayablesSummarySend } from "@/lib/supplier-payables-summary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { verifyCronSecret } = await import("@/lib/cron-auth");
  if (!verifyCronSecret(req, "SUPPLIER_PAYABLES_CRON_SECRET")) {
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

