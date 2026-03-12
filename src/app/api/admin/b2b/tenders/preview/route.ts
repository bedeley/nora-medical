import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { buildTenderPreview } from "@/lib/b2b-tender";
import { sanitizeTenderItemsText } from "@/lib/tender-sanitization";

const schema = z.object({
  itemsText: z.string().min(2).max(20000),
  currency: z.string().max(10).optional(),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  if (!session || (!isAdmin && !isStaff)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "admin-b2b-tender-preview", 60_000, 60);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }
  const sanitizedItems = sanitizeTenderItemsText(parsed.data.itemsText);
  if (!sanitizedItems.text || sanitizedItems.lineCount === 0) {
    return NextResponse.json({ error: "No valid item lines found" }, { status: 400 });
  }

  const preview = await buildTenderPreview({
    itemsText: sanitizedItems.text,
    currency: parsed.data.currency,
  });
  return NextResponse.json({ ok: true, preview });
}
