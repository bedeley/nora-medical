import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { recordAuditLog } from "@/lib/audit-log";
import { findClosedPeriod } from "@/lib/accounting-periods";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { hasPermission } from "@/lib/permissions";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return hasPermission(role, "journal.post");
}

export async function POST(
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

  const url = new URL(req.url);
  const pathParts = url.pathname.split("/").filter(Boolean);
  const fallbackId = pathParts[pathParts.length - 2];
  const entryId = params?.id || fallbackId;
  if (!entryId) {
    return NextResponse.json({ error: "Missing entry id." }, { status: 400 });
  }

  try {
    const existing = await prisma.journalEntry.findUnique({
      where: { id: entryId },
      select: { entryDate: true, status: true, archivedAt: true },
    });
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (existing.status === "POSTED") {
      return NextResponse.json({ error: "Entry already posted." }, { status: 400 });
    }
    if (existing.archivedAt) {
      return NextResponse.json({ error: "Archived journal entries are read-only." }, { status: 400 });
    }
    const closedPeriod = await findClosedPeriod(existing.entryDate);
    if (closedPeriod) {
      return NextResponse.json(
        { error: `Period "${closedPeriod.name}" is closed.` },
        { status: 400 },
      );
    }
    const entry = await prisma.journalEntry.update({
      where: { id: entryId },
      data: {
        status: "POSTED",
        approvedById: (session.user as AuthenticatedUser).id,
        approvedAt: new Date(),
      },
    });
    await recordAuditLog({
      actorId: (session.user as AuthenticatedUser).id,
      action: "journal.post",
      entityType: "JournalEntry",
      entityId: entryId,
    });
    return NextResponse.json(entry);
  } catch (error) {
    console.error("Accounting journal post error:", error);
    return NextResponse.json({ error: "Failed to post journal entry" }, { status: 500 });
  }
}
