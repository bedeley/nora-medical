import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import {
  canViewOrderDiscountReport,
  loadOrderDiscountReport,
} from "./shared";

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
  return NextResponse.json(payload);
}
