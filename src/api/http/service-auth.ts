import { timingSafeEqual } from "crypto";
import { PLAYER_API_SHARED_SECRET } from "../../config";
import type { Request } from "./context";
import { InfraHttpError, UnauthorizedHttpError } from "./http-error";

function getServiceSecret(request: Request): string {
  const headerValue = request.headers["x-player-service-secret"];
  return typeof headerValue === "string" ? headerValue : "";
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
