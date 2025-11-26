import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type MomoPending = {
  id: string;
  amount: number;
  createdAt: string;
  status: string;
  provider: string;
  providerRef: string;
  user: { id: string; name: string | null; email: string | null } | null;
  order: { id: string; status: string | null } | null;
};

export async function GET() {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const payments = await prisma.payment.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { user: { select: { id: true, name: true, email: true } }, order: { select: { id: true, status: true } } },
    });
    const momo = payments
      .map((p) => {
        let meta: Record<string, unknown> | null = null;
        if (p.note) {
          try {
            meta = JSON.parse(p.note) as Record<string, unknown>;
          } catch {
            meta = null;
          }
        }
        if (!meta || meta.method !== "momo") return null;
        const status = String((meta.status as string | undefined) ?? "pending");
        const item: MomoPending = {
          id: p.id,
          amount: Number(p.amount || 0),
          createdAt: p.createdAt.toISOString(),
          status,
          provider: (meta.provider as string | undefined) ?? "mtn",
          providerRef: (meta.providerRef as string | undefined) ?? "",
          user: p.user,
          order: p.order,
        };
        return item;
      })
      .filter((item): item is MomoPending => item !== null);

    return NextResponse.json({ items: momo });
  } catch {
    return NextResponse.json({ error: "Failed to load MoMo payments" }, { status: 500 });
  }
}
