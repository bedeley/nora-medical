import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import PDFDocument from "pdfkit";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const authUser = session.user as AuthenticatedUser;
  const userId = authUser.id;

  const { searchParams } = new URL(req.url);
  const format = (searchParams.get("format") || "json").toLowerCase();

  const [accountUser, orders, payments] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    }),
    prisma.order.findMany({
      where: { userId },
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
      where: { userId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        createdAt: true,
        amount: true,
        status: true,
        refundDisposition: true,
        note: true,
      },
    }),
  ]);

  if (format === "pdf") {
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c));
    const done = new Promise<void>((resolve) => doc.on("end", resolve));

    const now = new Date();
    const title = "Account Statement";
    const subtitle = accountUser
      ? `${accountUser.name || accountUser.email || userId} · ${accountUser.email || ""}`
      : userId;

    doc.font("Helvetica-Bold").fontSize(16).text(title, { align: "center" });
    doc.moveDown(0.3);
    doc
      .font("Helvetica")
      .fontSize(10)
      .text(`Generated: ${now.toLocaleString()}`, { align: "center" });
    doc.moveDown(0.3);
    doc.fontSize(11).text(subtitle, { align: "center" });
    doc.moveDown(1);

    doc.font("Helvetica-Bold").fontSize(12).text("Orders");
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(9);
    if (!orders.length) {
      doc.text("No orders on record.");
    } else {
      doc.text("Date              Order ID                 Total      Paid       Balance   Status");
      doc
        .moveTo(40, doc.y + 2)
        .lineTo(550, doc.y + 2)
        .stroke();
      orders.forEach((o) => {
        const d = o.createdAt.toISOString().slice(0, 10);
        const idShort = o.id.slice(0, 10);
        const total = Number(o.total || 0).toFixed(2);
        const paid = Number(o.amountPaid || 0).toFixed(2);
        const balance = Number(o.balance || 0).toFixed(2);
        const status = o.status;
        const line = `${d.padEnd(18)} ${idShort.padEnd(22)} ${total
          .toString()
          .padStart(8)}  ${paid.toString().padStart(8)}  ${balance
          .toString()
          .padStart(8)}  ${status}`;
        doc.text(line);
      });
    }

    doc.moveDown(1);
    doc.font("Helvetica-Bold").fontSize(12).text("Payments");
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(9);
    if (!payments.length) {
      doc.text("No payments on record.");
    } else {
      doc.text("Date              Payment ID              Amount     Status");
      doc
        .moveTo(40, doc.y + 2)
        .lineTo(550, doc.y + 2)
        .stroke();
      payments.forEach((p) => {
        const d = p.createdAt.toISOString().slice(0, 10);
        const idShort = p.id.slice(0, 10);
        const amt = Number(p.amount || 0).toFixed(2);
        const status = p.status || "";
        const line = `${d.padEnd(18)} ${idShort.padEnd(22)} ${amt
          .toString()
          .padStart(8)}  ${status}`;
        doc.text(line);
      });
    }

    doc.end();
    await done;
    const pdf = Buffer.concat(chunks);
    return new Response(pdf, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="account-statement.pdf"`,
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
      };
      if (Array.isArray(meta.applied) && meta.applied.length > 0) {
        appliedTo = meta.applied
          .map((a) =>
            a.orderId ? `${a.orderId} (${a.applied ?? ""})` : "",
          )
          .filter(Boolean)
          .join("; ");
      }
      note = meta.location || note;
    } catch {
      // keep original note string
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
  return new NextResponse(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="account-statement.csv"`,
    },
  });
}
