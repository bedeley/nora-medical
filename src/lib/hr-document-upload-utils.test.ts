import test from "node:test";
import assert from "node:assert/strict";
import {
  detectFileType,
  extFromName,
  resolveAndValidateDocumentExt,
} from "@/lib/hr-document-upload-utils";

test("document upload helper extracts extension from filename", () => {
  assert.equal(extFromName("contract.pdf"), ".pdf");
  assert.equal(extFromName("noext"), "");
});

test("document upload helper detects basic file signatures", () => {
  assert.equal(detectFileType(Buffer.from([0x25, 0x50, 0x44, 0x46])), ".pdf");
  assert.equal(detectFileType(Buffer.from([0xff, 0xd8, 0xff, 0x00])), ".jpg");
  assert.equal(detectFileType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), ".png");
});

test("document upload helper rejects mismatched mime/content", () => {
  const mismatch = resolveAndValidateDocumentExt({
    mimeType: "application/pdf",
    fileName: "photo.jpg",
    detectedExt: ".jpg",
  });
  assert.equal(mismatch.ok, false);
});

test("document upload helper resolves valid extension", () => {
  const valid = resolveAndValidateDocumentExt({
    mimeType: "application/pdf",
    fileName: "doc.pdf",
    detectedExt: ".pdf",
  });
  assert.equal(valid.ok, true);
  if (valid.ok) assert.equal(valid.ext, ".pdf");
});
