import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";
import { buildProcurementOrderDraft } from "@/lib/b2b-procurement-draft";

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
  if (!draft) return NextResponse.json({ error: "Request not found" }, { status: 404 });
  if (!["QUOTED", "APPROVED"].includes(draft.status)) {
    return NextResponse.json(
      { error: "Request must be in QUOTED or APPROVED status before conversion." },
      { status: 400 },
    );
  }
  if (draft.lines.length === 0) {
    return NextResponse.json(
      { error: "No parsed item lines found. Update item list/template and try again.", draft },
      { status: 400 },
    );
  }

  await prisma.auditLog.create({
    data: {
      actorId: user?.id || null,
      action: "B2B_PROCUREMENT_REQUEST_DRAFT_ORDER_PREPARED",
      entityType: "B2B_PROCUREMENT_REQUEST",
      entityId: requestId,
      meta: JSON.stringify({
        draftPreparedAt: new Date().toISOString(),
        matchedCount: draft.matchedCount,
        unmatchedCount: draft.unmatchedCount,
        itemsSource: draft.itemsSource,
      }),
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
