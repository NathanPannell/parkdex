/**
 * Classifies the lab photos once and saves a new run.
 * Usage: npm run photo-lab:run -- [--only good-01,people-02] [--based-on <run id>] [--label "..."] [--concurrency 4]
 */
import { parseArgs } from "node:util";
import { classify, labDir, loadManifest } from "./lab.ts";
import { productionSettings, summarize } from "./evaluate.ts";

const { values } = parseArgs({
  options: {
    only: { type: "string" },
    "based-on": { type: "string" },
    label: { type: "string" },
    concurrency: { type: "string", default: "4" },
  },
});

const ids = values.only
  ?.split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const run = await classify({
  ids,
  basedOn: values["based-on"] ?? null,
  label: values.label,
  concurrency: Number(values.concurrency) || 4,
  onProgress: ({ done, total, failed, id }) => process.stdout.write(`\r${done}/${total} (${failed} failed) ${id}        `),
});
process.stdout.write("\n");
const { summary } = summarize(loadManifest(), run, productionSettings());
const spent =
  run.spend.keyUsageBeforeUsd !== null && run.spend.keyUsageAfterUsd !== null
    ? ` (key usage moved by $${(run.spend.keyUsageAfterUsd - run.spend.keyUsageBeforeUsd).toFixed(4)})`
    : "";
console.log(`Saved ${run.id} in ${labDir()}`);
console.log(`Model ${run.model}. Reported cost $${run.spend.reportedCostUsd.toFixed(4)}${spent}.`);
console.log(
  `At production thresholds: ${summary.correct}/${summary.scored} agree, ${summary.falseApprovals.length} false approvals, ${summary.falseRejections.length} false rejections, ${summary.errors} errors.`,
);
