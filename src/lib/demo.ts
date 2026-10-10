/**
 * Demo tools move the player without real GPS (teleport, simulated trips). The server does
 * not check where a visit came from, so on a hosted build they would let anyone take any
 * park. They exist only in dev builds, or in a local build that opts in explicitly.
 */

type DemoEnv = { DEV?: boolean; VITE_FIELD?: string; VITE_DEMO_TOOLS?: string };

export function demoToolsAllowed(env: DemoEnv | undefined): boolean {
  if (!env || env.VITE_FIELD === "1") return false;
  return env.DEV === true || env.VITE_DEMO_TOOLS === "1";
}

/** Refuses a hosted build that opts in to demo tools, so the switch can only help local testing. */
export function assertDemoToolsBuild(env: Record<string, string | undefined>, hosted: boolean): void {
  if (hosted && env.VITE_DEMO_TOOLS === "1") {
    throw new Error("VITE_DEMO_TOOLS=1 is for local builds only. Hosted builds must not ship demo tools.");
  }
}

export const DEMO_TOOLS = demoToolsAllowed(import.meta.env as DemoEnv | undefined);
