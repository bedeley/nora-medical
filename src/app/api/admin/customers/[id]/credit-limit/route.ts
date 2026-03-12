import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";

const schema = z.object({
  creditLimit: z.number().min(0),
});

export async function PUT(
  req: Request,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  if (!session || role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const params = await context.params;
  const userId = params.id;

  try {
    const body = await req.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid payload", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const creditLimit = Number(parsed.data.creditLimit);

    const updated = await prisma.balance.upsert({
      where: { userId },
      update: { creditLimit },
      create: { userId, creditLimit, totalDue: 0, totalPaid: 0, balance: 0 },
      select: { userId: true, creditLimit: true },
    });

    try {
      await recordAuditLog({
        actorId: user?.id,
        action: "CUSTOMER_CREDIT_LIMIT_UPDATE",
        entityType: "USER",
        entityId: userId,
        meta: { creditLimit },
      });
    } catch {
      // best-effort
    }

    return NextResponse.json({ success: true, creditLimit: updated.creditLimit });
  } catch (e) {
    console.error("Failed to update credit limit:", e);
    return NextResponse.json(
      { error: "Failed to update credit limit" },
      { status: 500 },
    );
  }
}
