import { prisma } from "@/lib/prisma";

export const DEFAULT_HERO_COLLAGE = [
  "/uploads/4732787a-8d0a-4ec9-94d9-dd57cca82e3c.jpg",
  "/uploads/2abbfb58-7c4f-4b02-9726-0a148eddfca9.jpg",
  "/uploads/9c57f011-cafc-494e-b44e-1b6fcfd4b231.jpg",
];

function normalizeCollage(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const urls = value.map((entry) => String(entry || "").trim());
  if (urls.length !== 3) return null;
  if (urls.some((url) => !url)) return null;
  return urls;
}

export async function getHeroCollageImages(): Promise<string[]> {
  try {
    const setting = await prisma.siteSetting.findUnique({
      where: { key: "home.heroCollage" },
    });
    const next = normalizeCollage(setting?.value);
    return next ?? DEFAULT_HERO_COLLAGE;
  } catch {
    return DEFAULT_HERO_COLLAGE;
  }
}
