import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { formatIdReadable } from "@/lib/utils";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { recordAuditLog } from "@/lib/audit-log";

export const runtime = "nodejs";
const normalizeBalance = (value: number) => (Math.abs(value) < 0.01 ? 0 : value);

export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  const isAccountant = role === "ACCOUNTANT";
  if (!session || (!isAdmin && !isStaff && !isAccountant)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = await context.params;
  const customerId = params.id;
  if (!customerId) {
    return NextResponse.json({ error: "Missing customer id" }, { status: 400 });
  }

  const { searchParams } = new URL(req.url);
  const format = (searchParams.get("format") || "csv").toLowerCase();

  const [customer, orders, payments] = await Promise.all([
    prisma.user.findUnique({
      where: { id: customerId },
      select: { id: true, email: true, name: true },
    }),
    prisma.order.findMany({
      where: { userId: customerId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        createdAt: true,
        total: true,
        amountPaid: true,
        balance: true,
        status: true,
      },
    }),
    prisma.payment.findMany({
      where: { userId: customerId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        orderId: true,
        createdAt: true,
        amount: true,
        status: true,
        refundDisposition: true,
        note: true,
      },
    }),
  ]);

  if (!customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  if (format !== "csv") {
    if (format !== "pdf") {
      return NextResponse.json({ customer, orders, payments });
    }

    const pdfDoc = await PDFDocument.create();
    let page = pdfDoc.addPage();
    let { width, height } = page.getSize();
    const margin = 40;
    let y = height - margin;

    const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    // Maps full ID -> short ID, used to build a legend of all IDs
    const orderIdLegend = new Map<string, string>();
    const paymentIdLegend = new Map<string, string>();

    const makeShortId = (id: string | null | undefined) => {
      const full = formatIdReadable(id ?? "");
      if (!full) return "";
      const parts = full.split("-");
      if (parts.length <= 3) return full;
      return `${parts.slice(0, 3).join("-")}-...`;
    };

    const ensureSpace = (needed: number) => {
      if (y - needed < margin) {
        page = pdfDoc.addPage();
        const size = page.getSize();
        width = size.width;
        height = size.height;
        y = height - margin;
      }
    };

    const drawLine = (
      text: string,
      opts?: { size?: number; bold?: boolean; center?: boolean },
    ) => {
      const size = opts?.size ?? 10;
      const font = opts?.bold ? fontBold : fontRegular;
      const textWidth = font.widthOfTextAtSize(text, size);
      const x = opts?.center
        ? margin + (width - margin * 2 - textWidth) / 2
        : margin;
      ensureSpace(size + 4);
      page.drawText(text, { x, y, size, font });
      y -= size + 4;
    };

    const truncateToWidth = (
      text: string,
      font: typeof fontRegular,
      size: number,
      maxWidth: number,
    ) => {
      const ellipsis = "…";
      if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
      if (maxWidth <= font.widthOfTextAtSize(ellipsis, size)) return ellipsis;
      let raw = text;
      while (
        raw.length > 1 &&
        font.widthOfTextAtSize(`${raw}${ellipsis}`, size) > maxWidth
      ) {
        raw = raw.slice(0, -1);
      }
      return `${raw}${ellipsis}`;
    };

    const drawColumns = (
      columns: Array<{
        text: string;
        x: number;
        size?: number;
        bold?: boolean;
        maxWidth?: number;
      }>,
    ) => {
      if (!columns.length) return;
      const size = columns[0]?.size ?? 9;
      ensureSpace(size + 4);
      columns.forEach((col) => {
        const font = col.bold ? fontBold : fontRegular;
        let text = col.text;
        if (col.maxWidth && col.maxWidth > 0) {
          text = truncateToWidth(text, font, size, col.maxWidth);
        }
        const textWidth = font.widthOfTextAtSize(text, size);
        const x = col.x - textWidth / 2;
        page.drawText(text, { x, y, size, font });
      });
      y -= size + 4;
    };

    const now = new Date();
    const readableId = formatIdReadable(customer.id);
    const displayName = customer.name || customer.email || readableId;
    const subtitle = customer.email
      ? `${displayName} · ${customer.email}`
      : displayName;

    drawLine("Customer Account Statement", {
      size: 16,
      bold: true,
      center: true,
    });
    drawLine(`Generated: ${now.toLocaleString()}`, {
      size: 10,
      center: true,
    });
    drawLine(subtitle, { size: 11, center: true });
    y -= 6;

    drawLine("Orders", { size: 12, bold: true });
    if (!orders.length) {
      drawLine("No orders on record.", { size: 9 });
    } else {
      const ordersCols = [
        { header: "Date", x: margin + 40, maxWidth: 60 },
        { header: "Order ID", x: margin + 190, maxWidth: 160 },
        { header: "Total", x: margin + 310, maxWidth: 60 },
        { header: "Paid", x: margin + 380, maxWidth: 60 },
        { header: "Balance", x: margin + 450, maxWidth: 60 },
        { header: "Status", x: margin + 520, maxWidth: 70 },
      ] as const;

      drawColumns(
        ordersCols.map((c) => ({
          text: c.header,
          x: c.x,
          size: 8,
          bold: true,
          maxWidth: c.maxWidth,
        })),
      );

      orders.forEach((o) => {
        const d = o.createdAt.toISOString().slice(0, 10);
        const fullOrderId = formatIdReadable(o.id);
        const shortOrderId = makeShortId(o.id);
        if (fullOrderId && shortOrderId && !orderIdLegend.has(fullOrderId)) {
          orderIdLegend.set(fullOrderId, shortOrderId);
        }
        const totalStr = Number(o.total || 0).toFixed(2);
        const paidStr = Number(o.amountPaid || 0).toFixed(2);
        const balanceStr = normalizeBalance(Number(o.balance || 0)).toFixed(2);
        const status = o.status;
        drawColumns([
          {
            text: d,
            x: ordersCols[0].x,
            size: 8,
            maxWidth: ordersCols[0].maxWidth,
          },
          {
            text: shortOrderId,
            x: ordersCols[1].x,
            size: 8,
            maxWidth: ordersCols[1].maxWidth,
          },
          {
            text: totalStr,
            x: ordersCols[2].x,
            size: 8,
            maxWidth: ordersCols[2].maxWidth,
          },
          {
            text: paidStr,
            x: ordersCols[3].x,
            size: 8,
            maxWidth: ordersCols[3].maxWidth,
          },
          {
            text: balanceStr,
            x: ordersCols[4].x,
            size: 8,
            maxWidth: ordersCols[4].maxWidth,
          },
          {
            text: status,
            x: ordersCols[5].x,
            size: 8,
            maxWidth: ordersCols[5].maxWidth,
          },
        ]);
      });
    }

    y -= 8;
    drawLine("Payments", { size: 12, bold: true });
    drawLine(
      "Note: Payment IDs in the table are shortened; see legend at bottom for full IDs.",
      { size: 7 },
    );
    if (!payments.length) {
      drawLine("No payments on record.", { size: 9 });
    } else {
      const paymentsCols = [
        { header: "Date", x: margin + 40, maxWidth: 60 },
        { header: "Payment ID", x: margin + 170, maxWidth: 150 },
        { header: "Orders", x: margin + 310, maxWidth: 180 },
        { header: "Amount", x: margin + 430, maxWidth: 70 },
        { header: "Status", x: margin + 520, maxWidth: 70 },
      ] as const;

      drawColumns(
        paymentsCols.map((c) => ({
          text: c.header,
          x: c.x,
          size: 8,
          bold: true,
          maxWidth: c.maxWidth,
        })),
      );

      payments.forEach((p) => {
        const d = p.createdAt.toISOString().slice(0, 10);
        const fullPaymentId = formatIdReadable(p.id);
        const shortPaymentId = makeShortId(p.id);
        if (fullPaymentId && shortPaymentId && !paymentIdLegend.has(fullPaymentId)) {
          paymentIdLegend.set(fullPaymentId, shortPaymentId);
        }
        const amtStr = Number(p.amount || 0).toFixed(2);
        const status = p.status || "";

        // Default label when payment is not tied to a specific order
        let orderLabel = "N/A";
        if (p.orderId) {
          const fullOrderId = formatIdReadable(p.orderId);
          const shortOrderId = makeShortId(p.orderId);
          orderLabel = shortOrderId;
          if (fullOrderId && shortOrderId && !orderIdLegend.has(fullOrderId)) {
            orderIdLegend.set(fullOrderId, shortOrderId);
          }
        } else if (p.note) {
          try {
            const meta = JSON.parse(p.note) as {
              applied?: Array<{ orderId?: string; applied?: number }>;
            };
            if (Array.isArray(meta.applied)) {
              const displayLabels: string[] = [];
              for (const a of meta.applied) {
                if (!a.orderId) continue;
                const fullOrderId = formatIdReadable(a.orderId);
                const shortOrderId = makeShortId(a.orderId);
                if (
                  fullOrderId &&
                  shortOrderId &&
                  !orderIdLegend.has(fullOrderId)
                ) {
                  orderIdLegend.set(fullOrderId, shortOrderId);
                }
                if (fullOrderId) {
                  displayLabels.push(fullOrderId.slice(0, 4));
                }
              }

              if (displayLabels.length === 1) {
                orderLabel = displayLabels[0];
              } else if (displayLabels.length > 1) {
                orderLabel = `Multiple: ${displayLabels.join(", ")}`;
              }
            }
          } catch {
            // ignore malformed meta
          }
        }

        drawColumns([
          {
            text: d,
            x: paymentsCols[0].x,
            size: 8,
            maxWidth: paymentsCols[0].maxWidth,
          },
          {
            text: shortPaymentId,
            x: paymentsCols[1].x,
            size: 8,
            maxWidth: paymentsCols[1].maxWidth,
          },
          {
            text: orderLabel,
            x: paymentsCols[2].x,
            size: 8,
            maxWidth: paymentsCols[2].maxWidth,
          },
          {
            text: amtStr,
            x: paymentsCols[3].x,
            size: 8,
            maxWidth: paymentsCols[3].maxWidth,
          },
          {
            text: status,
            x: paymentsCols[4].x,
            size: 8,
            maxWidth: paymentsCols[4].maxWidth,
          },
        ]);
      });
    }

    // Legend with full IDs so they can be copied
    y -= 12;
    if (orderIdLegend.size || paymentIdLegend.size) {
      drawLine("ID Legend (short -> full)", { size: 11, bold: true });
      if (orderIdLegend.size) {
        drawLine("Orders:", { size: 10, bold: true });
        orderIdLegend.forEach((short, full) => {
          drawLine(`${short}  =  ${full}`, { size: 8 });
        });
      }
      if (paymentIdLegend.size) {
        y -= 4;
        drawLine("Payments:", { size: 10, bold: true });
        paymentIdLegend.forEach((short, full) => {
          drawLine(`${short}  =  ${full}`, { size: 8 });
        });
      }
      y -= 6;
      drawLine(
        "Note: 'N/A' in the Order column means the payment is not tied to a specific order.",
        { size: 7 },
      );
    }

    // Add page numbers in footer
    const pages = pdfDoc.getPages();
    pages.forEach((p, idx) => {
      const { width: pw } = p.getSize();
      const label = `Page ${idx + 1} of ${pages.length}`;
      const size = 8;
      const font = fontRegular;
      const textWidth = font.widthOfTextAtSize(label, size);
      const x = pw - margin - textWidth;
      const yFooter = margin / 2;
      p.drawText(label, { x, y: yFooter, size, font });
    });

    const pdfBytes = await pdfDoc.save();
    await recordAuditLog({
      actorId: user?.id || null,
      action: "CUSTOMER_STATEMENT_EXPORT_PDF",
      entityType: "CUSTOMER",
      entityId: customer.id,
      meta: {
        customerId: customer.id,
        customerName: customer.name || null,
        customerEmail: customer.email || null,
        format: "PDF",
        fileName: `customer-${readableId}-statement.pdf`,
        rowCount: orders.length + payments.length,
        orderCount: orders.length,
        paymentCount: payments.length,
        byteSize: pdfBytes.length,
        actorName: user?.name || null,
        actorEmail: user?.email || null,
        actorRole: user?.role || null,
      },
    });
    return new Response(pdfBytes as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="customer-${readableId}-statement.pdf"`,
      },
    });
  }

  const header = [
    "type",
    "id",
    "date",
    "amount",
    "appliedTo",
    "status",
    "note",
  ];
  const lines: string[] = [];
  lines.push(header.join(","));

  for (const o of orders) {
    const row = [
      "ORDER",
      o.id,
      o.createdAt.toISOString(),
      String(o.total),
      "",
      o.status,
      "",
    ]
      .map((v) => `"${String(v ?? "").replaceAll('"', '""')}"`)
      .join(",");
    lines.push(row);
  }

  for (const p of payments) {
    let note = p.note || "";
    let appliedTo = "";
    try {
      const meta = JSON.parse(note || "{}") as {
        applied?: Array<{ orderId?: string; applied?: number }>;
        location?: string;
        method?: string;
        provider?: string;
        status?: string;
        phone?: string;
        providerRef?: string;
        reference?: string;
      };

      if (Array.isArray(meta.applied) && meta.applied.length > 0) {
        appliedTo = meta.applied
          .map((a) =>
            a.orderId ? `${a.orderId} (${a.applied ?? ""})` : "",
          )
          .filter(Boolean)
          .join("; ");
      }

      // Friendlier labels for known meta shapes
      if (meta.method === "momo") {
        const parts: string[] = [];
        const provider = meta.provider || "MoMo";
        const status = meta.status || p.status || "";
        parts.push(`MoMo ${provider.toUpperCase()}${status ? ` (${status})` : ""}`);
        if (meta.phone) parts.push(`Phone ${meta.phone}`);
        if (meta.providerRef) parts.push(`Ref ${meta.providerRef}`);
        note = parts.join(" · ");
      } else if (meta.reference === "AUTO_APPLY") {
        note = "Store credit auto-applied";
      } else if (meta.location) {
        note = meta.location;
      }
    } catch {
      // keep original note string if not JSON
    }

    const row = [
      "PAYMENT",
      p.id,
      p.createdAt.toISOString(),
      String(p.amount),
      appliedTo,
      p.status || "",
      note || "",
    ]
      .map((v) => `"${String(v ?? "").replaceAll('"', '""')}"`)
      .join(",");
    lines.push(row);
  }

  const body = lines.join("\n");
  await recordAuditLog({
    actorId: user?.id || null,
    action: "CUSTOMER_STATEMENT_EXPORT_CSV",
    entityType: "CUSTOMER",
    entityId: customer.id,
    meta: {
      customerId: customer.id,
      customerName: customer.name || null,
      customerEmail: customer.email || null,
      format: "CSV",
      fileName: `customer-${formatIdReadable(customer.id)}-statement.csv`,
      rowCount: Math.max(0, lines.length - 1),
      columnCount: header.length,
      orderCount: orders.length,
      paymentCount: payments.length,
      byteSize: Buffer.byteLength(body, "utf8"),
      actorName: user?.name || null,
      actorEmail: user?.email || null,
      actorRole: user?.role || null,
    },
  });
  return new NextResponse(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="customer-${formatIdReadable(
        customer.id,
      )}-statement.csv"`,
    },
  });
}
