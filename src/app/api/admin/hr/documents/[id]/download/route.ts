import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { downloadFileFromR2 } from "@/lib/r2-storage";
import { createReadStream } from "fs";
import { stat } from "fs/promises";
import path from "path";
import { Readable } from "stream";

export const runtime = "nodejs";

type StorageLocation =
  | { type: "r2"; key: string }
  | { type: "local"; filePath: string }
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
    const filePath = path.join(process.cwd(), value.replace(/^\//, ""));
    return { type: "local", filePath };
  }
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return { type: "url", url: value };
  }
  return { type: "unknown" };
}

function contentTypeForExt(ext: string) {
  switch (ext.toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".pdf":
      return "application/pdf";
    case ".doc":
      return "application/msword";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    default:
      return "application/octet-stream";
  }
}

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session) return null;
  const user = session.user as AuthenticatedUser;
  if (user.role !== "ADMIN") return null;
  return user;
}

export async function GET(
  _req: Request,
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
    try {
      const info = await stat(location.filePath);
      const ext = path.extname(location.filePath);
      const fileName = path.basename(location.filePath);
      const stream = Readable.toWeb(createReadStream(location.filePath));
  return new Response(stream as unknown as ReadableStream<Uint8Array>, {
        status: 200,
        headers: {
          "Content-Type": contentTypeForExt(ext),
          "Content-Length": String(info.size),
          "Content-Disposition": `inline; filename="${fileName}"`,
        },
      });
    } catch (err) {
      console.error("HR document read error:", err);
      return NextResponse.json({ error: "Document not available" }, { status: 404 });
    }
  }

  if (location.type === "url") {
    return NextResponse.redirect(location.url);
  }

  return NextResponse.json({ error: "Unsupported document location" }, { status: 400 });
}
