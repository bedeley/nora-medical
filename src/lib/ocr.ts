type OcrResult = {
  ok: boolean;
  text?: string;
  error?: string;
};

function cleanExtractedText(input: string) {
  return input
    .replace(/\r/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function extractTextWithOcrSpace(params: {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}): Promise<OcrResult> {
  const apiKey = (process.env.OCR_SPACE_API_KEY || "").trim();
  if (!apiKey) return { ok: false, error: "OCR not configured (missing OCR_SPACE_API_KEY)" };

  try {
    const fd = new FormData();
    fd.set("apikey", apiKey);
    fd.set("OCREngine", "2");
    fd.set("isOverlayRequired", "false");
    fd.set("detectOrientation", "true");
    fd.set("scale", "true");
    fd.set("language", "eng");
    const bytes = new Uint8Array(params.buffer);
    fd.set("file", new Blob([bytes], { type: params.mimeType }), params.filename);

    const response = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      body: fd,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return { ok: false, error: body || `OCR provider error ${response.status}` };
    }

    const payload = (await response.json().catch(() => null)) as
      | {
          IsErroredOnProcessing?: boolean;
          ErrorMessage?: string[] | string;
          ParsedResults?: Array<{ ParsedText?: string }>;
        }
      | null;
    if (!payload) return { ok: false, error: "Invalid OCR response" };
    if (payload.IsErroredOnProcessing) {
      const msg = Array.isArray(payload.ErrorMessage)
        ? payload.ErrorMessage.join("; ")
        : payload.ErrorMessage || "OCR processing failed";
      return { ok: false, error: msg };
    }

    const text = cleanExtractedText(
      (payload.ParsedResults || [])
        .map((row) => row.ParsedText || "")
        .join("\n"),
    );
    if (!text) return { ok: false, error: "No OCR text detected" };
    return { ok: true, text };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "OCR request failed",
    };
  }
}
