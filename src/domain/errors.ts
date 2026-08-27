/**
 * Typed domain errors. Every error carries a stable `code` (used as the REST error code)
 * and an HTTP status. Never expose `.stack` or internal messages from unexpected/
 * infrastructure errors to clients -- only the mapped code + a safe message.
 */
export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;

  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  readonly code = "VALIDATION_ERROR";
  readonly httpStatus = 400;
}

export class AuthenticationError extends AppError {
  readonly code = "AUTHENTICATION_ERROR";
  readonly httpStatus = 401;
}

export class NotFoundError extends AppError {
  readonly code = "NOT_FOUND";
  readonly httpStatus = 404;
}

export class PayloadTooLargeError extends AppError {
  readonly code = "PAYLOAD_TOO_LARGE";
  readonly httpStatus = 413;
}

export class InternalError extends AppError {
  readonly code = "INTERNAL_ERROR";
  readonly httpStatus = 500;
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/** Duck-types a Zod error without importing zod here, keeping this module dependency-free. */
function isZodError(err: unknown): err is { issues: { path: (string | number)[]; message: string }[] } {
  return typeof err === "object" && err !== null && "issues" in err && Array.isArray((err as { issues: unknown }).issues);
}

/** Normalizes any thrown value into an AppError. */
export function toAppError(err: unknown): AppError {
  if (isAppError(err)) return err;

  if (isZodError(err)) {
    return new ValidationError(err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }

  const message = err instanceof Error ? err.message : "Unknown error";
  return new InternalError(message, err);
}
