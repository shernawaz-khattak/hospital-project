// Application errors carry a safe, user-facing message. Anything else that reaches the
// error handler is treated as an internal error and its details are never sent to clients.
export class AppError extends Error {
  constructor(status, message, { code, fields, details } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields; // { fieldName: 'message' }
    this.details = details; // extra structured data safe for the client (e.g. suggestions)
  }
}

export const badRequest = (msg, opts) => new AppError(400, msg, opts);
export const unauthorized = (msg = 'Please sign in to continue.', opts) => new AppError(401, msg, opts);
export const forbidden = (msg = 'You do not have permission to perform this action.', opts) =>
  new AppError(403, msg, { code: 'FORBIDDEN', ...opts });
export const notFound = (msg = 'Record not found.', opts) => new AppError(404, msg, { code: 'NOT_FOUND', ...opts });
export const conflict = (msg, opts) => new AppError(409, msg, { code: 'CONFLICT', ...opts });
export const unprocessable = (msg, opts) => new AppError(422, msg, opts);

// Express 5 forwards rejected promises automatically, but wrapping keeps intent explicit.
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
