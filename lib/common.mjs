export class UserError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export const MAX_BYTES = 1024 ** 3;
export const MAX_SECONDS = 30 * 60;
// Log identifiers and error types, never provider bodies, keys or meeting contents.
export function logError(context, error) {
  console.error(JSON.stringify({ time: new Date().toISOString(), context,
    type: error?.name, code: error?.code || error?.cause?.code, status: error?.status }));
}
