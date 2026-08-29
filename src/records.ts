import { z } from "zod";

import type { ConnectionRecord, PendingAuthorization } from "./types.js";

const consentReceiptSchema = z.object({
  policyVersion: z.string().min(1).max(100),
  acceptedAt: z.number().int().positive(),
  purpose: z.literal("patient-access"),
  requestedScopes: z.array(z.string().min(1).max(2_048)).max(256),
  allowedResourceScopes: z.array(z.string().min(1).max(2_048)).max(256).optional(),
});

const fhirResourceCapabilitySchema = z.object({
  resourceType: z.string().regex(/^[A-Z][A-Za-z0-9]{0,63}$/),
  interactions: z.array(z.enum(["read", "search"])).max(2),
  searchParameters: z.array(z.string().min(1).max(128)).max(256),
  // Optional keeps connection rows created before reverse-include discovery readable.
  searchRevIncludes: z.array(z.string().min(1).max(256)).max(256).optional(),
});

export const connectionRecordSchema = z.object({
  oauthClientId: z.string().min(1),
  tokenAuthMethod: z.enum(["client_secret_basic", "private_key_jwt", "none"]).optional(),
  fhirBaseUrl: z.string().url(),
  tokenEndpoint: z.string().url(),
  revocationEndpoint: z.string().url().optional(),
  accessToken: z.string().min(1).max(128 * 1024),
  refreshToken: z.string().min(1).max(128 * 1024).optional(),
  tokenType: z.literal("Bearer"),
  expiresAt: z.number().int().positive(),
  scope: z.string().max(32 * 1024),
  patientId: z.string().min(1).max(512),
  fhirUser: z.string().max(2_048).optional(),
  oidcIssuer: z.string().url().optional(),
  oidcSubject: z.string().min(1).max(1_024).optional(),
  consent: consentReceiptSchema.optional(),
  fhirCapabilities: z.array(fhirResourceCapabilitySchema).max(256).optional(),
  connectedAt: z.number().int().positive(),
  lastAccessAt: z.number().int().positive().optional(),
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
  oauthClientId: z.string().min(1).max(1_024).optional(),
  redirectUri: z.string().url().max(2_048).optional(),
  tokenAuthMethod: z.enum(["client_secret_basic", "private_key_jwt", "none"]).optional(),
  codeVerifier: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  nonce: z.string().min(32).max(512),
  consent: consentReceiptSchema,
  discovery: z.object({
    fhirBaseUrl: z.string().url(),
    smart: smartConfigurationSchema,
    oidc: oidcConfigurationSchema,
    fhirVersion: z.string().min(1).max(50),
    fhirCapabilities: z.array(fhirResourceCapabilitySchema).max(256),
  }),
});

export function parseConnectionRecord(value: unknown): ConnectionRecord {
  return connectionRecordSchema.parse(value) as ConnectionRecord;
}

export function parsePendingAuthorization(value: unknown): PendingAuthorization {
  return pendingAuthorizationSchema.parse(value) as PendingAuthorization;
}
