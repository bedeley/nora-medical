import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { isCustomerB2B } from "@/lib/customer-profile";

const requestSchema = z.object({
  requestType: z.enum(["QUOTE", "PO_UPLOAD", "RECURRING_REORDER"]),
  clinicName: z.string().min(2).max(120),
  contactName: z.string().min(2).max(120),
  contactPhone: z.string().max(40).optional(),
  contactEmail: z.string().email().optional(),
  notes: z.string().max(2000).optional(),
  poDocumentUrl: z.string().max(1500).optional(),
  templateId: z.string().optional(),
  itemsText: z.string().max(6000).optional(),
});

function isAllowedDocumentRef(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return (
    trimmed.startsWith("/uploads/") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://")
  );
}

type ProcurementRequestSnapshot = {
  id: string;
  customerId: string;
  requestType: "QUOTE" | "PO_UPLOAD" | "RECURRING_REORDER";
  status: "SUBMITTED" | "IN_REVIEW" | "QUOTED" | "APPROVED" | "REJECTED" | "CLOSED";
  clinicName: string;
  contactName: string;
  contactPhone: string | null;
  contactEmail: string | null;
  notes: string | null;
  poDocumentUrl: string | null;
  templateId: string | null;
  itemsText: string | null;
  accountManagerId: string | null;
  createdAt: string;
  updatedAt: string;
};
type ReorderTemplateSnapshot = {
  id: string;
  customerId: string;
  name: string;
  notes: string | null;
  itemsText: string;
  cadence: "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "CUSTOM";
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

function parseSnapshot(meta: string | null) {
  if (!meta) return null;
  try {
    const parsed = JSON.parse(meta) as { snapshot?: ProcurementRequestSnapshot };
    return parsed.snapshot ?? null;
  } catch {
    return null;
  }
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = (session.user as AuthenticatedUser).id;
  if (!(await isCustomerB2B(userId))) {
    return NextResponse.json({ error: "Procurement portal is enabled for B2B customer profiles only." }, { status: 403 });
  }

  const created = await prisma.auditLog.findMany({
    where: {
      action: "B2B_PROCUREMENT_REQUEST_CREATED",
      entityType: "B2B_PROCUREMENT_REQUEST",
      actorId: userId,
    },
    select: { entityId: true },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  const ids = Array.from(new Set(created.map((row) => row.entityId)));
  if (ids.length === 0) return NextResponse.json({ items: [] });

  const logs = await prisma.auditLog.findMany({
    where: {
      entityType: "B2B_PROCUREMENT_REQUEST",
      entityId: { in: ids },
      action: {
        in: [
          "B2B_PROCUREMENT_REQUEST_CREATED",
          "B2B_PROCUREMENT_REQUEST_ASSIGNED",
          "B2B_PROCUREMENT_REQUEST_STATUS_UPDATED",
        ],
      },
    },
    orderBy: [{ entityId: "asc" }, { createdAt: "asc" }],
  });

  const latestById = new Map<string, ProcurementRequestSnapshot>();
  for (const log of logs) {
    const snapshot = parseSnapshot(log.meta);
    if (!snapshot) continue;
    if (snapshot.customerId !== userId) continue;
    latestById.set(log.entityId, snapshot);
  }

  const items = Array.from(latestById.values()).sort((a, b) =>
    a.updatedAt < b.updatedAt ? 1 : -1,
  );
  return NextResponse.json({ items });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "account-procurement-request-create", 60_000, 30);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  const user = session.user as AuthenticatedUser;
  if (!(await isCustomerB2B(user.id))) {
    return NextResponse.json({ error: "Procurement portal is enabled for B2B customer profiles only." }, { status: 403 });
  }
  const parsed = requestSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const id = `b2b-req-${randomUUID()}`;
  const payload = parsed.data;
  if (payload.poDocumentUrl && !isAllowedDocumentRef(payload.poDocumentUrl)) {
    return NextResponse.json({ error: "Invalid PO document reference" }, { status: 400 });
  }
  const templateId: string | null = payload.templateId || null;
  let resolvedItemsText = payload.itemsText?.trim() || "";
  if (templateId) {
    const tplLast = await prisma.auditLog.findFirst({
      where: {
        entityType: "B2B_REORDER_TEMPLATE",
        entityId: templateId,
        action: {
          in: [
            "B2B_REORDER_TEMPLATE_CREATED",
            "B2B_REORDER_TEMPLATE_UPDATED",
            "B2B_REORDER_TEMPLATE_ARCHIVED",
          ],
        },
      },
      orderBy: { createdAt: "desc" },
    });
    const tpl = parseSnapshot(tplLast?.meta || null) as ReorderTemplateSnapshot | null;
    if (!tpl || tpl.customerId !== user.id || !tpl.active) {
      return NextResponse.json({ error: "Selected recurring template is not available." }, { status: 400 });
    }
    if (!resolvedItemsText) resolvedItemsText = (tpl.itemsText || "").trim();
  }
  const snapshot: ProcurementRequestSnapshot = {
    id,
    customerId: user.id,
    requestType: payload.requestType,
    status: "SUBMITTED",
    clinicName: payload.clinicName.trim(),
    contactName: payload.contactName.trim(),
    contactPhone: payload.contactPhone?.trim() || null,
    contactEmail: payload.contactEmail?.trim() || null,
    notes: payload.notes?.trim() || null,
    poDocumentUrl: payload.poDocumentUrl?.trim() || null,
    templateId,
    itemsText: resolvedItemsText || null,
    accountManagerId: null,
    createdAt: now,
    updatedAt: now,
  };

  await prisma.auditLog.create({
    data: {
      actorId: user.id,
      action: "B2B_PROCUREMENT_REQUEST_CREATED",
      entityType: "B2B_PROCUREMENT_REQUEST",
      entityId: id,
      meta: JSON.stringify({
        snapshot,
        event: {
          by: user.id,
          at: now,
        },
      }),
    },
  });

  return NextResponse.json({ ok: true, requestId: id, snapshot });
}
