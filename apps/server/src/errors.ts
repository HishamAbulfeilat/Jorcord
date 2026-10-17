import { ErrorCode, NOT_FOUND_ERROR_CODE, STRING_TO_ERROR_CODE, type ApiError as ApiErrorBody, type FieldErrors } from '@jorcord/shared';

export class ApiError extends Error {
  /** Discord-style numeric code (additive to the string `code`). Derived from `code` when not set explicitly. */
  errorCode?: number;
  /** Extra top-level body fields (e.g. `errors`, `retry_after`, `global`). */
  extra?: Record<string, unknown>;
  constructor(public status: number, public code: string, message: string, public details?: unknown, public headers?: Record<string, string>) {
    super(message);
  }
  num(n: number) { this.errorCode = n; return this; }
  with(extra: Record<string, unknown>) { this.extra = { ...this.extra, ...extra }; return this; }
  toBody(): ApiErrorBody {
    return { code: this.code, message: this.message, ...(this.details !== undefined ? { details: this.details } : {}), errorCode: this.errorCode ?? STRING_TO_ERROR_CODE[this.code] ?? ErrorCode.GENERAL, ...this.extra } as ApiErrorBody;
  }
}
export const badRequest = (m: string, details?: unknown) => new ApiError(400, 'BAD_REQUEST', m, details);
export const unauthorized = (m = 'Authentication required', code = 'UNAUTHORIZED') => new ApiError(401, code, m);
export const forbidden = (m = 'Missing permissions', code = 'FORBIDDEN') => new ApiError(403, code, m);
export const notFound = (what = 'Resource') => new ApiError(404, 'NOT_FOUND', `${what} not found`).num(NOT_FOUND_ERROR_CODE[what] ?? ErrorCode.GENERAL);
export const conflict = (m: string, code = 'CONFLICT') => new ApiError(409, code, m);

/** Zod issues -> Discord-style `errors` tree keyed by dotted path. */
export function fieldErrors(issues: { path: (string | number)[]; message: string; code?: string }[]): FieldErrors {
  const out: FieldErrors = {};
  for (const i of issues) {
    const k = i.path.join('.') || '_root';
    (out[k] ??= { _errors: [] })._errors.push({ code: String(i.code ?? 'INVALID').toUpperCase(), message: i.message });
  }
  return out;
}
