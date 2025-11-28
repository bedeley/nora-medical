import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } },
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return new Response("Forbidden", { status: 403 });
  }
  if (!assertSameOrigin(req)) {
    return new Response("Bad origin", { status: 403 });
  }

  const userId = params.id;
  if (!userId) {
    return new Response("Missing user id", { status: 400 });
  }

  const body = await req.json().catch(() => null) as { archived?: boolean } | null;
  const archived = body?.archived ?? true;

  try {
    const updated = await prisma.user.update({
      where: { id: userId },
      data: { archived },
      select: { id: true, email: true, archived: true },
    });
    return new Response(JSON.stringify(updated), { status: 200 });
  } catch (e) {
    console.error("Archive user error", e);
    return new Response(
      JSON.stringify({ error: "Failed to update account archive status" }),
      { status: 500 },
    );
  }
}

