import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { downloadFileFromR2 } from "@/lib/r2-storage";
import {
  EMPLOYEE_PORTAL_DOCUMENTS_PAGE,
  getEmployeePortalDocument,
} from "@/lib/employee-portal";
import { recordAuditLog } from "@/lib/audit-log";

export const runtime = "nodejs";

type StorageLocation =
  | { type: "r2"; key: string }
  | { type: "local"; urlPath: string }
  | { type: "url"; url: string }
  | { type: "unknown" };

function parseStorageLocation(fileUrl: string): StorageLocation {
  const value = String(fileUrl || "").trim();
  if (!value) return { type: "unknown" };
  if (value.startsWith("r2://")) return { type: "r2", key: value.slice("r2://".length) };
  if (value.startsWith("/uploads/")) return { type: "local", urlPath: value };
  if (value.startsWith("http://") || value.startsWith("https://")) return { type: "url", url: value };
  return { type: "unknown" };
}

function isPreviewable(fileType: string | null | undefined) {
  const normalized = String(fileType || "").toLowerCase();
  return normalized.includes("pdf") || normalized.startsWith("image/");
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const resolvedParams = await params;
  if (!resolvedParams?.id) {
    return NextResponse.json({ error: "Document id is required." }, { status: 400 });
  }

  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const doc = await getEmployeePortalDocument(user.id, resolvedParams.id);
  if (!doc || !doc.employeeVisible) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }
  if (!isPreviewable(doc.fileType)) {
    return NextResponse.json({ error: "Preview is not available for this file type." }, { status: 400 });
  }

  await recordAuditLog({
    actorId: user.id,
    action: "HR_DOCUMENT_PREVIEW",
    entityType: "EMPLOYEE_DOCUMENT",
    entityId: doc.id,
    meta: {
      page: EMPLOYEE_PORTAL_DOCUMENTS_PAGE,
      sourcePage: EMPLOYEE_PORTAL_DOCUMENTS_PAGE,
      section: "employee-portal-documents",
      operation: "preview_document",
      before: null,
      after: {
        title: doc.title,
        fileType: doc.fileType,
      },
      status: "SUCCESS",
      resultSummary: "Employee document preview opened.",
    },
  });

  const location = parseStorageLocation(doc.fileUrl);
  if (location.type === "r2") {
    const downloaded = await downloadFileFromR2(location.key);
    if (!downloaded.ok) {
      return NextResponse.json({ error: downloaded.error }, { status: 500 });
    }
    return new Response(downloaded.body, {
      status: 200,
      headers: {
        "Content-Type": downloaded.contentType || "application/octet-stream",
        "Content-Disposition": "inline",
      },
    });
  }
  if (location.type === "local") {
    return NextResponse.redirect(new URL(location.urlPath, req.url));
  }
  if (location.type === "url") {
    return NextResponse.redirect(location.url);
  }

  return NextResponse.json({ error: "Unsupported document location." }, { status: 400 });
}
