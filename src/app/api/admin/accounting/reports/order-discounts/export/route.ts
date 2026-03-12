import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import {
  canViewOrderDiscountReport,
  loadOrderDiscountReport,
} from "../shared";

function esc(value: unknown) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !canViewOrderDiscountReport(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const start = searchParams.get("start");
  const end = searchParams.get("end");
  const customerType = searchParams.get("customerType");

  const payload = await loadOrderDiscountReport({ start, end, customerType });
  const lines: string[] = [];
  lines.push(
    [
      "Date",
      "Order ID",
      "Invoice",
      "Customer",
      "Customer Type",
      "Created By",
      "Status",
      "Gross Amount",
      "Discount Amount",
      "Net Amount",
      "Discount %",
      "Discount Reason",
    ].join(","),
  );

  for (const row of payload.rows) {
    lines.push(
      [
        row.createdAt,
        row.orderId,
        row.invoiceNumber || "",
        row.customerName,
        row.customerType,
        row.createdBy,
        row.status,
        row.grossAmount.toFixed(2),
        row.discountAmount.toFixed(2),
        row.total.toFixed(2),
        row.discountPct.toFixed(2),
        row.discountReason || "",
      ]
        .map(esc)
        .join(","),
    );
  }

  const csv = lines.join("\n");
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="order_discounts_${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
