import { prisma } from "@/lib/prisma";

type AuditMeta = Record<string, unknown>;

export async function recordAuditLog(params: {
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  meta?: AuditMeta;
}) {
  const { actorId, action, entityType, entityId, meta } = params;
  try {
    await prisma.auditLog.create({
      data: {
        actorId: actorId || null,
        action,
        entityType,
        entityId,
        meta: meta ? JSON.stringify(meta) : null,
      },
    });
  } catch (e) {
    console.warn("auditLog error:", e);
  }
}

