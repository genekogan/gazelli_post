export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}
export function need(condition: unknown, code: string, message: string, status = 400): asserts condition {
  if (!condition) throw new ApiError(status, code, message);
}
export function parseJSON(raw: string): any {
  try {
    const value = JSON.parse(raw);
    need(value && typeof value === 'object' && !Array.isArray(value), 'invalid_json', 'Expected a JSON object.');
    return value;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'invalid_json', 'Malformed JSON.');
  }
}
