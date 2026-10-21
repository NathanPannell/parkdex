import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Serves /api from the dashboard handler during local development. With no DATABASE_URL it
 * uses fictional in-memory data, so the UI can be explored without touching a real database.
 */
function devApi(): Plugin {
  return {
    name: "operator-dev-api",
    configureServer(server: ViteDevServer) {
      let handler: ((request: Request) => Promise<Response>) | null = null;
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (!req.url?.startsWith("/api/")) return next();
        if (!handler) {
          const { createDashboardApi } = await server.ssrLoadModule("/server/api.ts");
          const { demoDependencies } = await server.ssrLoadModule("/server/demo.ts");
          const env = {
            ...process.env,
            DASHBOARD_ENVIRONMENT: process.env.DATABASE_URL ? process.env.DASHBOARD_ENVIRONMENT : "local demo",
            EMAIL_MODE: process.env.EMAIL_MODE ?? "disabled",
            ...(process.env.DATABASE_URL ? {} : { STAGING_DATABASE_URL: "demo" }),
          };
          const api = createDashboardApi(process.env.DATABASE_URL ? {} : demoDependencies());
          handler = (request) => api(request, env);
        }
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(key, value);
          const body = chunks.length ? Buffer.concat(chunks) : undefined;
          const response = await handler(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body }));
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch {
          // The browser aborted the request (for example, a component unmounted).
          if (!res.headersSent) res.statusCode = 499;
          res.end();
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), devApi()],
  server: { host: "127.0.0.1" },
  build: { outDir: ".vercel/output/static", emptyOutDir: true },
});
