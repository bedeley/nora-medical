import zlib from "zlib";

function readUInt16LE(buffer: Buffer, offset: number) {
  if (offset + 2 > buffer.length) return null;
  return buffer.readUInt16LE(offset);
}

function readUInt32LE(buffer: Buffer, offset: number) {
  if (offset + 4 > buffer.length) return null;
  return buffer.readUInt32LE(offset);
}

function xmlToText(xml: string) {
  return xml
    .replace(/<w:tab\b[^>]*\/>/g, "\t")
    .replace(/<w:br\b[^>]*\/>/g, "\n")
    .replace(/<w:cr\b[^>]*\/>/g, "\n")
    .replace(/<w:p\b[^>]*>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getZipEntryDataByName(buffer: Buffer, name: string): Buffer | null {
  let offset = 0;
  const sig = 0x04034b50;
  while (offset + 30 <= buffer.length) {
    const signature = readUInt32LE(buffer, offset);
    if (signature == null || signature !== sig) break;
    const compressionMethod = readUInt16LE(buffer, offset + 8);
    const compressedSize = readUInt32LE(buffer, offset + 18);
    const fileNameLength = readUInt16LE(buffer, offset + 26);
    const extraFieldLength = readUInt16LE(buffer, offset + 28);
    if (
      compressionMethod == null ||
      compressedSize == null ||
      fileNameLength == null ||
      extraFieldLength == null
    ) {
      return null;
    }
    const fileNameStart = offset + 30;
    const fileNameEnd = fileNameStart + fileNameLength;
    const dataStart = fileNameEnd + extraFieldLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) return null;

    const entryName = buffer.toString("utf8", fileNameStart, fileNameEnd);
    if (entryName === name) {
      const data = buffer.subarray(dataStart, dataEnd);
      if (compressionMethod === 0) return data;
      if (compressionMethod === 8) {
        try {
          return zlib.inflateRawSync(data);
        } catch {
          return null;
        }
      }
      return null;
    }
    offset = dataEnd;
  }
  return null;
}

export function extractTextFromDocxBuffer(buffer: Buffer) {
  const xmlBuffer = getZipEntryDataByName(buffer, "word/document.xml");
  if (!xmlBuffer) return "";
  const xml = xmlBuffer.toString("utf8");
  return xmlToText(xml);
}

