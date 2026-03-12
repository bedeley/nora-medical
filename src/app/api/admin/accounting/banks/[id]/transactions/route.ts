import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";

const txnSchema = z.object({
  postedAt: z.string().min(1),
  amount: z.number(),
  description: z.string().max(255).optional(),
  reference: z.string().max(120).optional(),
  type: z.enum(["DEBIT", "CREDIT"]),
});

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

export async function GET(
  req: Request,
) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const bankId = new URL(req.url).pathname.split("/").filter(Boolean).at(-2);
  if (!bankId) {
    return NextResponse.json({ error: "Missing bank id" }, { status: 400 });
  }
  const txns = await prisma.bankTransaction.findMany({
    where: { bankAccountId: bankId },
    orderBy: [{ postedAt: "desc" }],
  });
  return NextResponse.json(txns);
}

export async function POST(
  req: Request,
) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const bankId = new URL(req.url).pathname.split("/").filter(Boolean).at(-2);
  if (!bankId) {
    return NextResponse.json({ error: "Missing bank id" }, { status: 400 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  try {
    const body = await req.json();
    const parsed = txnSchema.safeParse({
      ...body,
      amount: Number(body.amount),
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const txn = await prisma.bankTransaction.create({
      data: {
        bankAccountId: bankId,
        postedAt: new Date(parsed.data.postedAt),
        amount: parsed.data.amount,
        description: parsed.data.description,
        reference: parsed.data.reference,
        type: parsed.data.type,
      },
    });
    return NextResponse.json(txn);
  } catch (error) {
    console.error("Accounting bank transaction create error:", error);
    return NextResponse.json({ error: "Failed to create transaction" }, { status: 500 });
  }
}
