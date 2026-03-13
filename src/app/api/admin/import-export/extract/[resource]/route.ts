import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getServerSession } from "next-auth";

import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";
import { IMPORT_TEMPLATES } from "@/lib/import-export-schema";
import { extractTextFromPdfBuffer } from "@/lib/pdf-text-extract";
import { extractTextFromDocxBuffer } from "@/lib/docx-text-extract";
import { extractTextWithOcrSpace } from "@/lib/ocr";

type CsvRow = Record<string, string>;

const allowedTypes = new Set([
  "text/plain",
  "text/csv",
  "application/csv",
  "application/vnd.ms-excel",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const csvQuote = (value: unknown) => {
  const str = String(value ?? "");
  return `"${str.replace(/"/g, '""')}"`;
};

const parseCsv = (input: string): CsvRow[] => {
  const rows: string[][] = [];
  let current: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];
    if (char === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === "," && !inQuotes) {
      current.push(field);
      field = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i += 1;
      current.push(field);
      field = "";
      if (current.some((value) => value.trim().length > 0)) rows.push(current);
      current = [];
      continue;
    }
    field += char;
  }
  if (field.length > 0 || current.length > 0) {
    current.push(field);
    if (current.some((value) => value.trim().length > 0)) rows.push(current);
  }

  if (!rows.length) return [];
  const headers = rows[0].map((value) => value.trim());
  return rows.slice(1).map((row) =>
    headers.reduce((acc, header, idx) => {
      acc[header] = row[idx]?.trim() ?? "";
      return acc;
    }, {} as CsvRow),
  );
};

function normalizeKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function extractStructuredRowsFromText(text: string): CsvRow[] {
  const rows: CsvRow[] = [];
  const lines = text.replace(/\r/g, "\n").split("\n");
  let current: CsvRow = {};
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (Object.keys(current).length > 0) {
        rows.push(current);
        current = {};
      }
      continue;
    }
    const m = line.match(/^([A-Za-z][A-Za-z0-9 _\-/.]{1,40})\s*[:=]\s*(.+)$/);
    if (!m) continue;
    current[m[1].trim()] = m[2].trim();
  }
  if (Object.keys(current).length > 0) rows.push(current);
  return rows;
}

function extractBankRowsFromPlainText(text: string): CsvRow[] {
  const rows: CsvRow[] = [];
  const lines = text.replace(/\r/g, "\n").split("\n");
  const dateAmountPattern =
    /(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4})\s+(.+?)\s+([+-]?\d{1,3}(?:,\d{3})*(?:\.\d{2})?)\s*(CR|DR|CREDIT|DEBIT)?$/i;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(dateAmountPattern);
    if (!m) continue;
    const postedAt = m[1].includes("/") ? m[1].split("/").reverse().join("-") : m[1];
    const description = m[2].trim();
    const amount = m[3].replace(/,/g, "");
    const marker = (m[4] || "").toUpperCase();
    const negative = amount.startsWith("-");
    const type =
      marker === "DR" || marker === "DEBIT" || negative
        ? "DEBIT"
        : marker === "CR" || marker === "CREDIT"
          ? "CREDIT"
          : Number(amount) >= 0
            ? "CREDIT"
            : "DEBIT";
    rows.push({
      postedAt,
      amount: String(Math.abs(Number(amount))),
      type,
      description,
      reference: "",
    });
  }
  return rows;
}

function mapRowsToTemplate(resource: string, sourceRows: CsvRow[], bankNameOverride: string) {
  const headers = IMPORT_TEMPLATES[resource] || [];
  const headerMap = new Map(headers.map((header) => [normalizeKey(header), header]));
  const mappedRows: CsvRow[] = [];

  for (const row of sourceRows) {
    const mapped: CsvRow = {};
    const sourceEntries = Object.entries(row);
    for (const [k, v] of sourceEntries) {
      const nk = normalizeKey(k);
      const direct = headerMap.get(nk);
      if (direct) {
        mapped[direct] = String(v || "").trim();
        continue;
      }
      // Common synonyms.
      const aliasPairs: Record<string, string> = {
        invoice: "invoiceNumber",
        invoiceno: "invoiceNumber",
        customer: "customerEmail",
        buyeremail: "customerEmail",
        product: "productSku",
        sku: "productSku",
        qty: "quantity",
        unitprice: "unitCost",
        paymentmethod: "method",
        transactionreference: "reference",
        bank: "bankName",
        date: resource === "orders" ? "date" : resource === "bankTransactions" ? "postedAt" : "createdAt",
      };
      const alias = aliasPairs[nk];
      if (alias && headers.includes(alias)) mapped[alias] = String(v || "").trim();
    }
    if (resource === "bankTransactions" && bankNameOverride && !mapped.bankName) {
      mapped.bankName = bankNameOverride;
    }
    const normalized = headers.reduce((acc, header) => {
      acc[header] = mapped[header] || "";
      return acc;
    }, {} as CsvRow);
    const hasAnyValue = headers.some((header) => normalized[header].trim().length > 0);
    if (hasAnyValue) mappedRows.push(normalized);
  }

  return { headers, rows: mappedRows };
}

function toCsv(headers: string[], rows: CsvRow[]) {
  const headerLine = headers.map(csvQuote).join(",");
  const body = rows
    .map((row) => headers.map((header) => csvQuote(row[header] || "")).join(","))
    .join("\n");
  return `${headerLine}\n${body}${rows.length ? "\n" : ""}`;
}

function looksLikeCsv(text: string) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (!lines.length) return false;
  return lines[0].includes(",") && lines.length >= 2;
}

export async function POST(
  req: Request,
  context: { params: Promise<{ resource: string }> | { resource: string } },
) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !hasPermission(user?.role, "import.data")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = await context.params;
  const resource = params.resource;
  if (!IMPORT_TEMPLATES[resource]) {
    return NextResponse.json({ error: "Unsupported import resource." }, { status: 400 });
  }

  const formData = await req.formData();
  const file = formData.get("file");
  const bankName = String(formData.get("bankName") || "").trim();
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing source file." }, { status: 400 });
  }
  if (file.size > 5 * 1024 * 1024) {
    return NextResponse.json({ error: "File too large (max 5MB)." }, { status: 400 });
  }
  if (file.type && !allowedTypes.has(file.type)) {
    return NextResponse.json({ error: "Unsupported file type for assisted extraction." }, { status: 400 });
  }

  const bytes = await file.arrayBuffer();
  const buffer = Buffer.from(bytes);
  const fileName = (file as File & { name?: string }).name || "upload";
  const lowerName = fileName.toLowerCase();
  const isPdf = file.type === "application/pdf" || lowerName.endsWith(".pdf");
  const isDocx =
    file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || lowerName.endsWith(".docx");
  const isDoc = file.type === "application/msword" || lowerName.endsWith(".doc");
  const isImage = file.type.startsWith("image/");
  const ocrEnabled =
    (process.env.IMPORT_OCR_ENABLE || "").trim() === "1" ||
    (process.env.B2B_TENDER_OCR_ENABLE || "").trim() === "1";

  let extractedText = "";
  const warnings: string[] = [];

  if (isPdf) {
    extractedText = extractTextFromPdfBuffer(buffer);
    if (!extractedText && ocrEnabled) {
      const ocr = await extractTextWithOcrSpace({
        buffer,
        filename: fileName,
        mimeType: file.type || "application/pdf",
      });
      if (!ocr.ok) warnings.push(ocr.error || "OCR failed for PDF.");
      if (ocr.ok && ocr.text) extractedText = ocr.text;
    }
  } else if (isDocx) {
    extractedText = extractTextFromDocxBuffer(buffer);
  } else if (isDoc) {
    return NextResponse.json({ error: "Legacy .doc extraction not supported. Convert to DOCX/PDF." }, { status: 400 });
  } else if (isImage) {
    if (!ocrEnabled) {
      return NextResponse.json({
        error: "Image extraction requires OCR. Set IMPORT_OCR_ENABLE=1 and OCR_SPACE_API_KEY.",
      }, { status: 400 });
    }
    const ocr = await extractTextWithOcrSpace({
      buffer,
      filename: fileName,
      mimeType: file.type || "image/png",
    });
    if (!ocr.ok || !ocr.text) {
      return NextResponse.json({ error: ocr.error || "OCR failed for image." }, { status: 400 });
    }
    extractedText = ocr.text;
  } else {
    extractedText = buffer.toString("utf8");
  }

  if (!extractedText || !extractedText.trim()) {
    return NextResponse.json({ error: "No extractable text found in source file." }, { status: 400 });
  }

  let sourceRows: CsvRow[] = [];
  if (looksLikeCsv(extractedText)) {
    sourceRows = parseCsv(extractedText);
  }
  if (sourceRows.length === 0 && resource === "bankTransactions") {
    sourceRows = extractBankRowsFromPlainText(extractedText);
  }
  if (sourceRows.length === 0) {
    sourceRows = extractStructuredRowsFromText(extractedText);
  }

  const mapped = mapRowsToTemplate(resource, sourceRows, bankName);
  if (mapped.rows.length === 0) {
    return NextResponse.json({
      error:
        "Could not map rows into the selected template. Use Download template, then copy extracted values into the template CSV.",
      warnings,
    }, { status: 400 });
  }

  const csv = toCsv(mapped.headers, mapped.rows);
  await recordAuditLog({
    actorId: user?.id,
    action: "IMPORT_EXPORT",
    entityType: "IMPORT_EXPORT",
    entityId: randomUUID(),
    meta: {
      action: "EXTRACT",
      resource,
      format: "assisted",
      sourceType: file.type || "unknown",
      extractedRows: mapped.rows.length,
      warnings,
    },
  });

  return NextResponse.json({
    ok: true,
    resource,
    detectedRows: sourceRows.length,
    mappedRows: mapped.rows.length,
    headers: mapped.headers,
    warnings,
    csv,
  });
}

