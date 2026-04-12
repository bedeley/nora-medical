import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";

const schema = z.object({
  note: z.string().max(500).optional(),
});

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  if (!session || (!isAdmin && !isStaff)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "admin-b2b-tender-approve", 60_000, 40);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  const params = await context.params;
  const protectedAdmins = String(process.env.PROTECTED_ADMIN_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  const actorEmail = String(user?.email || "").trim().toLowerCase();
  const isProtectedAdmin = !!actorEmail && protectedAdmins.includes(actorEmail);
  const latestVersion = await prisma.tenderVersion.findFirst({
    where: { tenderId: params.id },
    select: { versionNo: true, createdById: true, createdAt: true },
    orderBy: { versionNo: "desc" },
  });
  if (!latestVersion) {
    return NextResponse.json({ error: "No tender version found. Save tender first." }, { status: 409 });
  }

  const makerChecker = process.env.B2B_TENDER_APPROVAL_MAKER_CHECKER !== "0";
  if (
    makerChecker &&
    !isProtectedAdmin &&
    latestVersion.createdById &&
    latestVersion.createdById === (user?.id || null)
  ) {
    return NextResponse.json(
      { error: "Maker-checker rule: the latest editor cannot approve this tender." },
      { status: 409 },
    );
  }

  await prisma.auditLog.create({
    data: {
      actorId: user?.id || null,
      action: "B2B_TENDER_APPROVED",
      entityType: "B2B_TENDER",
      entityId: params.id,
      outcome: "SUCCESS",
      meta: JSON.stringify({
        sourcePage: "admin/b2b/tenders",
        operation: "approve_for_send",
        approvedVersionNo: latestVersion.versionNo,
        latestVersionCreatedAt: latestVersion.createdAt.toISOString(),
        protectedAdminBypass: makerChecker && isProtectedAdmin ? true : false,
        makerCheckerApplied: makerChecker && !isProtectedAdmin,
        note: parsed.data.note?.trim() || null,
        actor: { id: user?.id || null, email: user?.email || null, name: user?.name || null },
      }),
    },
  });

  return NextResponse.json({
    ok: true,
    tenderId: params.id,
    approvedVersionNo: latestVersion.versionNo,
    approvedAt: new Date().toISOString(),
  });
}
