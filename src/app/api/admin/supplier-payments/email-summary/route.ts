import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { hasPermission } from "@/lib/permissions";
import { sendEmail } from "@/lib/email";
import { recordAuditLog } from "@/lib/audit-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  to: z.preprocess(
    (v) => (typeof v === "string" ? v.trim() : v),
    z.string().email("Recipient email is invalid"),
  ),
  cc: z.preprocess(
    (v) => {
      if (typeof v !== "string") return undefined;
      const trimmed = v.trim();
      return trimmed || undefined;
    },
    z.string().email("CC email is invalid").optional(),
  ),
  subject: z.preprocess(
    (v) => (typeof v === "string" ? v.trim() : v),
    z.string().min(3, "Subject is required").max(160, "Subject too long"),
  ),
  text: z.preprocess(
    (v) => (typeof v === "string" ? v.trim() : v),
    z.string().min(10, "Summary message is too short").max(20000, "Summary message is too long"),
  ),
  scopeSnapshot: z
    .object({
      scope: z.string().optional(),
      basis: z.string().optional(),
      statusFilter: z.string().optional(),
      monthFilter: z.string().optional(),
      agingFilter: z.string().optional(),
    })
    .optional(),
  summarySnapshot: z
    .object({
      openExposure: z.number().optional(),
      receivedApOutstanding: z.number().optional(),
      orderedNotReceivedExposure: z.number().optional(),
      overdueCount: z.number().optional(),
      dueTodayCount: z.number().optional(),
      due7Count: z.number().optional(),
    })
    .optional(),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  if (!session || !hasPermission(role, "supplierPayments.manage")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "admin-supplier-payables-summary-email", 60_000, 20);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { to, cc, subject, text, scopeSnapshot, summarySnapshot } = parsed.data;
  const html = text.replace(/\n/g, "<br/>");

  const sent = await sendEmail(to, subject, text, html);
  if (!sent.ok) {
    return NextResponse.json({ error: sent.error || "Failed to send email" }, { status: 500 });
  }
  if (cc) {
    const ccResult = await sendEmail(cc, subject, text, html);
    if (!ccResult.ok) {
      return NextResponse.json({ error: ccResult.error || "Failed to send CC email" }, { status: 500 });
    }
  }

  await recordAuditLog({
    actorId: user?.id || null,
    action: "SUPPLIER_PAYABLES_SUMMARY_EMAIL_SEND",
    entityType: "SUPPLIER_PAYMENT",
    entityId: "SUMMARY",
    meta: {
      to,
      cc: cc || null,
      subject,
      bodyLength: text.length,
      simulated: !!sent.simulated,
      scopeSnapshot: scopeSnapshot || null,
      summarySnapshot: summarySnapshot || null,
    },
  });

  return NextResponse.json({ ok: true, simulated: !!sent.simulated });
}
