import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { downloadFileFromR2 } from "@/lib/r2-storage";

export const runtime = "nodejs";

type StorageLocation =
  | { type: "r2"; key: string }
  | { type: "local"; urlPath: string }
  | { type: "url"; url: string }
  | { type: "unknown" };

function parseStorageLocation(fileUrl: string): StorageLocation {
  const value = (fileUrl || "").trim();
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

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session) return null;
  const user = session.user as AuthenticatedUser;
  if (user.role !== "ADMIN") return null;
  return user;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const resolvedParams = await params;
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const doc = await prisma.employeeDocument.findUnique({
    where: { id: resolvedParams.id },
    select: { id: true, fileUrl: true, fileType: true, title: true },
  });
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

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

  return NextResponse.json({ error: "Unsupported document location" }, { status: 400 });
}
