import type { Request } from "express";
import { PLAYER_API_SHARED_SECRET } from "../../config";
import { InfraHttpError, UnauthorizedHttpError } from "./http-error";

function getServiceSecret(request: Request): string {
  const headerValue = request.headers["x-player-service-secret"];
  return typeof headerValue === "string" ? headerValue : "";
}

export function requireTrustedService(request: Request): void {
  if (!PLAYER_API_SHARED_SECRET) {
    throw new InfraHttpError("Segredo de serviço não configurado");
  }

  if (getServiceSecret(request) !== PLAYER_API_SHARED_SECRET) {
    throw new UnauthorizedHttpError("Serviço não autorizado");
  }
}