import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { downloadFileFromR2 } from "@/lib/r2-storage";
import { recordAuditLog } from "@/lib/audit-log";
import {
  EMPLOYEE_PORTAL_HOME_PAGE,
  getEmployeePortalDocument,
} from "@/lib/employee-portal";

export const runtime = "nodejs";

type StorageLocation =
  | { type: "r2"; key: string }
  | { type: "local"; urlPath: string }
  | { type: "url"; url: string }
  | { type: "unknown" };

function parseStorageLocation(fileUrl: string): StorageLocation {
  const value = String(fileUrl || "").trim();
  if (!value) return { type: "unknown" };
  if (value.startsWith("r2://")) {
    const key = value.slice("r2://".length);
    return key ? { type: "r2", key } : { type: "unknown" };
  }
  if (value.startsWith("/uploads/")) {
    return { type: "local", urlPath: value };
  }
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return { type: "url", url: value };
  }
  return { type: "unknown" };
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
  if (!doc) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }
  if (!doc.employeeVisible) {
    return NextResponse.json({ error: "Document not available in the portal." }, { status: 404 });
  }

  try {
    await recordAuditLog({
      actorId: user.id,
      action: "HR_DOCUMENT_DOWNLOAD",
      entityType: "EMPLOYEE_DOCUMENT",
      entityId: doc.id,
      meta: {
        page: EMPLOYEE_PORTAL_HOME_PAGE,
        sourcePage: EMPLOYEE_PORTAL_HOME_PAGE,
        section: "employee-portal-documents",
        operation: "download_document",
        before: null,
        after: {
          employeeId: doc.employeeId,
          title: doc.title,
          fileType: doc.fileType,
          uploadedAt: doc.uploadedAt?.toISOString?.() ?? null,
        },
        status: "SUCCESS",
        resultSummary: "Employee document download started.",
      },
    });
  } catch {
    // best-effort
  }

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
        ...(downloaded.contentLength ? { "Content-Length": String(downloaded.contentLength) } : {}),
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
