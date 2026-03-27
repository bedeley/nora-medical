import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { getGhanaStatutoryConfigFromSettings } from "@/lib/hr-ghana-statutory";

export async function GET() {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const secret = (process.env.HR_PAYROLL_CRON_SECRET || "").trim();
  const hasSecret = Boolean(secret);
  const ghanaConfig = await getGhanaStatutoryConfigFromSettings();
  const hasTax = Array.isArray(ghanaConfig.payeBands) && ghanaConfig.payeBands.length > 0;
  const hasPension = Number.isFinite(ghanaConfig.ssnitEmployeeRate) && ghanaConfig.ssnitEmployeeRate >= 0;

  return NextResponse.json({
    enabled: hasSecret && hasTax && hasPension,
    hasSecret,
    hasTax,
    hasPension,
  });
}
