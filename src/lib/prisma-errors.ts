export function isPrismaUniqueConstraintError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  if (!("code" in error)) return false;
  return (error as { code?: string }).code === "P2002";
}

export function isPrismaRecordNotFoundError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  if (!("code" in error)) return false;
  return (error as { code?: string }).code === "P2025";
}
