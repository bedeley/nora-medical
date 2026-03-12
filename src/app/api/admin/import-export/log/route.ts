import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { recordAuditLog } from "@/lib/audit-log";
import { z } from "zod";
import { randomUUID } from "crypto";
import { hasPermission } from "@/lib/permissions";
import { assertSameOrigin } from "@/lib/origin";

const payloadSchema = z.object({
  action: z.enum(["EXPORT", "IMPORT", "TEMPLATE"]),
  resource: z.string().min(1),
  format: z.string().optional(),
  count: z.number().int().nonnegative().optional(),
  url: z.string().optional(),
});

export async function POST(req: Request) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const canImport = hasPermission(user?.role, "import.data");
  const canExport = hasPermission(user?.role, "export.data");
  if (!session || (!canImport && !canExport)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const parsed = payloadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const { action, resource, format, count, url } = parsed.data;
  await recordAuditLog({
    actorId: user?.id,
    action: "IMPORT_EXPORT",
    entityType: "IMPORT_EXPORT",
    entityId: randomUUID(),
    meta: {
      action,
      resource,
      format: format || undefined,
      count: typeof count === "number" ? count : undefined,
      url: url || undefined,
    },
  });

  return NextResponse.json({ ok: true });
}
