import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";

const updateSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  bankName: z.string().max(120).optional().nullable(),
  accountNumberMasked: z.string().max(30).optional().nullable(),
  currency: z.string().max(8).optional(),
  isActive: z.boolean().optional(),
});

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } },
) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  try {
    const body = await req.json();
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const bank = await prisma.bankAccount.update({
      where: { id: params.id },
      data: parsed.data,
    });
    return NextResponse.json(bank);
  } catch (error) {
    console.error("Accounting bank update error:", error);
    return NextResponse.json({ error: "Failed to update bank" }, { status: 500 });
  }
}
