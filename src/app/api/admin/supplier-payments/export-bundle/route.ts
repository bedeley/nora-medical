import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { hasPermission } from "@/lib/permissions";
import { createZip } from "@/lib/zip";
import { recordAuditLog } from "@/lib/audit-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  baseName: z.string().min(3).max(120),
  scopeSnapshot: z.string().min(3).max(1200).optional(),
  sourcePage: z.string().min(3).max(160).optional(),
  currentViewCsv: z.string().min(1),
  summaryCsv: z.string().min(1),
  emailSummaryText: z.string().min(1),
  notesText: z.string().optional(),
});

function csvStats(content: string) {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) return { rows: 0, columns: 0 };
  const lines = normalized.split("\n");
  const header = lines[0] || "";
  const columns = header ? header.split(",").length : 0;
  const rows = Math.max(0, lines.length - 1);
  return { rows, columns };
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  if (!session || !hasPermission(role, "supplierPayments.manage")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "admin-supplier-payables-bundle-export", 60_000, 20);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { baseName, scopeSnapshot, sourcePage, currentViewCsv, summaryCsv, emailSummaryText, notesText } = parsed.data;
  const safeBase = baseName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 48);
  const currentView = csvStats(currentViewCsv);
  const summaryView = csvStats(summaryCsv);
  const generatedAt = new Date().toISOString();
  const readmeText =
    notesText ||
    "Supplier payables export bundle\nContains: current-view CSV, summary CSV, and email-summary text.\n";
  const files = [
    { name: "current_view.csv", data: Buffer.from(currentViewCsv, "utf8") },
    { name: "summary.csv", data: Buffer.from(summaryCsv, "utf8") },
    { name: "email_summary.txt", data: Buffer.from(emailSummaryText, "utf8") },
    {
      name: "readme.txt",
      data: Buffer.from(readmeText, "utf8"),
    },
  ];
  const zip = createZip(files);
  const fileManifest = files.map((f) => ({ name: f.name, bytes: f.data.length }));

  await recordAuditLog({
    actorId: user?.id || null,
    action: "SUPPLIER_PAYABLES_EXPORT_BUNDLE",
    entityType: "SUPPLIER_PAYMENT",
    entityId: "SUMMARY",
    request: req,
    meta: {
      baseName: safeBase,
      generatedAt,
      fileCount: files.length,
      byteSize: zip.length,
      fileManifest,
      currentViewRows: currentView.rows,
      currentViewColumns: currentView.columns,
      summaryRows: summaryView.rows,
      summaryColumns: summaryView.columns,
      emailSummaryChars: emailSummaryText.length,
      notesIncluded: Boolean(notesText && notesText.trim()),
      notesChars: readmeText.length,
      actorName: user?.name || null,
      actorEmail: user?.email || null,
      actorRole: user?.role || null,
      sourcePage: sourcePage || "admin/supplier-payments",
      section: "exports",
      operation: "export_supplier_payables_bundle",
      scopeSnapshot: scopeSnapshot || null,
      resultSummary: `Exported ${files.length} files (${zip.length} bytes total).`,
    },
  });

  return new NextResponse(zip, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename=\"${safeBase}.zip\"`,
      "Cache-Control": "no-store",
    },
  });
}
