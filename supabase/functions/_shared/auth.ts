// supabase/functions/_shared/auth.ts
// Internal Edge Function authentication helpers.

export const INTERNAL_FUNCTION_SECRET_HEADER = 'x-internal-function-secret';

function getEnv(name: string): string {
  try {
    return Deno.env.get(name) || '';
  } catch {
    return '';
  }
}

/**
 * Compare two strings without an early exit on the first differing byte.
 * Length is not secret, while the content comparison is protected from timing leaks.
 */
export function constantTimeEqualText(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const maxLength = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < maxLength; index += 1) {
    difference |= (leftBytes[index] || 0) ^ (rightBytes[index] || 0);
  }

  return difference === 0;
}

/**
 * Validate the internal function secret. Missing configuration fails closed.
 */
export function isValidInternalFunctionRequest(
  request: Request,
  expectedSecret = getEnv('INTERNAL_FUNCTION_SECRET')
): boolean {
  if (!expectedSecret) return false;

  const providedSecret = request.headers.get(INTERNAL_FUNCTION_SECRET_HEADER);
  if (!providedSecret) return false;

  return constantTimeEqualText(providedSecret, expectedSecret);
}
