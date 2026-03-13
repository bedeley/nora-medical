import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { recordAuditLog } from "@/lib/audit-log";
import { randomUUID } from "crypto";
import { hasPermission } from "@/lib/permissions";
import { IMPORT_TEMPLATES } from "@/lib/import-export-schema";

export async function GET(
  _req: Request,
  context: { params: Promise<{ type: string }> | { type: string } },
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !hasPermission(user?.role, "import.data")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = await context.params;
  const key = params.type;
  const headers = IMPORT_TEMPLATES[key];
  if (!headers) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }

  await recordAuditLog({
    actorId: user?.id,
    action: "IMPORT_EXPORT",
    entityType: "IMPORT_EXPORT",
    entityId: randomUUID(),
    meta: {
      action: "TEMPLATE",
      resource: key,
      format: "csv",
    },
  });

  const body = `${headers.join(",")}\n`;
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename=${key}-template.csv`,
    },
  });
}
