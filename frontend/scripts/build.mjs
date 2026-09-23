import { runNextBuild } from "./run-next-build.mjs";

process.exit(await runNextBuild(process.env));
