import type { ApiError as ApiErrorBody } from '@jorcord/shared';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown, public headers?: Record<string, string>) {
    super(message);
  }
  toBody(): ApiErrorBody { return { code: this.code, message: this.message, ...(this.details !== undefined ? { details: this.details } : {}) }; }
}
export const badRequest = (m: string, details?: unknown) => new ApiError(400, 'BAD_REQUEST', m, details);
export const unauthorized = (m = 'Authentication required', code = 'UNAUTHORIZED') => new ApiError(401, code, m);
export const forbidden = (m = 'Missing permissions', code = 'FORBIDDEN') => new ApiError(403, code, m);
export const notFound = (what = 'Resource') => new ApiError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (m: string, code = 'CONFLICT') => new ApiError(409, code, m);
