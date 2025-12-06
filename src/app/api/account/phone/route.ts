import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";

export async function PATCH(req: Request) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const phone = String((body?.phone ?? "").toString()).trim();
    // Basic validation: 7+ digits after stripping non-digits; allow leading +
    const digits = phone.replace(/[^\d+]/g, "");
    const numeric = digits.replace(/[^\d]/g, "");
    if (!numeric || numeric.length < 7) {
      return NextResponse.json({ error: "Enter a valid phone number" }, { status: 400 });
    }

    const userId = (session.user as AuthenticatedUser).id;
    await prisma.user.update({ where: { id: userId }, data: { phone, phoneVerifiedAt: null } });
    return NextResponse.json({ ok: true, phone });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed to update phone";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
