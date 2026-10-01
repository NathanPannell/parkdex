/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_CONTENT_API_URL?: string;
  readonly VITE_CONTENT_ENV?: "staging" | "main" | "preview";
  readonly VITE_PREVIEW_API_ORIGIN?: string;
  readonly VITE_GOOGLE_WEB_CLIENT_ID?: string;
  readonly VITE_ACCOUNT_API_URL?: string;
  readonly VITE_FEEDBACK_API_URL?: string;
  readonly VITE_APP_URL?: string;
  readonly VITE_CONFIG_API_URL?: string;
}
declare const __APP_BUILD__: string;
