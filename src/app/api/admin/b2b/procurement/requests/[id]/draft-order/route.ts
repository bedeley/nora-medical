import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";
import { buildProcurementOrderDraft } from "@/lib/b2b-procurement-draft";

const SOURCE_PAGE = "admin/b2b/procurement";

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
  const limited = await rateLimit(req, "admin-b2b-procurement-draft-order", 60_000, 60);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  const params = await context.params;
  const requestId = params.id;
  const draft = await buildProcurementOrderDraft(requestId);
  if (!draft) {
    await recordAuditLog({
      actorId: user?.id || null,
      action: "B2B_PROCUREMENT_REQUEST_DRAFT_ORDER_PREPARED",
      entityType: "B2B_PROCUREMENT_REQUEST",
      entityId: requestId,
      request: req,
      outcome: "FAILED",
      meta: {
        sourcePage: SOURCE_PAGE,
        section: "draft-order",
        operation: "prepare_draft_order",
        actor: { id: user?.id, role: user?.role, email: user?.email || null, name: user?.name || null },
        status: "FAILED",
        resultSummary: "Draft order preparation failed: request not found.",
      },
    });
    return NextResponse.json({ error: "Request not found" }, { status: 404 });
  }
  if (!["QUOTED", "APPROVED"].includes(draft.status)) {
    await recordAuditLog({
      actorId: user?.id || null,
      action: "B2B_PROCUREMENT_REQUEST_DRAFT_ORDER_PREPARED",
      entityType: "B2B_PROCUREMENT_REQUEST",
      entityId: requestId,
      request: req,
      outcome: "FAILED",
      meta: {
        sourcePage: SOURCE_PAGE,
        section: "draft-order",
        operation: "prepare_draft_order",
        actor: { id: user?.id, role: user?.role, email: user?.email || null, name: user?.name || null },
        clinicName: draft.clinicName ?? null,
        requestStatus: draft.status,
        status: "FAILED",
        resultSummary: `Draft order preparation blocked: request status is ${draft.status}.`,
      },
    });
    return NextResponse.json(
      { error: "Request must be in QUOTED or APPROVED status before conversion." },
      { status: 400 },
    );
  }
  if (draft.lines.length === 0) {
    await recordAuditLog({
      actorId: user?.id || null,
      action: "B2B_PROCUREMENT_REQUEST_DRAFT_ORDER_PREPARED",
      entityType: "B2B_PROCUREMENT_REQUEST",
      entityId: requestId,
      request: req,
      outcome: "FAILED",
      meta: {
        sourcePage: SOURCE_PAGE,
        section: "draft-order",
        operation: "prepare_draft_order",
        actor: { id: user?.id, role: user?.role, email: user?.email || null, name: user?.name || null },
        clinicName: draft.clinicName ?? null,
        requestStatus: draft.status,
        itemsSource: draft.itemsSource,
        matchedCount: draft.matchedCount,
        unmatchedCount: draft.unmatchedCount,
        totalLines: draft.lines.length,
        status: "FAILED",
        resultSummary: "Draft order preparation blocked: no parsed item lines found.",
      },
    });
    return NextResponse.json(
      { error: "No parsed item lines found. Update item list/template and try again.", draft },
      { status: 400 },
    );
  }

  await recordAuditLog({
    actorId: user?.id || null,
    action: "B2B_PROCUREMENT_REQUEST_DRAFT_ORDER_PREPARED",
    entityType: "B2B_PROCUREMENT_REQUEST",
    entityId: requestId,
    request: req,
    outcome: "SUCCESS",
    meta: {
      sourcePage: SOURCE_PAGE,
      section: "draft-order",
      operation: "prepare_draft_order",
      actor: { id: user?.id, role: user?.role, email: user?.email || null, name: user?.name || null },
      draftPreparedAt: new Date().toISOString(),
      clinicName: draft.clinicName ?? null,
      requestStatus: draft.status,
      itemsSource: draft.itemsSource,
      matchedCount: draft.matchedCount,
      unmatchedCount: draft.unmatchedCount,
      canPrefill: draft.canPrefill,
      totalLines: draft.lines.length,
      status: "SUCCESS",
      resultSummary: `Draft order prepared with ${draft.matchedCount} matched / ${draft.unmatchedCount} unmatched lines.`,
    },
  });

  return NextResponse.json({
    ok: true,
    warning: !draft.canPrefill
      ? "No matched products found. Draft loaded with unmatched lines for manual mapping."
      : undefined,
    draft,
  });
}
