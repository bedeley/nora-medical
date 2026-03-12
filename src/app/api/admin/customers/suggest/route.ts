import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

function normalizePhone(value: string) {
  return value.replace(/\D/g, "");
}

function normalizeName(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
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

  const url = new URL(req.url);
  const name = String(url.searchParams.get("name") || "").trim();
  const phone = String(url.searchParams.get("phone") || "").trim();
  const limit = Math.max(1, Math.min(20, Number(url.searchParams.get("limit") || 8)));

  const phoneDigits = normalizePhone(phone);
  const phoneTail = phoneDigits.length >= 7 ? phoneDigits.slice(-7) : phoneDigits;

  if (!name && !phoneDigits) {
    return NextResponse.json({ items: [] });
  }

  const or: Array<Record<string, unknown>> = [];
  if (name) {
    or.push({ name: { contains: name, mode: "insensitive" } });
    if (name.includes("@")) {
      or.push({ email: { contains: name, mode: "insensitive" } });
    }
  }
  if (phoneDigits) {
    or.push({ phone: { contains: phoneDigits } });
  }
  if (phoneTail && phoneTail !== phoneDigits) {
    or.push({ phone: { contains: phoneTail } });
  }

  const rows = await prisma.user.findMany({
    where: {
      role: "CUSTOMER",
      archived: false,
      OR: or,
    },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  const walkInWhere: Record<string, unknown> = {
    customerType: "WALK_IN",
    OR: [
      ...(name ? [{ walkInName: { contains: name, mode: "insensitive" } }] : []),
      ...(phoneDigits ? [{ walkInPhone: { contains: phoneDigits } }] : []),
      ...(phoneTail && phoneTail !== phoneDigits ? [{ walkInPhone: { contains: phoneTail } }] : []),
    ],
  };
  const walkInRows =
    (walkInWhere.OR as unknown[]).length > 0
      ? await prisma.order.findMany({
          where: walkInWhere,
          select: {
            walkInName: true,
            walkInPhone: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
          take: Math.max(limit, 20),
        })
      : [];

  const walkInSeen = new Set<string>();
  const registeredByPhone = new Map<string, string>();
  const registeredNames: string[] = [];
  for (const row of rows) {
    const phoneKey = normalizePhone(String(row.phone || ""));
    const nameKey = normalizeName(String(row.name || ""));
    if (phoneKey && nameKey) {
      registeredByPhone.set(phoneKey, nameKey);
    }
    if (nameKey) registeredNames.push(nameKey);
  }
  const walkInItems: Array<{
    id: string;
    name: string | null;
    email: string | null;
    phone: string | null;
    createdAt: string;
    source: "WALK_IN_HISTORY";
  }> = [];
  for (const row of walkInRows) {
    const rawName = String(row.walkInName || "").trim();
    const nameKey = normalizeName(rawName);
    const phoneKey = normalizePhone(String(row.walkInPhone || ""));
    if (!nameKey && !phoneKey) continue;
    // Skip noisy partial aliases from prior typing (e.g., "kw", "kwe", "kwes").
    if (nameKey && nameKey.length < 4) continue;
    // If a registered customer exists for this phone and this walk-in name is just a partial/alias,
    // suppress the duplicate walk-in-history suggestion.
    const registeredNameForPhone = phoneKey ? registeredByPhone.get(phoneKey) : null;
    if (
      registeredNameForPhone &&
      nameKey &&
      (registeredNameForPhone.includes(nameKey) || nameKey.includes(registeredNameForPhone))
    ) {
      continue;
    }
    // When registered matches already exist, only keep walk-in history rows that carry a phone
    // and are not a plain alias/fragment of any registered match.
    if (rows.length > 0) {
      if (!phoneKey) continue;
      if (
        nameKey &&
        registeredNames.some(
          (registeredName) =>
            registeredName.includes(nameKey) || nameKey.includes(registeredName),
        )
      ) {
        continue;
      }
    }
    const key = `${nameKey}|${phoneKey}`;
    if (walkInSeen.has(key)) continue;
    walkInSeen.add(key);
    walkInItems.push({
      id: `walkin:${key}`,
      name: row.walkInName || null,
      email: null,
      phone: row.walkInPhone || null,
      createdAt: row.createdAt.toISOString(),
      source: "WALK_IN_HISTORY",
    });
    if (walkInItems.length >= limit) break;
  }

  const registeredItems = rows.map((row) => ({
    id: row.id,
    name: row.name || null,
    email: row.email || null,
    phone: row.phone || null,
    createdAt: row.createdAt.toISOString(),
    source: "REGISTERED" as const,
  }));

  const combined = [...registeredItems, ...walkInItems].slice(0, limit);

  return NextResponse.json({
    items: combined,
  });
}
