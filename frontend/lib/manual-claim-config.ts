const PREVIEW_API_HOST = /^api-lp-pr-\d+-[0-9a-f]{8}-[0-9a-f]{8}\.up\.railway\.app$/;

export function manualClaimEnabledForApi(apiBaseUrl: string, flag: string | undefined): boolean {
  if (flag === "1") return true;
  try {
    const url = new URL(apiBaseUrl);
    return url.protocol === "https:" && PREVIEW_API_HOST.test(url.hostname);
  } catch {
    return false;
  }
}
