import { z } from "zod";

import type { ConnectionRecord, PendingAuthorization } from "./types.js";

export const connectionRecordSchema = z.object({
  oauthClientId: z.string().min(1),
  fhirBaseUrl: z.string().url(),
  tokenEndpoint: z.string().url(),
  revocationEndpoint: z.string().url().optional(),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  tokenType: z.literal("Bearer"),
  expiresAt: z.number().int().positive(),
  scope: z.string(),
  patientId: z.string().min(1),
  fhirUser: z.string().optional(),
  connectedAt: z.number().int().positive(),
  sessionExpiresAt: z.number().int().positive(),
});

const smartConfigurationSchema = z.object({
  authorizationEndpoint: z.string().url(),
  tokenEndpoint: z.string().url(),
  revocationEndpoint: z.string().url().optional(),
  capabilities: z.array(z.string()),
  codeChallengeMethods: z.array(z.string()),
  tokenAuthMethods: z.array(z.string()),
});

const oidcConfigurationSchema = z.object({
  issuer: z.string().url(),
  jwksUri: z.string().url(),
  idTokenAlgorithms: z.array(z.string()),
});

export const pendingAuthorizationSchema = z.object({
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{40,100}$/),
  createdAt: z.number().int().positive(),
  codeVerifier: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  nonce: z.string().min(32).max(512),
  discovery: z.object({
    fhirBaseUrl: z.string().url(),
    smart: smartConfigurationSchema,
    oidc: oidcConfigurationSchema,
  }),
});

export function parseConnectionRecord(value: unknown): ConnectionRecord {
  return connectionRecordSchema.parse(value) as ConnectionRecord;
}

export function parsePendingAuthorization(value: unknown): PendingAuthorization {
  return pendingAuthorizationSchema.parse(value) as PendingAuthorization;
}
