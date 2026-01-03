import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";
import { DEFAULT_HERO_COLLAGE } from "@/lib/homepage-settings";

const allowedR2PublicHost = process.env.R2_PUBLIC_BASE_URL
  ? (() => {
      try {
        return new URL(process.env.R2_PUBLIC_BASE_URL).hostname;
      } catch {
        return null;
      }
    })()
  : null;

const allowedHostnames = new Set(
  [allowedR2PublicHost].filter((host): host is string => Boolean(host))
);

function isAllowedCollageUrl(val: string) {
  if (val.startsWith("/uploads/")) return true;
  try {
    const url = new URL(val);
    const host = url.hostname;
    if (allowedHostnames.has(host)) return true;
    if (/^pub-[\w-]+\.r2\.dev$/i.test(host)) return true;
    if (/\.r2\.cloudflarestorage\.com$/i.test(host)) return true;
  } catch {
    return false;
  }
  return false;
}

const urlOrPath = z
  .string()
  .min(1)
  .refine((val) => isAllowedCollageUrl(val), {
    message:
      "Use an /uploads path or an approved Cloudflare R2 public URL.",
  });

const collageSchema = z.object({
  collage: z
    .array(urlOrPath)
    .length(3, { message: "Provide exactly 3 images." }),
});

function requireAdmin(session: { user?: AuthenticatedUser } | null) {
  const user = session?.user;
  if (!session || user?.role !== "ADMIN") {
    return { ok: false, user: null };
  }
  return { ok: true, user };
}

export async function GET() {
  const session = (await getServerSession(authOptions)) as { user?: AuthenticatedUser } | null;
  const auth = requireAdmin(session);
  if (!auth.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const setting = await prisma.siteSetting.findUnique({
      where: { key: "home.heroCollage" },
    });
    const collage = Array.isArray(setting?.value) ? setting?.value : null;
    return NextResponse.json({
      collage: Array.isArray(collage) && collage.length === 3 ? collage : DEFAULT_HERO_COLLAGE,
      defaults: DEFAULT_HERO_COLLAGE,
    });
  } catch (err) {
    console.error("Failed to load homepage settings:", err);
    return NextResponse.json({ error: "Failed to load settings" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const session = (await getServerSession(authOptions)) as { user?: AuthenticatedUser } | null;
  const auth = requireAdmin(session);
  if (!auth.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-homepage-settings", 60_000, 30);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }
  try {
    const body = await req.json();
    const parsed = collageSchema.parse(body);
    await prisma.siteSetting.upsert({
      where: { key: "home.heroCollage" },
      update: { value: parsed.collage },
      create: { key: "home.heroCollage", value: parsed.collage },
    });
    try {
      await recordAuditLog({
        actorId: auth.user?.id,
        action: "HOMEPAGE_HERO_COLLAGE_UPDATE",
        entityType: "SITE_SETTING",
        entityId: "home.heroCollage",
        meta: { collage: parsed.collage },
      });
    } catch {
      // best-effort
    }
    return NextResponse.json({ ok: true, collage: parsed.collage });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.issues[0]?.message || "Invalid input" }, { status: 400 });
    }
    console.error("Failed to update homepage settings:", err);
    return NextResponse.json({ error: "Failed to update settings" }, { status: 500 });
  }
}
