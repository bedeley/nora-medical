import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { recordAuditLog } from "@/lib/audit-log";
import { findClosedPeriod } from "@/lib/accounting-periods";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { hasPermission } from "@/lib/permissions";

const updateSchema = z.object({
  memo: z.string().max(500).optional(),
  status: z.enum(["DRAFT", "POSTED", "VOID"]).optional(),
});

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const entry = await prisma.journalEntry.findUnique({
    where: { id: params.id },
    include: {
      approvedBy: { select: { id: true, name: true, email: true } },
      lines: { include: { account: true, taxCode: true } },
    },
  });
  if (!entry) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(entry);
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

    const current = await prisma.journalEntry.findUnique({
      where: { id: params.id },
      select: { status: true, archivedAt: true, entryDate: true },
    });
    if (!current) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (current.archivedAt) {
      return NextResponse.json({ error: "Archived journal entries are read-only." }, { status: 400 });
    }
    if (current.status === "POSTED") {
      if (parsed.data.status === "DRAFT") {
        return NextResponse.json({ error: "Posted entries cannot be reverted to draft." }, { status: 400 });
      }
      if (parsed.data.memo !== undefined || (parsed.data.status && parsed.data.status !== "POSTED")) {
        return NextResponse.json({ error: "Posted entries are read-only." }, { status: 400 });
      }
    }
    const postingRequested = parsed.data.status === "POSTED" && current.status !== "POSTED";
    if (postingRequested) {
      if (current.status !== "DRAFT") {
        return NextResponse.json({ error: "Only draft entries can be posted." }, { status: 400 });
      }
      if (!hasPermission((session.user as AuthenticatedUser).role, "journal.post")) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      const closedPeriod = await findClosedPeriod(current.entryDate);
      if (closedPeriod) {
        return NextResponse.json(
          { error: `Period "${closedPeriod.name}" is closed.` },
          { status: 400 },
        );
      }
    }

    const entry = await prisma.journalEntry.update({
      where: { id: params.id },
      data: {
        ...parsed.data,
        approvedById: parsed.data.status === "POSTED" ? (session.user as AuthenticatedUser).id : undefined,
        approvedAt: parsed.data.status === "POSTED" ? new Date() : undefined,
      },
    });
    if (parsed.data.status === "POSTED") {
      await recordAuditLog({
        actorId: (session.user as AuthenticatedUser).id,
        action: "journal.post",
        entityType: "JournalEntry",
        entityId: params.id,
        meta: {
          via: "journal.patch",
          previousStatus: current.status,
          nextStatus: "POSTED",
        },
      });
    }
    return NextResponse.json(entry);
  } catch (error) {
    console.error("Accounting journal update error:", error);
    return NextResponse.json({ error: "Failed to update journal entry" }, { status: 500 });
  }
}
