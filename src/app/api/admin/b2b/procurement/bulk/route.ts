import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";
import {
  notifyCustomerProcurementAssigned,
  notifyCustomerProcurementStatusUpdated,
  type ProcurementRequestSnapshot,
} from "@/lib/b2b-procurement-notifications";

const SOURCE_PAGE = "admin/b2b/procurement";
const MAX_BULK = 100;

const schema = z.object({
  action: z.enum(["assign", "status"]),
  ids: z.array(z.string().min(1)).min(1).max(MAX_BULK),
  accountManagerId: z.string().min(1).optional(),
  status: z.enum(["IN_REVIEW", "QUOTED", "APPROVED", "REJECTED", "CLOSED"]).optional(),
  note: z.string().max(1000).optional(),
});

function parseSnapshot(meta: string | null): ProcurementRequestSnapshot | null {
  if (!meta) return null;
  try {
    const parsed = JSON.parse(meta) as { snapshot?: ProcurementRequestSnapshot };
    return parsed.snapshot ?? null;
  } catch {
    return null;
  }
}

async function getCurrentSnapshot(requestId: string): Promise<ProcurementRequestSnapshot | null> {
  const last = await prisma.auditLog.findFirst({
    where: {
      entityType: "B2B_PROCUREMENT_REQUEST",
      entityId: requestId,
      action: {
        in: [
          "B2B_PROCUREMENT_REQUEST_CREATED",
          "B2B_PROCUREMENT_REQUEST_ASSIGNED",
          "B2B_PROCUREMENT_REQUEST_STATUS_UPDATED",
        ],
      },
    },
    orderBy: { createdAt: "desc" },
  });
  return parseSnapshot(last?.meta || null);
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  if (!session || (!isAdmin && !isStaff)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "admin-b2b-procurement-bulk", 60_000, 30);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  const { action, ids, note } = parsed.data;

  if (action === "assign" && !parsed.data.accountManagerId) {
    return NextResponse.json({ error: "accountManagerId required for assign action" }, { status: 400 });
  }
  if (action === "status" && !parsed.data.status) {
    return NextResponse.json({ error: "status required for status action" }, { status: 400 });
  }

  const actor = user?.id
    ? await prisma.user.findUnique({ where: { id: user.id }, select: { name: true, email: true } })
    : null;

  let manager: { id: string; name: string | null; email: string | null } | null = null;
  if (action === "assign" && parsed.data.accountManagerId) {
    manager = await prisma.user.findUnique({
      where: { id: parsed.data.accountManagerId },
      select: { id: true, name: true, email: true },
    });
    if (!manager) {
      return NextResponse.json({ error: "Manager not found" }, { status: 404 });
    }
  }

  type ItemResult = { id: string; ok: boolean; error?: string; autoPromoted?: boolean };
  const results: ItemResult[] = [];
  let successCount = 0;
  let failCount = 0;

  for (const requestId of ids) {
    try {
      const current = await getCurrentSnapshot(requestId);
      if (!current) {
        results.push({ id: requestId, ok: false, error: "Not found" });
        failCount++;
        continue;
      }

      if (action === "assign") {
        const accountManagerId = parsed.data.accountManagerId!;
        if (current.status === "REJECTED" || current.status === "CLOSED") {
          results.push({ id: requestId, ok: false, error: `${current.status} - reopen first` });
          failCount++;
          continue;
        }
        const previousStatus = current.status;
        const autoPromoted = previousStatus === "SUBMITTED";
        const next: ProcurementRequestSnapshot = {
          ...current,
          status: autoPromoted ? "IN_REVIEW" : current.status,
          accountManagerId,
          updatedAt: new Date().toISOString(),
        };
        const notification = await notifyCustomerProcurementAssigned(
          next,
          actor?.name || actor?.email || null,
          manager?.name || manager?.email || null,
        ).catch(() => ({ attempted: true, channel: "none" as const, ok: false, detail: "Notification error" }));

        await recordAuditLog({
          actorId: user?.id || null,
          action: "B2B_PROCUREMENT_REQUEST_ASSIGNED",
          entityType: "B2B_PROCUREMENT_REQUEST",
          entityId: requestId,
          request: req,
          outcome: "SUCCESS",
          meta: {
            sourcePage: SOURCE_PAGE,
            section: "bulk",
            operation: "bulk_assign_manager",
            actor: { id: user?.id, role: user?.role, name: actor?.name || actor?.email || null },
            before: { status: previousStatus, accountManagerId: current.accountManagerId || null },
            after: { status: next.status, accountManagerId, managerName: manager?.name || manager?.email || null },
            autoPromoted,
            note: note?.trim() || null,
            clinicName: current.clinicName,
            notification: {
              ok: notification.ok,
              channel: notification.channel,
              attempted: notification.attempted,
              detail: notification.ok ? undefined : notification.detail,
            },
            status: "SUCCESS",
            resultSummary: `Bulk assign: manager set for ${current.clinicName}.`,
          },
        });
        results.push({ id: requestId, ok: true, autoPromoted });
        successCount++;
      } else {
        // action === "status"
        const nextStatus = parsed.data.status!;
        const isTerminal = current.status === "REJECTED" || current.status === "CLOSED";
        if (isTerminal) {
          results.push({ id: requestId, ok: false, error: `${current.status} - reopen first` });
          failCount++;
          continue;
        }
        if ((current.status === "QUOTED" || current.status === "APPROVED") && nextStatus === "IN_REVIEW") {
          results.push({ id: requestId, ok: false, error: "Cannot move QUOTED/APPROVED back to IN_REVIEW" });
          failCount++;
          continue;
        }
        if ((nextStatus === "QUOTED" || nextStatus === "APPROVED") && !current.accountManagerId) {
          results.push({ id: requestId, ok: false, error: "Assign a manager before QUOTED/APPROVED" });
          failCount++;
          continue;
        }
        const next: ProcurementRequestSnapshot = {
          ...current,
          status: nextStatus,
          updatedAt: new Date().toISOString(),
        };
        const notification = await notifyCustomerProcurementStatusUpdated(
          next,
          current.status,
          actor?.name || actor?.email || null,
        ).catch(() => ({ attempted: true, channel: "none" as const, ok: false, detail: "Notification error" }));

        await recordAuditLog({
          actorId: user?.id || null,
          action: "B2B_PROCUREMENT_REQUEST_STATUS_UPDATED",
          entityType: "B2B_PROCUREMENT_REQUEST",
          entityId: requestId,
          request: req,
          outcome: "SUCCESS",
          meta: {
            sourcePage: SOURCE_PAGE,
            section: "bulk",
            operation: "bulk_update_status",
            actor: { id: user?.id, role: user?.role, name: actor?.name || actor?.email || null },
            before: { status: current.status },
            after: { status: nextStatus },
            note: note?.trim() || null,
            clinicName: current.clinicName,
            notification: {
              ok: notification.ok,
              channel: notification.channel,
              attempted: notification.attempted,
              detail: notification.ok ? undefined : notification.detail,
            },
            status: "SUCCESS",
            resultSummary: `Bulk status: ${current.clinicName} moved from ${current.status} to ${nextStatus}.`,
          },
        });
        results.push({ id: requestId, ok: true });
        successCount++;
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unexpected error";
      results.push({ id: requestId, ok: false, error: errorMsg });
      failCount++;
    }
  }

  // Summary audit log for the bulk operation
  await recordAuditLog({
    actorId: user?.id || null,
    action: action === "assign"
      ? "B2B_PROCUREMENT_REQUEST_ASSIGNED"
      : "B2B_PROCUREMENT_REQUEST_STATUS_UPDATED",
    entityType: "B2B_PROCUREMENT_REQUEST",
    entityId: "bulk",
    request: req,
    outcome: failCount === 0 ? "SUCCESS" : successCount === 0 ? "FAILED" : "PARTIAL",
    meta: {
      sourcePage: SOURCE_PAGE,
      section: "bulk",
      operation: action === "assign" ? "bulk_assign_manager_summary" : "bulk_update_status_summary",
      actor: { id: user?.id, role: user?.role },
      totalRequested: ids.length,
      successCount,
      failCount,
      accountManagerId: parsed.data.accountManagerId || null,
      targetStatus: parsed.data.status || null,
      note: note?.trim() || null,
      status: failCount === 0 ? "SUCCESS" : successCount === 0 ? "FAILED" : "PARTIAL_SUCCESS",
      resultSummary: `Bulk ${action}: ${successCount} succeeded, ${failCount} failed out of ${ids.length} requests.`,
    },
  }).catch(() => {});

  return NextResponse.json({ successCount, failCount, results });
}
