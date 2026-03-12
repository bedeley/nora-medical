import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { getLatestTenderSnapshot, generateTenderPdf } from "@/lib/b2b-tender";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  try {
    const params = await context.params;
    const snapshot = await getLatestTenderSnapshot(params.id);
    if (!snapshot) return NextResponse.json({ error: "Tender not found" }, { status: 404 });

    const pdf = await generateTenderPdf(snapshot);
    const file = `${snapshot.tenderNumber || snapshot.id}.pdf`;
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${file}"`,
      },
    });
  } catch (error) {
    console.error("Tender PDF generation failed:", error);
    return NextResponse.json({ error: "Failed to generate tender PDF" }, { status: 500 });
  }
}
