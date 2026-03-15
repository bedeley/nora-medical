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
  created?: number;
  updated?: number;
  skipped?: number;
  bankIds?: string[];
  issuesCount?: number;
  issuesPreview?: Array<{ row: number; reason: string }>;
};

function parseMeta(raw: string | null): ImportMeta {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ImportMeta;
  } catch {
    return {};
  }
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  const bankId = parts[parts.length - 2] || "";
  if (!bankId) {
    return NextResponse.json({ error: "Missing bank id" }, { status: 400 });
  }

  const rows = await prisma.auditLog.findMany({
    where: {
      action: "IMPORT_EXPORT",
      entityType: "IMPORT_EXPORT",
      deletedAt: null,
    },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      actor: { select: { id: true, name: true, email: true } },
    },
  });

  const filtered = rows
    .map((row) => {
      const meta = parseMeta(row.meta || null);
      return { row, meta };
    })
    .filter(({ meta }) => {
      if (meta.action !== "IMPORT" || meta.resource !== "bankTransactions") return false;
      const bankIds = Array.isArray(meta.bankIds) ? meta.bankIds : [];
      return bankIds.includes(bankId);
    })
    .slice(0, 20)
    .map(({ row, meta }) => ({
      id: row.id,
      at: row.createdAt,
      actor: row.actor?.name || row.actor?.email || "Unknown",
      created: Number(meta.created || 0),
      updated: Number(meta.updated || 0),
      skipped: Number(meta.skipped || 0),
      issuesCount: Number(meta.issuesCount || 0),
      issuesPreview: Array.isArray(meta.issuesPreview) ? meta.issuesPreview : [],
    }));

  return NextResponse.json(filtered);
}

