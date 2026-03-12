import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type AssignmentMeta = {
  riderUserId?: string;
  riderName?: string;
  riderPhone?: string;
};

type DeliveryMeta = {
  status?: string;
  recipientName?: string;
  recipientPhone?: string;
  deliveryNote?: string;
  proofImageUrl?: string;
};

function parseMeta(raw?: string | null) {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseDate(val: string | null, endOfDay = false): Date | null {
  if (!val) return null;
  const d = new Date(`${val}${endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z"}`);
  return Number.isFinite(d.getTime()) ? d : null;
}

function csvEscape(v: unknown) {
  const s = String(v ?? "");
  return `"${s.replaceAll(`"`, `""`)}"`;
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  const isAccountant = role === "ACCOUNTANT";
  if (!session || (!isAdmin && !isStaff && !isAccountant)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") || "").trim().toLowerCase();
  const riderUserId = (searchParams.get("riderUserId") || "").trim();
  const podStatus = (searchParams.get("podStatus") || "ALL").toUpperCase();
  const hasProof = (searchParams.get("hasProof") || "ALL").toUpperCase();
  const from = parseDate(searchParams.get("from"));
  const to = parseDate(searchParams.get("to"), true);
  const format = (searchParams.get("format") || "json").toLowerCase();
  const page = Math.max(1, Number(searchParams.get("page") || 1));
  const pageSize = Math.min(100, Math.max(10, Number(searchParams.get("pageSize") || 25)));

  const deliveredOrders = await prisma.order.findMany({
    where: {
      deletedAt: null,
      status: { not: "CANCELLED" },
      deliveryStatus: "DELIVERED",
      ...(from || to
        ? {
            deliveredAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
    },
    select: {
      id: true,
      invoiceNumber: true,
      deliveredAt: true,
      createdAt: true,
      walkInName: true,
      walkInPhone: true,
      user: { select: { name: true, phone: true } },
    },
    orderBy: { deliveredAt: "desc" },
    take: 2000,
  });

  const orderIds = deliveredOrders.map((o) => o.id);
  const assignmentLogs = orderIds.length
    ? await prisma.auditLog.findMany({
        where: {
          entityType: "ORDER",
          entityId: { in: orderIds },
          action: "ORDER_DELIVERY_ASSIGN",
        },
        select: { entityId: true, meta: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      })
    : [];
  const deliveryLogs = orderIds.length
    ? await prisma.auditLog.findMany({
        where: {
          entityType: "ORDER",
          entityId: { in: orderIds },
          action: "ORDER_DELIVERY_STATUS_UPDATE",
        },
        select: { entityId: true, meta: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      })
    : [];

  const assignmentByOrder = new Map<string, AssignmentMeta>();
  for (const row of assignmentLogs) {
    if (assignmentByOrder.has(row.entityId)) continue;
    const meta = parseMeta(row.meta) as AssignmentMeta | null;
    assignmentByOrder.set(row.entityId, {
      riderUserId: String(meta?.riderUserId || "").trim() || undefined,
      riderName: String(meta?.riderName || "").trim() || undefined,
      riderPhone: String(meta?.riderPhone || "").trim() || undefined,
    });
  }

  const deliveryByOrder = new Map<string, DeliveryMeta>();
  for (const row of deliveryLogs) {
    if (deliveryByOrder.has(row.entityId)) continue;
    const meta = parseMeta(row.meta) as DeliveryMeta | null;
    if (String(meta?.status || "").toUpperCase() !== "DELIVERED") continue;
    deliveryByOrder.set(row.entityId, {
      status: "DELIVERED",
      recipientName: String(meta?.recipientName || "").trim() || undefined,
      recipientPhone: String(meta?.recipientPhone || "").trim() || undefined,
      deliveryNote: String(meta?.deliveryNote || "").trim() || undefined,
      proofImageUrl: String(meta?.proofImageUrl || "").trim() || undefined,
    });
  }

  const rows = deliveredOrders
    .map((order) => {
      const assignment = assignmentByOrder.get(order.id) || null;
      const pod = deliveryByOrder.get(order.id) || null;
      const podCaptured =
        !!String(pod?.recipientName || "").trim() ||
        !!String(pod?.recipientPhone || "").trim() ||
        !!String(pod?.proofImageUrl || "").trim();
      return {
        id: order.id,
        invoiceNumber: order.invoiceNumber || null,
        deliveredAt: (order.deliveredAt || order.createdAt).toISOString(),
        customerName: order.user?.name || order.walkInName || null,
        customerPhone: order.user?.phone || order.walkInPhone || null,
        riderUserId: assignment?.riderUserId || null,
        riderName: assignment?.riderName || "Unassigned",
        riderPhone: assignment?.riderPhone || null,
        podStatus: podCaptured ? "CAPTURED" : "MISSING",
        recipientName: pod?.recipientName || null,
        recipientPhone: pod?.recipientPhone || null,
        deliveryNote: pod?.deliveryNote || null,
        proofImageUrl: pod?.proofImageUrl || null,
      };
    })
    .filter((row) => (podStatus === "ALL" ? true : row.podStatus === podStatus))
    .filter((row) => {
      if (hasProof === "YES") return Boolean(String(row.proofImageUrl || "").trim());
      if (hasProof === "NO") return !String(row.proofImageUrl || "").trim();
      return true;
    })
    .filter((row) => (riderUserId ? String(row.riderUserId || "") === riderUserId : true))
    .filter((row) => {
      if (!q) return true;
      return (
        String(row.invoiceNumber || "").toLowerCase().includes(q) ||
        String(row.customerName || "").toLowerCase().includes(q) ||
        String(row.customerPhone || "").toLowerCase().includes(q) ||
        String(row.riderName || "").toLowerCase().includes(q) ||
        String(row.recipientName || "").toLowerCase().includes(q)
      );
    });

  if (format === "csv") {
    const lines: string[] = [];
    lines.push(
      [
        "Order ID",
        "Invoice",
        "Delivered At",
        "Customer",
        "Customer Phone",
        "Rider",
        "Rider Phone",
        "POD Status",
        "Recipient",
        "Recipient Phone",
        "Delivery Note",
        "Proof Image URL",
      ]
        .map(csvEscape)
        .join(","),
    );
    for (const row of rows) {
      lines.push(
        [
          row.id,
          row.invoiceNumber || "",
          row.deliveredAt,
          row.customerName || "",
          row.customerPhone || "",
          row.riderName || "",
          row.riderPhone || "",
          row.podStatus,
          row.recipientName || "",
          row.recipientPhone || "",
          row.deliveryNote || "",
          row.proofImageUrl || "",
        ]
          .map(csvEscape)
          .join(","),
      );
    }
    return new NextResponse(lines.join("\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename=delivery_pod_report_${Date.now()}.csv`,
      },
    });
  }

  const total = rows.length;
  const start = (page - 1) * pageSize;
  const items = rows.slice(start, start + pageSize);

  return NextResponse.json({
    items,
    total,
    page,
    pageSize,
    summary: {
      delivered: rows.length,
      podCaptured: rows.filter((r) => r.podStatus === "CAPTURED").length,
      podMissing: rows.filter((r) => r.podStatus === "MISSING").length,
    },
  });
}
