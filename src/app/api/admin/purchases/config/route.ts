import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";

const DEFAULT_PURCHASE_APPROVAL_QTY_THRESHOLD = 100;

export async function GET() {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = String(user?.role || "");
  if (!session || !hasPermission(role, "purchases.manage")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const purchaseApprovalQtyThreshold = Number(
    process.env.PURCHASE_APPROVAL_QTY_THRESHOLD || DEFAULT_PURCHASE_APPROVAL_QTY_THRESHOLD,
  );
  const supplierPaymentApprovalThreshold = Number(
    process.env.SUPPLIER_PAYMENT_APPROVAL_THRESHOLD || 0,
  );

  return NextResponse.json({
    purchaseApprovalQtyThreshold: Number.isFinite(purchaseApprovalQtyThreshold)
      ? purchaseApprovalQtyThreshold
      : DEFAULT_PURCHASE_APPROVAL_QTY_THRESHOLD,
    supplierPaymentApprovalThreshold: Number.isFinite(supplierPaymentApprovalThreshold)
      ? supplierPaymentApprovalThreshold
      : 0,
  });
}
