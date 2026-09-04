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

/**
 * The AI allowance is used up, or AI is switched off for this account.
 *
 * Its own code and its own status so the client can say the true thing —
 * "you have reached your AI allowance, the rest of Life OS still works" —
 * rather than the generic "something went wrong" that a 500 would produce.
 * 402 because this is genuinely about an account's budget rather than about
 * permission or a malformed request.
 *
 * `details` carries the numbers, so the interface never has to guess them.
 */
export const allowanceExceeded = (m: string, d?: unknown) =>
  new ApiError(402, 'AI_ALLOWANCE_EXCEEDED', m, d);
