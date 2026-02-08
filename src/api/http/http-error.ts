export type HttpErrorCode =
  | "validation_error"
  | "not_found"
  | "forbidden"
  | "conflict"
  | "infra_error";

export class HttpError extends Error {
  public readonly statusCode: number;
  public readonly code: HttpErrorCode;
  public readonly details?: unknown;

  constructor(statusCode: number, code: HttpErrorCode, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class ValidationHttpError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(400, "validation_error", message, details);
  }
}

export class NotFoundHttpError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(404, "not_found", message, details);
  }
}

export class ForbiddenHttpError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(403, "forbidden", message, details);
  }
}

export class ConflictHttpError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(409, "conflict", message, details);
  }
}

export class InfraHttpError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(500, "infra_error", message, details);
  }
}

export function isHttpError(value: unknown): value is HttpError {
  return value instanceof HttpError;
}
