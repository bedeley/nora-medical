import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { isPrismaUniqueConstraintError } from "@/lib/prisma-errors";

const taxCodeSchema = z.object({
  name: z.string().trim().min(2).max(120),
  rate: z.number().min(0).max(100),
  type: z.enum(["OUTPUT", "INPUT", "EXEMPT", "ZERO"]),
  isActive: z.boolean().optional(),
});

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const codes = await prisma.taxCode.findMany({
    orderBy: [{ name: "asc" }],
  });
  return NextResponse.json(codes);
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  try {
    const body = await req.json();
    const parsed = taxCodeSchema.safeParse({
      ...body,
      rate: Number(body.rate),
      isActive: body.isActive ?? true,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const code = await prisma.taxCode.create({
      data: parsed.data,
    });
    return NextResponse.json(code);
  } catch (error) {
    if (isPrismaUniqueConstraintError(error)) {
      return NextResponse.json({ error: "A tax code with this name already exists." }, { status: 409 });
    }
    console.error("Accounting tax code create error:", error);
    return NextResponse.json({ error: "Failed to create tax code" }, { status: 500 });
  }
}
