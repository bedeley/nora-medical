import zlib from "zlib";

function safeInflate(input: Buffer) {
  try {
    return zlib.inflateSync(input);
  } catch {
    try {
      return zlib.inflateRawSync(input);
    } catch {
      return null;
    }
  }
}

function decodePdfString(value: string) {
  return value
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\\t/g, " ")
    .replace(/\\\\/g, "\\");
}

function extractTextOperators(content: string) {
  const parts: string[] = [];
  const tjMatches = content.match(/\((?:\\.|[^\\)])*\)\s*Tj/g) || [];
  for (const token of tjMatches) {
    const m = token.match(/\(((?:\\.|[^\\)])*)\)\s*Tj/);
    if (m?.[1]) parts.push(decodePdfString(m[1]));
  }

  const tjArrayMatches = content.match(/\[(.*?)\]\s*TJ/gs) || [];
  for (const token of tjArrayMatches) {
    const inner = token.match(/\[(.*?)\]\s*TJ/s)?.[1] || "";
    const bits = inner.match(/\((?:\\.|[^\\)])*\)/g) || [];
    for (const bit of bits) {
      const raw = bit.slice(1, -1);
      parts.push(decodePdfString(raw));
    }
  }
  return parts;
}

export function extractTextFromPdfBuffer(buffer: Buffer) {
  const textParts: string[] = [];
  const full = buffer.toString("latin1");

  const streams = full.match(/stream[\r\n]+([\s\S]*?)endstream/g) || [];
  for (const rawStream of streams) {
    const body = rawStream
      .replace(/^stream[\r\n]+/, "")
      .replace(/endstream$/, "");
    const compressed = Buffer.from(body, "latin1");
    const inflated = safeInflate(compressed);
    const content = (inflated || compressed).toString("latin1");
    textParts.push(...extractTextOperators(content));
  }

  if (textParts.length === 0) {
    // Fallback for uncompressed/simple PDFs.
    textParts.push(...extractTextOperators(full));
  }

  return textParts
    .join("\n")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
