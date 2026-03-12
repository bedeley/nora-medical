import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { recordAuditLog } from "@/lib/audit-log";
import { findClosedPeriod } from "@/lib/accounting-periods";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { hasPermission } from "@/lib/permissions";

const approveSchema = z.object({
  entryIds: z.array(z.string().min(1)).min(1),
});

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return hasPermission(role, "journal.approve");
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
    const parsed = approveSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const entries = await prisma.journalEntry.findMany({
      where: { id: { in: parsed.data.entryIds }, status: "DRAFT", archivedAt: null },
      select: { id: true, entryDate: true },
    });

    const closed = [];
    for (const entry of entries) {
      const closedPeriod = await findClosedPeriod(entry.entryDate);
      if (closedPeriod) {
        closed.push(entry.id);
      }
    }
    if (closed.length > 0) {
      return NextResponse.json(
        { error: "Some entries are in closed periods.", closed },
        { status: 400 },
      );
    }

    const updated = await prisma.journalEntry.updateMany({
      where: { id: { in: entries.map((e) => e.id) }, status: "DRAFT" },
      data: {
        status: "POSTED",
        approvedById: (session.user as AuthenticatedUser).id,
        approvedAt: new Date(),
      },
    });

    for (const entryId of entries.map((e) => e.id)) {
      await recordAuditLog({
        actorId: (session.user as AuthenticatedUser).id,
        action: "journal.post",
        entityType: "JournalEntry",
        entityId: entryId,
      });
    }

    return NextResponse.json({ approved: updated.count });
  } catch (error) {
    console.error("Journal bulk approve error:", error);
    return NextResponse.json({ error: "Failed to approve entries" }, { status: 500 });
  }
}
