import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(
  _req: Request,
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

  const params = await context.params;
  const latestVersion = await prisma.tenderVersion.findFirst({
    where: { tenderId: params.id },
    select: { versionNo: true, createdById: true, createdAt: true },
    orderBy: { versionNo: "desc" },
  });
  if (!latestVersion) {
    return NextResponse.json({ error: "Tender version not found" }, { status: 404 });
  }

  const latestApproval = await prisma.auditLog.findFirst({
    where: {
      entityType: "B2B_TENDER",
      entityId: params.id,
      action: "B2B_TENDER_APPROVED",
    },
    orderBy: { createdAt: "desc" },
    select: {
      actorId: true,
      createdAt: true,
      meta: true,
      actor: {
        select: { id: true, name: true, email: true },
      },
    },
  });

  let approvedVersionNo = 0;
  try {
    const parsed = latestApproval?.meta
      ? (JSON.parse(latestApproval.meta) as { approvedVersionNo?: number })
      : null;
    approvedVersionNo = Number(parsed?.approvedVersionNo || 0);
  } catch {
    approvedVersionNo = 0;
  }

  const requireApproval = process.env.B2B_TENDER_REQUIRE_APPROVAL !== "0";
  const makerChecker = process.env.B2B_TENDER_APPROVAL_MAKER_CHECKER !== "0";
  const protectedAdmins = String(process.env.PROTECTED_ADMIN_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  const actorEmail = String(user?.email || "").trim().toLowerCase();
  const isProtectedAdmin = !!actorEmail && protectedAdmins.includes(actorEmail);
  const isApprovedForLatest = approvedVersionNo >= latestVersion.versionNo;
  const sameUserAsLatestVersionEditor = Boolean(
    latestApproval?.actorId &&
      latestVersion.createdById &&
      latestApproval.actorId === latestVersion.createdById,
  );
  const makerCheckerViolation =
    makerChecker && !isProtectedAdmin && isApprovedForLatest && sameUserAsLatestVersionEditor;

  return NextResponse.json({
    tenderId: params.id,
    requireApproval,
    makerChecker,
    isProtectedAdmin,
    latestVersionNo: latestVersion.versionNo,
    latestVersionCreatedAt: latestVersion.createdAt.toISOString(),
    approvedVersionNo,
    approvedAt: latestApproval?.createdAt?.toISOString() || null,
    approvedById: latestApproval?.actorId || null,
    approvedByName: latestApproval?.actor?.name || latestApproval?.actor?.email || null,
    isApprovedForLatest,
    canSend: !requireApproval || (isApprovedForLatest && !makerCheckerViolation),
    makerCheckerViolation,
    reason:
      !requireApproval
        ? "Approval gate disabled."
        : !isApprovedForLatest
          ? "Latest version is not approved."
          : makerCheckerViolation
            ? "Maker-checker rule violated: approver must differ from editor of latest version."
            : "Approved for send.",
  });
}
