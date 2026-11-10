export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isIntegerBetween(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'An unexpected error occurred.';
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
