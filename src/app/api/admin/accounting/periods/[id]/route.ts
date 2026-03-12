import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { recordAuditLog } from "@/lib/audit-log";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { buildPeriodSnapshot } from "@/lib/accounting-snapshots";

const patchSchema = z.object({
  status: z.enum(["OPEN", "CLOSED"]),
  checklistConfirmed: z.boolean().optional(),
  overrideReason: z.string().trim().max(500).optional(),
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
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const period = await prisma.fiscalPeriod.findUnique({
      where: { id: params.id },
    });
    if (!period) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (parsed.data.status === "CLOSED") {
      const overrideReason = parsed.data.overrideReason?.trim() || "";
      if (!parsed.data.checklistConfirmed && !overrideReason) {
        return NextResponse.json(
          { error: "Complete the close checklist or provide an override reason." },
          { status: 400 },
        );
      }
      const draftCount = await prisma.journalEntry.count({
        where: {
          status: "DRAFT",
          entryDate: {
            gte: period.startDate,
            lte: period.endDate,
          },
        },
      });
      if (draftCount > 0) {
        return NextResponse.json(
          { error: `Cannot close period with ${draftCount} draft journal entr${draftCount === 1 ? "y" : "ies"}.` },
          { status: 400 },
        );
      }
    }

    const updated = await prisma.fiscalPeriod.update({
      where: { id: params.id },
      data: { status: parsed.data.status },
    });

    if (parsed.data.status === "CLOSED") {
      const existingSnapshot = await prisma.periodCloseSnapshot.findFirst({
        where: { periodId: updated.id },
      });
      if (!existingSnapshot) {
        const snapshotData = await buildPeriodSnapshot(updated.id);
        if (snapshotData) {
          await prisma.periodCloseSnapshot.create({
            data: {
              periodId: updated.id,
              data: snapshotData,
            },
          });
        }
      }
    }

    await recordAuditLog({
      actorId: (session.user as AuthenticatedUser).id,
      action: parsed.data.status === "CLOSED" ? "fiscal-period.close" : "fiscal-period.open",
      entityType: "FiscalPeriod",
      entityId: updated.id,
      meta: {
        name: updated.name,
        checklistConfirmed: Boolean(parsed.data.checklistConfirmed),
        overrideReason: parsed.data.overrideReason?.trim() || null,
      },
    });

    return NextResponse.json(updated);
  } catch (error) {
    console.error("Accounting period update error:", error);
    return NextResponse.json({ error: "Failed to update period" }, { status: 500 });
  }
}
