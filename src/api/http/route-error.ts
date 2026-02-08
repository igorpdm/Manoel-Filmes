import type { Response } from "express";
import { logger } from "../../shared/logger";
import { isHttpError } from "./http-error";

export function sendRouteError(res: Response, error: unknown, context: string): void {
  if (isHttpError(error)) {
    logger.warn(context, `${error.code}: ${error.message}`, error.details);
    res.status(error.statusCode).json({
      error: error.message,
      code: error.code,
    });
    return;
  }

  logger.error(context, "Erro interno inesperado", error);
  res.status(500).json({
    error: "Erro interno do servidor",
    code: "infra_error",
  });
}
