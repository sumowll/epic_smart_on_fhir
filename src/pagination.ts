import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

import { z } from "zod";

import { AppError } from "./errors.js";

const pageCursorSchema = z.object({
  resourceType: z.string().regex(/^[A-Z][A-Za-z0-9]{0,63}$/),
  nextUrl: z.string().url().max(8_192),
  page: z.number().int().min(2).max(10),
  expiresAt: z.number().int().positive(),
  constraints: z.array(z.object({
    name: z.string().min(1).max(128),
    value: z.string().min(1).max(2_048),
  })).max(30).optional(),
  /** True only when the originating search requested the safe Provenance include. */
  includeProvenance: z.literal(true).optional(),
});

export type PageCursor = z.infer<typeof pageCursorSchema>;

interface CursorEnvelope {
  readonly v: 1;
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

function cursorKey(secret: string): Buffer {
  return createHash("sha256").update("epic-fhir-page-cursor\0", "utf8").update(secret, "utf8").digest();
}

function cursorAad(sessionId: string): Buffer {
  return Buffer.from(`epic-fhir-page:v1:${sessionId}`, "utf8");
}

export function encodePageCursor(
  cursor: PageCursor,
  sessionId: string,
  secret: string,
): string {
  const validated = pageCursorSchema.parse(cursor);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", cursorKey(secret), iv);
  cipher.setAAD(cursorAad(sessionId));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(validated), "utf8"),
    cipher.final(),
  ]);
  const envelope: CursorEnvelope = {
    v: 1,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

export function decodePageCursor(
  token: string,
  sessionId: string,
  secret: string,
  now = Date.now(),
): PageCursor {
  if (!token || token.length > 16_384 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new AppError(400, "invalid_page_cursor", "The FHIR page cursor is invalid or expired.");
  }
  try {
    const envelope = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as Partial<CursorEnvelope>;
    if (
      envelope.v !== 1 ||
      typeof envelope.iv !== "string" ||
      typeof envelope.tag !== "string" ||
      typeof envelope.ciphertext !== "string"
    ) {
      throw new Error("Invalid cursor envelope");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      cursorKey(secret),
      Buffer.from(envelope.iv, "base64url"),
    );
    decipher.setAAD(cursorAad(sessionId));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]);
    const cursor = pageCursorSchema.parse(JSON.parse(plaintext.toString("utf8")));
    if (cursor.expiresAt <= now) {
      throw new Error("Expired cursor");
    }
    return cursor;
  } catch (error) {
    throw new AppError(
      400,
      "invalid_page_cursor",
      "The FHIR page cursor is invalid or expired.",
      { cause: error },
    );
  }
}
