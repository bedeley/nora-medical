import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { isPrismaRecordNotFoundError, isPrismaUniqueConstraintError } from "@/lib/prisma-errors";

const updateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  rate: z.number().min(0).max(100).optional(),
  type: z.enum(["OUTPUT", "INPUT", "EXEMPT", "ZERO"]).optional(),
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
    const parsed = updateSchema.safeParse({
      ...body,
      rate: body.rate !== undefined ? Number(body.rate) : undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const code = await prisma.taxCode.update({
      where: { id: params.id },
      data: parsed.data,
    });
    return NextResponse.json(code);
  } catch (error) {
    if (isPrismaRecordNotFoundError(error)) {
      return NextResponse.json({ error: "Tax code not found." }, { status: 404 });
    }
    if (isPrismaUniqueConstraintError(error)) {
      return NextResponse.json({ error: "A tax code with this name already exists." }, { status: 409 });
    }
    console.error("Accounting tax code update error:", error);
    return NextResponse.json({ error: "Failed to update tax code" }, { status: 500 });
  }
}
