import { timingSafeEqual } from "crypto";
import { PLAYER_API_SHARED_SECRET } from "../../config";
import type { Request } from "./context";
import { InfraHttpError, UnauthorizedHttpError } from "./http-error";

export const SERVICE_SECRET_HEADER = "x-player-service-secret";

function getServiceSecret(request: Request): string {
  const headerValue = request.headers[SERVICE_SECRET_HEADER];
  return typeof headerValue === "string" ? headerValue.trim() : "";
}

export function getServiceSecretFromHeaders(headers: globalThis.Headers): string {
  return headers.get(SERVICE_SECRET_HEADER)?.trim() || "";
}

export function hasServiceSecret(request: Request): boolean {
  return getServiceSecret(request).length > 0;
}

export function isTrustedServiceSecret(candidate: string): boolean {
  if (!PLAYER_API_SHARED_SECRET || !candidate) {
    return false;
  }

  return compareSecrets(candidate, PLAYER_API_SHARED_SECRET);
}

export function requireTrustedService(request: Request): void {
  if (!PLAYER_API_SHARED_SECRET) {
    throw new InfraHttpError("Segredo de serviço não configurado");
  }

  if (!compareSecrets(getServiceSecret(request), PLAYER_API_SHARED_SECRET)) {
    throw new UnauthorizedHttpError("Serviço não autorizado");
  }
}

function compareSecrets(candidate: string, expected: string): boolean {
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);

  return candidateBuffer.length === expectedBuffer.length && timingSafeEqual(candidateBuffer, expectedBuffer);
}
