import { createNeonAccountAuthStore } from "../../../worker/accounts/auth-store.js";
import { deleteAccountData } from "../../../worker/accounts/photos.js";
import type { DashboardEnv } from "../api.js";

/**
 * Account deletion from the dashboard runs the app's own steps after the operator's begin step:
 * deleteAccountData (snapshot the private photo keys, delete claims, ask the photo service to
 * delete every object, record failures) and then completeDeletion (delete the account row,
 * which cascades to sessions, game rows and founded parks). worker/accounts/auth.ts
 * resumeAccountDeletion does the same, but it also loads argon2 and Google sign-in, which the
 * Edge runtime cannot run, so these few lines repeat its order instead of importing it.
 */

export interface AccountDeletionEnv {
  /** Production photo service, the same values the app's API uses. */
  KIP_PHOTO_SERVICE_URL?: string;
  KIP_PHOTO_SERVICE_TOKEN?: string;
  /** Staging photo service, used while the toggle shows staging. */
  STAGING_KIP_PHOTO_SERVICE_URL?: string;
  STAGING_KIP_PHOTO_SERVICE_TOKEN?: string;
}

export interface PhotoService {
  url: string;
  token: string;
}

export interface DeletionSetup {
  available: boolean;
  /** Settings this deployment still needs for the selected database. */
  missing: string[];
}

/** The photo service of the database the operator is looking at. Never mixes environments. */
export function photoServiceFor(baseEnv: DashboardEnv, staging: boolean): { service: PhotoService | null; setup: DeletionSetup } {
  const urlName = staging ? "STAGING_KIP_PHOTO_SERVICE_URL" : "KIP_PHOTO_SERVICE_URL";
  const tokenName = staging ? "STAGING_KIP_PHOTO_SERVICE_TOKEN" : "KIP_PHOTO_SERVICE_TOKEN";
  const url = baseEnv[urlName]?.trim() ?? "";
  const token = baseEnv[tokenName]?.trim() ?? "";
  const missing = [...(url ? [] : [urlName]), ...(token ? [] : [tokenName])];
  return { service: missing.length ? null : { url, token }, setup: { available: missing.length === 0, missing } };
}

export interface AccountDeleter {
  /** Runs (or reruns) the data and photo cleanup for an open receipt. */
  resume(receiptId: string): Promise<"pending" | "complete">;
}

/**
 * The app's photo client asks for `redirect: "error"`, which the Vercel Edge runtime refuses with
 * a TypeError before any request goes out, so every cleanup from the dashboard failed. Ask for
 * "manual" instead and answer a redirect as a 502, which deleteAccountData records as a failed
 * attempt, so a redirect is still never followed.
 */
export function edgeSafeFetch(inner: typeof fetch = fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const strict = init.redirect === "error";
    const response = await inner(input, strict ? { ...init, redirect: "manual" } : init);
    if (strict && (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400))) {
      return new Response(null, { status: 502 });
    }
    return response;
  }) as typeof fetch;
}

export function createAccountDeleter(databaseUrl: string, photo: PhotoService, fetchFn?: typeof fetch): AccountDeleter {
  return {
    async resume(receiptId) {
      const auth = createNeonAccountAuthStore(databaseUrl);
      const receipt = await auth.findDeletionReceipt(receiptId);
      if (!receipt) return "pending";
      if (receipt.status === "complete") return "complete";
      let complete = false;
      try {
        ({ complete } = await deleteAccountData(
          { accountId: receipt.accountId, receiptId },
          { DATABASE_URL: databaseUrl, KIP_PHOTO_SERVICE_URL: photo.url, KIP_PHOTO_SERVICE_TOKEN: photo.token },
          { fetch: edgeSafeFetch(fetchFn ?? fetch) },
        ));
      } catch {
        complete = false;
      }
      if (!complete) return "pending";
      return await auth.completeDeletion(receiptId, new Date().toISOString()) ? "complete" : "pending";
    },
  };
}
