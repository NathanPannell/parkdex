// The esbuild options for the dashboard's one Edge Function. scripts/build.mjs uses them for the
// deployment, and server/edge.test.ts builds the same bundle to run its fetch paths.
import path from "node:path";

export function edgeBuildOptions(root, outfile) {
  return {
    entryPoints: [path.join(root, "server", "edge.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["worker", "browser"],
    // Worker modules import the database driver from outside this folder.
    nodePaths: [path.join(root, "node_modules")],
    // worker/db.ts records queries per request with AsyncLocalStorage, which the Edge runtime
    // provides as node:async_hooks; leave it to the runtime instead of bundling it.
    external: ["node:async_hooks"],
    define: { "process.env.NODE_ENV": '"production"' },
    legalComments: "none",
    logLevel: "warning",
  };
}
