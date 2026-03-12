import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";

export async function GET() {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const secret = (process.env.HR_PAYROLL_CRON_SECRET || "").trim();
  const hasSecret = Boolean(secret);
  const hasTax = Boolean((process.env.HR_PAYROLL_TAX_PERCENT || "").trim());
  const hasPension = Boolean((process.env.HR_PAYROLL_PENSION_PERCENT || "").trim());

  return NextResponse.json({
    enabled: hasSecret && hasTax && hasPension,
    hasSecret,
    hasTax,
    hasPension,
  });
}
