export const hrDocumentAllowedTypes = new Map<string, string>([
  ["application/pdf", ".pdf"],
  ["application/msword", ".doc"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
]);

export function extFromName(name: string) {
  const match = name.toLowerCase().match(/\.[a-z0-9]+$/);
  if (!match) return "";
  return match[0];
}

export function detectFileType(
  buffer: Buffer,
): ".pdf" | ".doc" | ".docx" | ".jpg" | ".png" | ".webp" | "unknown" {
  if (buffer.length >= 4 && buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
    return ".pdf";
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0xd0 &&
    buffer[1] === 0xcf &&
    buffer[2] === 0x11 &&
    buffer[3] === 0xe0 &&
    buffer[4] === 0xa1 &&
    buffer[5] === 0xb1 &&
    buffer[6] === 0x1a &&
    buffer[7] === 0xe1
  ) {
    return ".doc";
  }
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    return ".docx";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return ".jpg";
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return ".png";
  }
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return ".webp";
  }
  return "unknown";
}

export function resolveAndValidateDocumentExt(params: {
  mimeType: string;
  fileName: string;
  detectedExt: string;
}) {
  const extByMime = hrDocumentAllowedTypes.get(params.mimeType || "");
  const extByName = extFromName(params.fileName || "");
  const ext = extByMime || extByName || params.detectedExt;
  if (!ext || ![...hrDocumentAllowedTypes.values()].includes(ext)) {
    return { ok: false as const, error: "Unsupported file type" };
  }
  if (extByMime && extByMime !== params.detectedExt) {
    return { ok: false as const, error: "File type does not match content" };
  }
  if (extByName && extByName !== params.detectedExt) {
    return { ok: false as const, error: "File extension does not match content" };
  }
  return { ok: true as const, ext };
}
