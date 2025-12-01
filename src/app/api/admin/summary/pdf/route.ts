import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { startOfDay, endOfDay, parseISO, isValid, format } from "date-fns";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { PDFDocument, StandardFonts, rgb, type PDFPage } from "pdf-lib";
import { formatCurrency } from "@/lib/currency";

/**
 * ✅ Financial Report PDF (with logo, header, and pagination)
 */
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;

  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const start = searchParams.get("start");
    const end = searchParams.get("end");
    const groupBy = (searchParams.get("groupBy") as "day" | "month") || "day";

    // 📅 Date filter
    const createdAt: { gte?: Date; lte?: Date } = {};
    if (start && isValid(parseISO(start))) {
      createdAt.gte = startOfDay(parseISO(start));
    }
    if (end && isValid(parseISO(end))) {
      createdAt.lte = endOfDay(parseISO(end));
    }

    const createdAtFilter =
      Object.keys(createdAt).length > 0 ? { createdAt } : {};

    // 💰 Fetch data
    const payments = await prisma.payment.findMany({
      where: createdAtFilter,
    });
    const expenses = await prisma.expense.findMany({
      where: createdAtFilter,
    });

    // 📊 Totals
    const totalRevenue = payments.reduce(
      (s: number, p: { amount: unknown }) => s + Number(p.amount || 0),
      0
    );
    const totalExpense = expenses.reduce(
      (s: number, e: { amount: unknown }) => s + Number(e.amount || 0),
      0
    );
    const profit = totalRevenue - totalExpense;
    const margin = totalRevenue > 0 ? (profit / totalRevenue) * 100 : 0;

    // 📆 Group by day/month
    const grouped: Record<string, { revenue: number; expense: number }> = {};
    const formatKey = (d: Date) =>
      groupBy === "month" ? format(d, "yyyy-MM") : format(d, "yyyy-MM-dd");

    for (const p of payments) {
      const key = formatKey(p.createdAt);
      if (!grouped[key]) grouped[key] = { revenue: 0, expense: 0 };
      grouped[key].revenue += Number(p.amount);
    }

    for (const e of expenses) {
      const key = formatKey(e.createdAt);
      if (!grouped[key]) grouped[key] = { revenue: 0, expense: 0 };
      grouped[key].expense += Number(e.amount);
    }

    const trend = Object.entries(grouped)
      .map(([date, v]) => ({
        date,
        revenue: v.revenue,
        expense: v.expense,
        profit: v.revenue - v.expense,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // 🧾 Generate PDF
    const pdfBuffer = await generateBrandedPDF({
      trend,
      totalRevenue,
      totalExpense,
      profit,
      margin,
      start,
      end,
    });

    const uint8 = new Uint8Array(pdfBuffer);

    return new NextResponse(uint8, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="Noralls_Financial_Report_${Date.now()}.pdf"`,
      },
    });
  } catch (err) {
    console.error("❌ Error generating PDF:", err);
    return NextResponse.json(
      { error: "Failed to generate PDF" },
      { status: 500 }
    );
  }
}

/**
 * 🧾 Helper: Generates branded PDF with logo + business details
 */
async function generateBrandedPDF({
  trend,
  totalRevenue,
  totalExpense,
  profit,
  margin,
  start,
  end,
}: {
  trend: { date: string; revenue: number; expense: number; profit: number }[];
  totalRevenue: number;
  totalExpense: number;
  profit: number;
  margin: number;
  start: string | null;
  end: string | null;
}) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // Convert SVG logo → PNG
  const logoPath = path.join(process.cwd(), "public", "logo.svg");
  let logoImage = null;
  if (fs.existsSync(logoPath)) {
    const svgBuffer = fs.readFileSync(logoPath);
    const pngBuffer = await sharp(svgBuffer).png().toBuffer();
    logoImage = await pdfDoc.embedPng(pngBuffer);
  }

  const blue = rgb(0.1, 0.3, 0.7);
  const gray = rgb(0.5, 0.5, 0.5);
  const green = rgb(0, 0.6, 0.1);
  const red = rgb(0.8, 0.1, 0.1);

  const pages: PDFPage[] = [];
  const createPage = () => {
    const p = pdfDoc.addPage([595.28, 841.89]);
    pages.push(p);
    return p;
  };

  let page = createPage();
  const { height } = page.getSize();
  let y = height - 70;

  // 🏢 Business Info
  const businessName = "NORA HOSPITAL SUPPLIES";
  const businessAddress = "No. 24 Healing Way, Accra, Ghana";
  const businessPhone = "+233 24 123 4567";
  const businessWebsite = "www.norahospitalsupplies.com";

  // 🖼️ Logo
  if (logoImage) {
    const dims = logoImage.scale(0.2);
    page.drawImage(logoImage, {
      x: 50,
      y: height - 90,
      width: dims.width,
      height: dims.height,
    });
  }

  // 🏷️ Header
  page.drawText(businessName, {
    x: 130,
    y: height - 60,
    size: 18,
    font: bold,
    color: blue,
  });
  page.drawText("Financial Summary Report", {
    x: 130,
    y: height - 80,
    size: 12,
    font,
    color: gray,
  });

  // 📍 Contact info
  page.drawText(businessAddress, { x: 130, y: height - 100, size: 9, font });
  page.drawText(businessPhone, { x: 130, y: height - 112, size: 9, font });
  page.drawText(businessWebsite, { x: 130, y: height - 124, size: 9, font });

  y -= 140;
  page.drawLine({
    start: { x: 50, y },
    end: { x: 545, y },
    thickness: 1,
    color: blue,
  });
  y -= 30;

  // 📅 Date range
  page.drawText(`Period: ${start || "—"} → ${end || "—"}`, {
    x: 50,
    y,
    size: 10,
    font,
  });
  y -= 25;

  // 🧾 Summary
  const summaryLines: [string, string, ReturnType<typeof rgb>][] = [
    ["Total Revenue", `${formatCurrency(totalRevenue)}`, green],
    ["Total Expenses", `${formatCurrency(totalExpense)}`, red],
    ["Net Profit", `${formatCurrency(profit)}`, profit >= 0 ? green : red],
    ["Profit Margin", `${margin.toFixed(2)}%`, rgb(0, 0, 0)],
  ];

  for (const [label, value, color] of summaryLines) {
    page.drawText(label, { x: 50, y, size: 11, font: bold });
    page.drawText(value, { x: 250, y, size: 11, font, color });
    y -= 18;
  }

  y -= 30;
  page.drawText("📈 Transaction Summary", { x: 50, y, size: 12, font: bold });
  y -= 15;

  const headers = ["Date", "Revenue ($)", "Expense ($)", "Profit ($)"];
  const colX = [50, 180, 310, 440];
  headers.forEach((h, i) => {
    page.drawText(h, { x: colX[i], y, size: 10, font: bold, color: blue });
  });
  y -= 10;
  page.drawLine({
    start: { x: 50, y },
    end: { x: 545, y },
    thickness: 0.8,
    color: gray,
  });
  y -= 15;

  // 🧮 Data Rows
  for (const t of trend) {
    if (y < 100) {
      page = createPage();
      y = height - 100;
      page.drawText("Continued...", { x: 50, y, size: 10, font, color: gray });
      y -= 20;
    }

    page.drawText(t.date, { x: colX[0], y, size: 10, font });
    page.drawText(t.revenue.toFixed(2), { x: colX[1], y, size: 10, font });
    page.drawText(t.expense.toFixed(2), { x: colX[2], y, size: 10, font });
    page.drawText(t.profit.toFixed(2), {
      x: colX[3],
      y,
      size: 10,
      font,
      color: t.profit >= 0 ? green : red,
    });
    y -= 15;
  }

  // 🦶 Footer with page numbers
  const totalPages = pages.length;
  pages.forEach((p, idx) => {
    p.drawLine({
      start: { x: 50, y: 60 },
      end: { x: 545, y: 60 },
      thickness: 1,
      color: gray,
    });
    p.drawText("Prepared by Noralls Medical Supplies", {
      x: 50,
      y: 45,
      size: 9,
      font,
      color: gray,
    });
    p.drawText(format(new Date(), "yyyy-MM-dd HH:mm"), {
      x: 440,
      y: 45,
      size: 9,
      font,
      color: gray,
    });
    p.drawText(`Page ${idx + 1} of ${totalPages}`, {
      x: 270,
      y: 45,
      size: 9,
      font,
      color: gray,
    });
  });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}
