import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

type ImportMeta = {
  action?: string;
  resource?: string;
  bankIds?: string[];
  created?: number;
  updated?: number;
  skipped?: number;
  issuesCount?: number;
  issuesPreview?: Array<{ row: number; reason: string }>;
  issuesList?: Array<{ row: number; reason: string }>;
  outcomePreview?: {
    created?: Array<{ row: number; bankName?: string; date?: string; amount?: string; reference?: string }>;
    updated?: Array<{ row: number; bankName?: string; date?: string; amount?: string; reference?: string }>;
    skipped?: Array<{ row: number; reason?: string }>;
  };
};

function parseMeta(raw: string | null): ImportMeta {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ImportMeta;
  } catch {
    return {};
  }
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; runId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id: bankId, runId } = await params;
  if (!bankId || !runId) {
    return NextResponse.json({ error: "Missing bank id or run id" }, { status: 400 });
  }

  const row = await prisma.auditLog.findUnique({
    where: { id: runId },
    include: { actor: { select: { name: true, email: true } } },
  });
  if (!row || row.deletedAt) {
    return NextResponse.json({ error: "Import run not found." }, { status: 404 });
  }
  const meta = parseMeta(row.meta || null);
  const bankIds = Array.isArray(meta.bankIds) ? meta.bankIds : [];
  if (
    row.action !== "IMPORT_EXPORT" ||
    meta.action !== "IMPORT" ||
    meta.resource !== "bankTransactions" ||
    !bankIds.includes(bankId)
  ) {
    return NextResponse.json({ error: "Import run not found for this bank." }, { status: 404 });
  }

  return NextResponse.json({
    id: row.id,
    at: row.createdAt,
    actor: row.actor?.name || row.actor?.email || "Unknown",
    created: Number(meta.created || 0),
    updated: Number(meta.updated || 0),
    skipped: Number(meta.skipped || 0),
    issuesCount: Number(meta.issuesCount || 0),
    issuesPreview: Array.isArray(meta.issuesPreview) ? meta.issuesPreview : [],
    issuesList: Array.isArray(meta.issuesList) ? meta.issuesList : [],
    outcomePreview:
      meta.outcomePreview && typeof meta.outcomePreview === "object"
        ? {
            created: Array.isArray(meta.outcomePreview.created) ? meta.outcomePreview.created : [],
            updated: Array.isArray(meta.outcomePreview.updated) ? meta.outcomePreview.updated : [],
            skipped: Array.isArray(meta.outcomePreview.skipped) ? meta.outcomePreview.skipped : [],
          }
        : { created: [], updated: [], skipped: [] },
    replayHintUrl: `/admin/import-export?focusImport=bankTransactions&bankId=${encodeURIComponent(bankId)}`,
  });
}
