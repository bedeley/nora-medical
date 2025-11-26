import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { formatCurrency, formatDateTimeGH } from "@/lib/currency";

/**
 * 📊 Revenue & Expense Report API
 * Supports ?format=pdf | ?format=csv
 */
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const format = searchParams.get("format") || "csv";
  const delivery = searchParams.get("delivery") || ""; // not-delivered | partial | delivered | ""

  try {
    // 🧾 Fetch orders with related user and items
    const orders = await prisma.order.findMany({
      where: { status: { in: ["PAID", "SHIPPED"] } },
      include: {
        items: { include: { product: true } },
        user: { select: { name: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    if (!orders.length) {
      return NextResponse.json(
        { error: "No orders found for report" },
        { status: 404 }
      );
    }

    // 💸 Try fetching expenses (optional)
    let expenses: {
      id: string;
      category: string;
      note: string | null;
      amount: number;
      createdAt: Date;
    }[] = [];

    try {
      const expenseData = await prisma.expense.findMany();
      expenses = expenseData.map((e: typeof expenseData[number]) => ({
        id: e.id,
        category: e.category,
        note: e.note,
        amount: Number(e.amount),
        createdAt: e.createdAt,
      }));
    } catch {
      // Ignore if Expense table doesn’t exist
    }

    // 🧮 Build rows
    // Optional delivery filter
    const deliveryFiltered = orders.filter((o: typeof orders[number]) => {
      if (!delivery) return true;
      const ds = String(o.deliveryStatus || "").toUpperCase();
      if (delivery === "not-delivered") return ds === "NOT_DELIVERED";
      if (delivery === "partial") return ds === "PARTIALLY_DELIVERED";
      if (delivery === "delivered") return ds === "DELIVERED";
      return true;
    });

    const rows = deliveryFiltered.flatMap((order) =>
      order.items.map((item: typeof order.items[number]) => {
        const price = Number(item.price);
        const total = price * item.quantity;
        const profit = total * 0.25; // Example: 25% profit margin

        return {
          orderId: order.id,
          userName: order.user?.name || "Unknown",
          userEmail: order.user?.email || "N/A",
          product: item.product?.name || "Unknown",
          quantity: item.quantity,
          price: price.toFixed(2),
          total: total.toFixed(2),
          profit: profit.toFixed(2),
          status: order.status,
          deliveryStatus: order.deliveryStatus || "",
          deliveredAt: order.deliveredAt
            ? order.deliveredAt.toISOString()
            : "",
          date: order.createdAt.toISOString(),
        };
      })
    );

    const totalRevenue = rows.reduce(
      (sum: number, r: { total: string | number }) => sum + Number(r.total),
      0
    );
    const totalProfit = rows.reduce(
      (sum: number, r: { profit: string | number }) => sum + Number(r.profit),
      0
    );
    const totalExpenses = expenses.reduce(
      (sum: number, e: { amount: number }) => sum + e.amount,
      0
    );
    const netBalance = totalProfit - totalExpenses;

    /**
     * 🧾 PDF Export (with logo + branding)
     */
    if (format === "pdf") {
      const chunks: Buffer[] = [];
      const doc = new PDFDocument({ margin: 40, size: "A4" });

      doc.on("data", (chunk) => chunks.push(chunk));
      const done = new Promise<void>((resolve) => doc.on("end", resolve));

      // 🏢 Company details
      const company = {
        name: "NORA HOSPITAL SUPPLIES",
        address: "No. 24 Healing Way, Accra, Ghana",
        phone: "+233 24 123 4567",
        website: "www.norahospitalsupplies.com",
      };

      // 🖼️ Logo (convert SVG → PNG for PDFKit)
      const logoPath = path.join(process.cwd(), "public", "logo.svg");
      if (fs.existsSync(logoPath)) {
        const svgBuffer = fs.readFileSync(logoPath);
        const pngBuffer = await sharp(svgBuffer).png().toBuffer();
        doc.image(pngBuffer, 40, 40, { width: 60 });
      }

      // 🧾 Header text
      doc
        .font("Helvetica-Bold")
        .fontSize(18)
        .text(company.name, 110, 45, { align: "left" });
      doc
        .font("Helvetica")
        .fontSize(9)
        .fillColor("gray")
        .text(company.address, 110, 65)
        .text(company.phone, 110, 77)
        .text(company.website, 110, 89)
        .moveDown(2);

      // 🧭 Title
      doc
        .moveDown(2)
        .font("Helvetica-Bold")
        .fillColor("black")
        .fontSize(16)
        .text("Revenue & Expense Summary Report", { align: "center" })
        .moveDown(0.3);
      doc
        .fontSize(10)
        .text(`Generated on ${formatDateTimeGH(new Date())}`, {
          align: "center",
        })
        .moveDown(1.2);

      // 📋 Summary section
      doc
        .font("Helvetica-Bold")
        .fontSize(12)
        .text("Financial Summary", { underline: true })
        .moveDown(0.5);

      doc.font("Helvetica").fontSize(11);
      doc.text(`Total Revenue: ${formatCurrency(totalRevenue)}`);
      doc.text(`Total Profit: ${formatCurrency(totalProfit)}`);
      doc.text(`Total Expenses: ${formatCurrency(totalExpenses)}`);
      doc.text(`Net Balance: ${formatCurrency(netBalance)}`);
      doc.moveDown(1);

      // Delivery summary (based on filtered orders)
      try {
        const deliveryCounts = (deliveryFiltered || []).reduce(
          (acc: { delivered: number; partial: number; pending: number }, o: { deliveryStatus: string | null }) => {
            const ds = String(o.deliveryStatus || "NOT_DELIVERED").toUpperCase();
            if (ds === "DELIVERED") acc.delivered += 1;
            else if (ds === "PARTIALLY_DELIVERED") acc.partial += 1;
            else acc.pending += 1;
            return acc;
          },
          { delivered: 0, partial: 0, pending: 0 },
        );
        doc
          .font("Helvetica-Bold")
          .fontSize(12)
          .text("Delivery Summary", { underline: true })
          .moveDown(0.5);
        doc.font("Helvetica").fontSize(11);
        const totalDeliveries = deliveryCounts.delivered + deliveryCounts.partial + deliveryCounts.pending;
        const pct = (n: number) => (totalDeliveries > 0 ? `${((n / totalDeliveries) * 100).toFixed(1)}%` : "0.0%");
        // Counts with percentages
        doc.text(`Delivered: ${deliveryCounts.delivered} (${pct(deliveryCounts.delivered)})`);
        doc.text(`Partially Delivered: ${deliveryCounts.partial} (${pct(deliveryCounts.partial)})`);
        doc.text(`Not Delivered: ${deliveryCounts.pending} (${pct(deliveryCounts.pending)})`);
        // Compact one-line summary
        doc.moveDown(0.3);
        doc.font("Helvetica-Oblique").fontSize(10).fillColor("gray").text(
          `Summary: Delivered ${deliveryCounts.delivered} (${pct(deliveryCounts.delivered)}) • Partial ${deliveryCounts.partial} (${pct(deliveryCounts.partial)}) • Not Delivered ${deliveryCounts.pending} (${pct(deliveryCounts.pending)})`
        );
        doc.fillColor("black").font("Helvetica").fontSize(11).moveDown(1);
      } catch {}

      // 🧾 Orders section
      doc
        .font("Helvetica-Bold")
        .fontSize(12)
        .text("Recent Orders", { underline: true })
        .moveDown(0.5);
      doc.font("Helvetica").fontSize(9);

      rows.slice(0, 25).forEach((r) => {
        doc.text(
          `${r.date.slice(0, 10)} | ${r.userName} | ${r.product} × ${
            r.quantity
          } | ${formatCurrency(Number(r.total))} (${r.status})`
        );
        {
          const delivered = r.deliveredAt ? new Date(r.deliveredAt).toISOString().slice(0, 10) : "";
          doc.text(`Delivery: ${r.deliveryStatus || ""}${delivered ? ` on ${delivered}` : ""}`);
        }
      });

      if (rows.length > 25) {
        doc
          .font("Helvetica-Oblique")
          .text(`...and ${rows.length - 25} more orders`);
        doc.font("Helvetica");
      }

      // 💸 Expenses section
      if (expenses.length) {
        doc.moveDown(1.5);
        doc.font("Helvetica-Bold").fontSize(12).text("Expenses", {
          underline: true,
        });
        doc.moveDown(0.5);
        doc.font("Helvetica").fontSize(9);

        expenses.slice(0, 10).forEach((e) => {
          doc.text(
            `${e.createdAt.toISOString().slice(0, 10)} | ${
              e.category
            } | ${formatCurrency(Number(e.amount))} ${e.note ? `(${e.note})` : ""}`
          );
        });
        if (expenses.length > 10) {
          doc
            .font("Helvetica-Oblique")
            .text(`...and ${expenses.length - 10} more expenses`);
          doc.font("Helvetica");
        }
      }

      // 🖊️ Signature block
      doc.moveDown(2);
      doc
        .font("Helvetica-Bold")
        .fontSize(11)
        .text("Prepared by: ____________________", { align: "left" });
      doc
        .font("Helvetica-Bold")
        .fontSize(11)
        .text("Approved by: ____________________", { align: "left" });
      doc
        .font("Helvetica")
        .fontSize(9)
        .fillColor("gray")
        .moveDown(1.5)
        .text("Date: ____________________", { align: "left" });

      // 📄 Footer
      doc.moveDown(2);
      doc
        .fontSize(9)
        .font("Helvetica-Oblique")
        .fillColor("gray")
        .text("© Nora Hospital Supplies — Confidential Report", {
          align: "center",
        });

      doc.end();
      await done;

      const pdfBuffer = Buffer.concat(chunks);
      return new NextResponse(new Uint8Array(pdfBuffer), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="revenue-report-${new Date()
            .toISOString()
            .slice(0, 10)}.pdf"`,
        },
      });
    }

    /**
     * 📄 Default CSV Export
     */
    const csvHeader = [
      "Order ID",
      "User Name",
      "User Email",
      "Product",
      "Quantity",
      "Price",
      "Total",
      "Profit",
      "Status",
      "Delivery Status",
      "Delivered At",
      "Date",
    ];

    // Delivery summary for CSV footer
    const deliveryCounts = (deliveryFiltered || []).reduce(
      (acc, o) => {
        const ds = String(o.deliveryStatus || "NOT_DELIVERED").toUpperCase();
        if (ds === "DELIVERED") acc.delivered += 1;
        else if (ds === "PARTIALLY_DELIVERED") acc.partial += 1;
        else acc.pending += 1;
        return acc;
      },
      { delivered: 0, partial: 0, pending: 0 },
    );
    const totalDeliveries = deliveryCounts.delivered + deliveryCounts.partial + deliveryCounts.pending;
    const pct = (n: number) => (totalDeliveries > 0 ? `${((n / totalDeliveries) * 100).toFixed(1)}%` : "0.0%");

    const csvRows = [
      csvHeader.join(","),
      ...rows.map((r) =>
        [
          r.orderId,
          `"${r.userName}"`,
          r.userEmail,
          `"${r.product}"`,
          r.quantity,
          r.price,
          r.total,
          r.profit,
          r.status,
          r.deliveryStatus,
          r.deliveredAt,
          r.date,
        ].join(",")
      ),
      "",
      "SUMMARY,,",
      `Total Revenue,,,${formatCurrency(totalRevenue)}`,
      `Total Profit,,,${formatCurrency(totalProfit)}`,
      `Total Expenses,,,${formatCurrency(totalExpenses)}`,
      `Net Balance,,,${formatCurrency(netBalance)}`,
      "",
      `Delivery Summary,,,"Delivered ${deliveryCounts.delivered} (${pct(deliveryCounts.delivered)}) • Partial ${deliveryCounts.partial} (${pct(deliveryCounts.partial)}) • Not Delivered ${deliveryCounts.pending} (${pct(deliveryCounts.pending)})"`,
    ].join("\n");

    return new NextResponse(csvRows, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="revenue-report-${new Date()
          .toISOString()
          .slice(0, 10)}.csv"`,
      },
    });
  } catch (error) {
    console.error("Error generating revenue report:", error);
    return NextResponse.json(
      { error: "Failed to generate report" },
      { status: 500 }
    );
  }
}
