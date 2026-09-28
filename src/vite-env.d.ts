/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_CONTENT_API_URL?: string;
  readonly VITE_CONTENT_ENV?: "staging" | "main" | "preview";
}
declare const __APP_BUILD__: string;
