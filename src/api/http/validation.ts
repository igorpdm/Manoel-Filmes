import { ValidationHttpError } from "./http-error";

type UnknownObject = Record<string, unknown>;

export function requireObject(value: unknown, fieldName = "body"): UnknownObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationHttpError(`${fieldName} inválido`);
  }
  return value as UnknownObject;
}

export function requireNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new ValidationHttpError(`${fieldName} deve ser texto`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new ValidationHttpError(`${fieldName} é obrigatório`);
  }
  return normalized;
}

export function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

export function requireNumberInRange(
  value: unknown,
  fieldName: string,
  min: number,
  max: number
): number {
  if (typeof value !== "number" || Number.isNaN(value) || !Number.isFinite(value)) {
    throw new ValidationHttpError(`${fieldName} deve ser número`);
  }
  if (value < min || value > max) {
    throw new ValidationHttpError(`${fieldName} deve estar entre ${min} e ${max}`);
  }
  return value;
}
