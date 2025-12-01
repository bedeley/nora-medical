import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Format opaque IDs (orders, users, etc.) into a more
 * human-readable form by uppercasing and inserting dashes
 * every `groupSize` characters, for easier reading over
 * the phone (e.g. ABCD-EFGH-IJKL).
 */
export function formatIdReadable(id: string | null | undefined, groupSize = 4): string {
  if (!id) return "";
  const clean = String(id)
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase();
  if (!clean) return "";
  const parts: string[] = [];
  for (let i = 0; i < clean.length; i += groupSize) {
    parts.push(clean.slice(i, i + groupSize));
  }
  return parts.join("-");
}
