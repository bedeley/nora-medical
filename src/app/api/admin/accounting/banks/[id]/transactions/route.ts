import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAccountingBankAudit } from "@/lib/accounting-bank-audit";

const txnSchema = z.object({
  postedAt: z.string().min(1),
  amount: z.number(),
  description: z.string().max(255).optional(),
  reference: z.string().max(120).optional(),
  type: z.enum(["DEBIT", "CREDIT"]),
  allowDuplicate: z.boolean().optional(),
  duplicateReason: z.string().max(300).optional(),
});

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

function toBoolFilter(value: string | null) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  if (raw === "0" || raw === "false" || raw === "no") return false;
  return null;
}

function toYmdStartUtc(value: string | null) {
  const raw = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return new Date(`${raw}T00:00:00.000Z`);
}

function toYmdEndUtc(value: string | null) {
  const raw = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return new Date(`${raw}T23:59:59.999Z`);
}

function escapeCsv(value: string) {
  if (!value) return "";
  if (/[\",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function buildTransactionWhere(input: {
  bankId: string;
  q: string;
  matched: boolean | null;
  from: Date | null;
  to: Date | null;
}) {
  const { bankId, q, matched, from, to } = input;
  return {
    bankAccountId: bankId,
    ...(matched === null ? {} : { matched }),
    ...(from || to
      ? {
          postedAt: {
            ...(from ? { gte: from } : {}),
            ...(to ? { lte: to } : {}),
          },
        }
      : {}),
    ...(q
      ? {
          OR: [
            { description: { contains: q, mode: "insensitive" as const } },
            { reference: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };
}

function getTransactionOrderBy(sortBy: string, sortDir: "asc" | "desc") {
  switch (sortBy) {
    case "amount":
      return [{ amount: sortDir }, { postedAt: "desc" as const }, { createdAt: "desc" as const }];
    case "type":
      return [{ type: sortDir }, { postedAt: "desc" as const }, { createdAt: "desc" as const }];
    case "description":
      return [{ description: sortDir }, { postedAt: "desc" as const }, { createdAt: "desc" as const }];
    case "reference":
      return [{ reference: sortDir }, { postedAt: "desc" as const }, { createdAt: "desc" as const }];
    case "matched":
      return [{ matched: sortDir }, { postedAt: "desc" as const }, { createdAt: "desc" as const }];
    default:
      return [{ postedAt: sortDir }, { createdAt: "desc" as const }];
  }
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id: bankId } = await params;
  if (!bankId) {
    return NextResponse.json({ error: "Missing bank id" }, { status: 400 });
  }
  const url = new URL(req.url);
  const format = String(url.searchParams.get("format") || "").trim().toLowerCase();
  const q = String(url.searchParams.get("q") || "").trim();
  const unmatchedOnly = toBoolFilter(url.searchParams.get("unmatchedOnly"));
  const matchedFilter = unmatchedOnly === true ? false : toBoolFilter(url.searchParams.get("matched"));
  const from = toYmdStartUtc(url.searchParams.get("from"));
  const to = toYmdEndUtc(url.searchParams.get("to"));
  const pageParam = Number(url.searchParams.get("page") || "1");
  const pageSizeParam = Number(url.searchParams.get("pageSize") || "20");
  const page = Number.isFinite(pageParam) ? Math.max(1, Math.floor(pageParam)) : 1;
  const pageSize = Number.isFinite(pageSizeParam) ? Math.min(200, Math.max(10, Math.floor(pageSizeParam))) : 20;
  const sortBy = ["postedAt", "amount", "type", "description", "reference", "matched"].includes(
    String(url.searchParams.get("sortBy") || ""),
  )
    ? String(url.searchParams.get("sortBy"))
    : "postedAt";
  const sortDir = String(url.searchParams.get("sortDir") || "desc").toLowerCase() === "asc" ? "asc" : "desc";
  const useServerList =
    format === "csv" ||
    url.searchParams.has("q") ||
    url.searchParams.has("from") ||
    url.searchParams.has("to") ||
    url.searchParams.has("unmatchedOnly") ||
    url.searchParams.has("matched") ||
    url.searchParams.has("page") ||
    url.searchParams.has("pageSize") ||
    url.searchParams.has("sortBy") ||
    url.searchParams.has("sortDir");

  if (useServerList) {
    const where = buildTransactionWhere({
      bankId,
      q,
      matched: matchedFilter,
      from,
      to,
    });
    const orderBy = getTransactionOrderBy(sortBy, sortDir);

    if (format === "csv") {
      const rows = await prisma.bankTransaction.findMany({
        where,
        orderBy,
        select: {
          postedAt: true,
          type: true,
          amount: true,
          description: true,
          reference: true,
          matched: true,
        },
      });
      const header = ["date", "type", "amount", "description", "reference", "matched"];
      const csv = [header, ...rows.map((txn) => [
        txn.postedAt.toISOString().slice(0, 10),
        txn.type,
        Number(txn.amount).toFixed(2),
        txn.description || "",
        txn.reference || "",
        txn.matched ? "true" : "false",
      ])]
        .map((row) => row.map((cell) => escapeCsv(String(cell))).join(","))
        .join("\n");
      const actor = session.user as AuthenticatedUser;
      const sourcePage = String(url.searchParams.get("sourcePage") || "admin/accounting/banks").trim();
      await recordAccountingBankAudit({
        req,
        actor,
        action: "BANK_TXN_EXPORT_CSV",
        entityType: "BANK_TRANSACTION",
        entityId: bankId,
        section: "transactions",
        operation: "export_csv",
        resultSummary: `Exported ${rows.length} bank transaction row(s) to CSV.`,
        meta: {
          bankAccountId: bankId,
          format: "CSV",
          fileName: `bank-transactions-${bankId}.csv`,
          rowCount: rows.length,
          columnCount: header.length,
          byteSize: Buffer.byteLength(csv, "utf8"),
          scope: q || matchedFilter !== null || from || to ? "filtered" : "all",
          filters: {
            q: q || null,
            matched: matchedFilter,
            unmatchedOnly: unmatchedOnly === true,
            from: from ? from.toISOString() : null,
            to: to ? to.toISOString() : null,
            sortBy,
            sortDir,
          },
          sourcePage,
        },
      });

      return new NextResponse(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="bank-transactions-${bankId}.csv"`,
        },
      });
    }

    const skip = (page - 1) * pageSize;
    const [total, unmatchedCount, rows] = await Promise.all([
      prisma.bankTransaction.count({ where }),
      prisma.bankTransaction.count({ where: { ...where, matched: false } }),
      prisma.bankTransaction.findMany({
        where,
        orderBy,
        skip,
        take: pageSize,
      }),
    ]);

    return NextResponse.json({
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / Math.max(1, pageSize))),
      sortBy,
      sortDir,
      summary: {
        total,
        unmatched: unmatchedCount,
        matched: Math.max(0, total - unmatchedCount),
      },
      rows,
    });
  }

  const limitParam = Number(url.searchParams.get("limit") || "500");
  const limit = Number.isFinite(limitParam) ? Math.min(2000, Math.max(1, Math.floor(limitParam))) : 500;
  const txns = await prisma.bankTransaction.findMany({
    where: { bankAccountId: bankId },
    orderBy: [{ postedAt: "desc" }],
    take: limit,
  });
  const response = NextResponse.json(txns);
  response.headers.set("X-Transactions-Limit", String(limit));
  response.headers.set("X-Transactions-Returned", String(txns.length));
  return response;
}

export async function POST(
  req: Request,
) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const bankId = new URL(req.url).pathname.split("/").filter(Boolean).at(-2);
  if (!bankId) {
    return NextResponse.json({ error: "Missing bank id" }, { status: 400 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  try {
    const body = await req.json();
    const parsed = txnSchema.safeParse({
      ...body,
      amount: Number(body.amount),
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const postedAt = new Date(parsed.data.postedAt);
    if (Number.isNaN(postedAt.getTime())) {
      return NextResponse.json({ error: "Invalid postedAt date." }, { status: 400 });
    }
    const utcDayStart = new Date(
      Date.UTC(
        postedAt.getUTCFullYear(),
        postedAt.getUTCMonth(),
        postedAt.getUTCDate(),
        0,
        0,
        0,
        0,
      ),
    );
    const utcDayEnd = new Date(
      Date.UTC(
        postedAt.getUTCFullYear(),
        postedAt.getUTCMonth(),
        postedAt.getUTCDate(),
        23,
        59,
        59,
        999,
      ),
    );
    const duplicate = await prisma.bankTransaction.findFirst({
      where: {
        bankAccountId: bankId,
        postedAt: { gte: utcDayStart, lte: utcDayEnd },
        amount: parsed.data.amount,
        reference: parsed.data.reference ?? null,
      },
      select: { id: true },
    });
    if (duplicate && !parsed.data.allowDuplicate) {
      return NextResponse.json(
        {
          error:
            "Potential duplicate transaction (same date, amount, and reference) already exists for this bank.",
          duplicateId: duplicate.id,
        },
        { status: 409 },
      );
    }
    if (duplicate && parsed.data.allowDuplicate) {
      const reason = (parsed.data.duplicateReason || "").trim();
      if (reason.length < 8) {
        return NextResponse.json(
          { error: "Duplicate reason is required (at least 8 characters)." },
          { status: 400 },
        );
      }
    }

    const txn = await prisma.bankTransaction.create({
      data: {
        bankAccountId: bankId,
        postedAt,
        amount: parsed.data.amount,
        description: parsed.data.description,
        reference: parsed.data.reference,
        type: parsed.data.type,
      },
    });
    const actor = session.user as AuthenticatedUser;
    if (duplicate && parsed.data.allowDuplicate) {
      await recordAccountingBankAudit({
        req,
        actor,
        action: "BANK_TXN_DUPLICATE_OVERRIDE",
        entityType: "BANK_TRANSACTION",
        entityId: txn.id,
        section: "transactions",
        operation: "create_duplicate_override",
        resultSummary: `Created duplicate bank transaction override for ${txn.id}.`,
        meta: {
          bankAccountId: bankId,
          duplicateOfId: duplicate.id,
          reason: (parsed.data.duplicateReason || "").trim(),
          postedAt: parsed.data.postedAt,
          amount: parsed.data.amount,
          reference: parsed.data.reference ?? null,
          type: parsed.data.type,
          description: parsed.data.description ?? null,
        },
      });
    } else {
      await recordAccountingBankAudit({
        req,
        actor,
        action: "BANK_TXN_CREATED",
        entityType: "BANK_TRANSACTION",
        entityId: txn.id,
        section: "transactions",
        operation: "create",
        resultSummary: `Created bank transaction ${txn.id}.`,
        meta: {
          bankAccountId: bankId,
          postedAt: parsed.data.postedAt,
          amount: parsed.data.amount,
          type: parsed.data.type,
          reference: parsed.data.reference ?? null,
          description: parsed.data.description ?? null,
        },
      });
    }
    return NextResponse.json(txn);
  } catch (error) {
    console.error("Accounting bank transaction create error:", error);
    return NextResponse.json({ error: "Failed to create transaction" }, { status: 500 });
  }
}
