import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";
import {
  canStaffOpenShiftNow,
  getLatestOtcShiftCloseGlobal,
  getOtcShiftDayStatus,
  getUtcTodayYmd,
} from "@/lib/otc-shift-close";

const openSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  note: z.string().max(500).optional(),
  openingCashFloat: z.number().min(0).optional(),
  handoverAcknowledged: z.boolean().optional(),
  handoverFromShiftCloseId: z.string().optional(),
  handoverChecklist: z
    .object({
      cashCountVerified: z.boolean().optional(),
      paymentSummaryVerified: z.boolean().optional(),
      pendingItemsReviewed: z.boolean().optional(),
      notes: z.string().max(500).optional(),
    })
    .optional(),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  if (!session || (!isAdmin && !isStaff)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-otc-shift-open", 60_000, 20);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const parsed = openSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }

    const day = parsed.data.day || getUtcTodayYmd();
    const openingCashFloat = Number(parsed.data.openingCashFloat || 0);
    const now = new Date();
    if (isStaff && !canStaffOpenShiftNow(now)) {
      return NextResponse.json(
        {
          error: "Staff can open OTC shift only after 06:00.",
          code: "SHIFT_OPEN_TIME_RESTRICTED",
          openWindowStartHourUtc: 6,
        },
        { status: 403 },
      );
    }

    const status = await getOtcShiftDayStatus(day);
    if (status.isOpen) {
      return NextResponse.json({
        success: true,
        alreadyOpen: true,
        day,
        shiftOpenId: status.openEventId,
      });
    }
    if (status.isClosed && !isAdmin) {
      return NextResponse.json(
        {
          error: "Shift is already closed for this day. Staff cannot reopen.",
          code: "SHIFT_CLOSED_STAFF_CANNOT_REOPEN",
          day,
        },
        { status: 403 },
      );
    }

    const latestClose = await getLatestOtcShiftCloseGlobal();
    if (latestClose?.entityId && !status.isOpen) {
      if (!parsed.data.handoverAcknowledged) {
        return NextResponse.json(
          {
            error: "Handover acknowledgment is required before opening shift.",
            code: "SHIFT_HANDOVER_REQUIRED",
            requiredShiftCloseId: latestClose.entityId,
          },
          { status: 400 },
        );
      }
      if (
        parsed.data.handoverFromShiftCloseId &&
        parsed.data.handoverFromShiftCloseId !== latestClose.entityId
      ) {
        return NextResponse.json(
          {
            error: "Handover reference does not match latest closed shift.",
            code: "SHIFT_HANDOVER_MISMATCH",
            requiredShiftCloseId: latestClose.entityId,
          },
          { status: 400 },
        );
      }
      const checklist = parsed.data.handoverChecklist;
      if (
        !checklist?.cashCountVerified ||
        !checklist?.paymentSummaryVerified ||
        !checklist?.pendingItemsReviewed
      ) {
        return NextResponse.json(
          {
            error:
              "Handover checklist is required (cash count, payment summary, pending items).",
            code: "SHIFT_HANDOVER_CHECKLIST_REQUIRED",
          },
          { status: 400 },
        );
      }
    }

    const shiftOpenId = randomUUID();
    const openedAtIso = now.toISOString();
    const utcOffset = openedAtIso.endsWith("Z")
      ? "+00:00"
      : openedAtIso.slice(-6);
    await recordAuditLog({
      actorId: user?.id || null,
      action: "OTC_SHIFT_OPEN",
      entityType: "OTC_SHIFT",
      entityId: shiftOpenId,
      meta: {
        day,
        note: parsed.data.note?.trim() || null,
        openingCashFloat,
        handoverAcknowledged: Boolean(parsed.data.handoverAcknowledged),
        handover: latestClose?.entityId
          ? {
              fromShiftCloseId:
                parsed.data.handoverFromShiftCloseId || latestClose.entityId || null,
              fromActorId: latestClose.actorId || null,
              fromActorName: latestClose.actor?.name || null,
              fromActorEmail: latestClose.actor?.email || null,
              toActorId: user?.id || null,
              toActorName: user?.name || null,
              toActorEmail: user?.email || null,
              checklist: {
                cashCountVerified: Boolean(
                  parsed.data.handoverChecklist?.cashCountVerified,
                ),
                paymentSummaryVerified: Boolean(
                  parsed.data.handoverChecklist?.paymentSummaryVerified,
                ),
                pendingItemsReviewed: Boolean(
                  parsed.data.handoverChecklist?.pendingItemsReviewed,
                ),
                notes: parsed.data.handoverChecklist?.notes?.trim() || null,
              },
            }
          : null,
        previousShiftCloseId: latestClose?.entityId || null,
        openedAt: openedAtIso,
        openedAtTimezoneOffset: utcOffset,
      },
    });

    return NextResponse.json({
      success: true,
      day,
      shiftOpenId,
    });
  } catch (error) {
    console.error("OTC shift open error:", error);
    return NextResponse.json({ error: "Failed to open OTC shift" }, { status: 500 });
  }
}
