export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred";
}

export function hasErrorCode(error: unknown, code: string | number): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
