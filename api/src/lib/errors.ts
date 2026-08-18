/** One error shape for the whole API. Never leak internals to the client. */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (m: string, d?: unknown) => new ApiError(400, 'BAD_REQUEST', m, d);
export const unauthorized = (m = 'Authentication required.') => new ApiError(401, 'UNAUTHORIZED', m);
export const forbidden = (m = 'You do not have access to this workspace.') => new ApiError(403, 'FORBIDDEN', m);
export const notFound = (m = 'Not found.') => new ApiError(404, 'NOT_FOUND', m);
export const conflict = (m: string, d?: unknown) => new ApiError(409, 'CONFLICT', m, d);
export const unprocessable = (m: string, d?: unknown) => new ApiError(422, 'UNPROCESSABLE', m, d);
/** Somebody else is having the problem, and it is expected to pass. */
export const upstreamUnavailable = (m: string) => new ApiError(503, 'UPSTREAM_UNAVAILABLE', m);
