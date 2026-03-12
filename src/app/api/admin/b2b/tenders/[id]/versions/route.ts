import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  if (!session || (!isAdmin && !isStaff)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = await context.params;
  const versions = await prisma.tenderVersion.findMany({
    where: { tenderId: params.id },
    select: {
      id: true,
      versionNo: true,
      status: true,
      changeNote: true,
      createdAt: true,
      snapshot: true,
    },
    orderBy: { versionNo: "desc" },
    take: 100,
  });
  const seenComparableKeys = new Set<string>();
  return NextResponse.json({
    items: versions.map((v) => {
      const snap = v.snapshot as unknown;
      let availableForCompare = false;
      if (snap && typeof snap === "object") {
        const changeNote = String(v.changeNote || "").trim().toLowerCase();
        const isCommercialVersion =
          changeNote === "tender created" || changeNote === "tender updated";
        if (!isCommercialVersion) {
          return {
            id: v.id,
            versionNo: v.versionNo,
            status: v.status,
            changeNote: v.changeNote || null,
            createdAt: v.createdAt.toISOString(),
            availableForCompare: false,
          };
        }
        const s = snap as {
          lines?: Array<{
            no?: number;
            requestedDescription?: string;
            quantity?: number;
            unitPrice?: number;
            matchedProductId?: string | null;
            bidDisposition?: string | null;
            note?: string | null;
          }>;
          subtotal?: number;
          total?: number;
          validityDays?: number;
          paymentTerms?: string | null;
          leadTimeDays?: number | null;
          vatRatePct?: number;
          discountAmount?: number;
          freightAmount?: number;
          handlingAmount?: number;
          marginThresholdPct?: number;
        };
        const lines = Array.isArray(s.lines) ? s.lines : [];
        if (lines.length > 0) {
          const normalizedLines = lines
            .map((line) => ({
              no: Number(line.no || 0),
              item: String(line.requestedDescription || "").trim().toLowerCase(),
              qty: Number(line.quantity || 0),
              unitPrice: Number(line.unitPrice || 0),
              matchedProductId: String(line.matchedProductId || ""),
              bidDisposition: String(line.bidDisposition || ""),
              note: String(line.note || "").trim().toLowerCase(),
            }))
            .sort((a, b) => a.no - b.no);
          const compareKey = JSON.stringify({
            lines: normalizedLines,
            subtotal: Number(s.subtotal || 0),
            total: Number(s.total || 0),
            validityDays: Number(s.validityDays || 0),
            paymentTerms: String(s.paymentTerms || "").trim().toLowerCase(),
            leadTimeDays: s.leadTimeDays == null ? null : Number(s.leadTimeDays),
            vatRatePct: Number(s.vatRatePct || 0),
            discountAmount: Number(s.discountAmount || 0),
            freightAmount: Number(s.freightAmount || 0),
            handlingAmount: Number(s.handlingAmount || 0),
            marginThresholdPct: Number(s.marginThresholdPct || 0),
          });
          if (!seenComparableKeys.has(compareKey)) {
            seenComparableKeys.add(compareKey);
            availableForCompare = true;
          }
        }
      }
      return {
        id: v.id,
        versionNo: v.versionNo,
        status: v.status,
        changeNote: v.changeNote || null,
        createdAt: v.createdAt.toISOString(),
        availableForCompare,
      };
    }),
  });
}
