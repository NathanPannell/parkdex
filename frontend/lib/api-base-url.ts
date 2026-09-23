/** Static web exports use the current origin so deep links never change the API path. */
export function resolveApiBaseUrl(configured: string, origin?: string): string {
  return configured === "." && origin ? origin : configured;
}
