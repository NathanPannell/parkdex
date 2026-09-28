import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderOperatorEmail, renderReceiptEmail, type FeedbackEmailReport } from "../worker/emails.ts";

const appUrl = process.argv[2] ?? "http://localhost:5190";
const outDir = resolve(".codex/email-previews");

const previewReport: FeedbackEmailReport = {
  id: "fb_demo_32f07a91c",
  kind: "bug",
  message: "PREVIEW SAMPLE: At 200% text size on a small phone, the final walking direction slips below the park sheet. I have to close the sheet to read it. Could the route stay visible while the sheet is open?",
  email: "walker@example.test",
  contact: true,
  context: {
    version: "0.8.4",
    build: "issue1-staging.20260927.3",
    platform: "iOS 18.5 / Safari inside the Parkdex app",
    screen: "Park details with the walking route open",
    parkId: "park-goldstream",
    parkName: "Goldstream Provincial Park, Vancouver Island",
  },
  createdAt: "2026-09-27T23:42:00.000Z",
  hasScreenshot: true,
};

function runSafetyChecks(): void {
  const hostileMessage = '<img src=x onerror="alert(1)"><script>bad()</script>';
  const hostileEmail = 'walker@example.test"><img src=x onerror="alert(2)">';
  const hostileReport = {
    ...previewReport,
    id: 'R" onmouseover="alert(3)&<script>',
    message: hostileMessage,
    email: hostileEmail,
    context: { ...previewReport.context, screen: '<svg onload="alert(4)">' },
  };

  const operator = renderOperatorEmail(hostileReport, { appUrl });
  const receipt = renderReceiptEmail(hostileReport, { appUrl });
  const noPermission = renderOperatorEmail({ ...previewReport, contact: false }, { appUrl });

  assert.ok(operator.html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
  assert.ok(operator.html.includes("walker@example.test&quot;&gt;&lt;img src=x onerror=&quot;alert(2)&quot;&gt;"));
  assert.ok(operator.html.includes("&lt;svg onload=&quot;alert(4)&quot;&gt;"));
  assert.ok(!operator.html.includes('<img src=x onerror="alert(1)">'));
  assert.ok(!operator.html.includes('<svg onload="alert(4)">'));
  assert.ok(!operator.html.includes('href="javascript:'));
  assert.ok(operator.html.includes("feedback/review?id=R%22+onmouseover%3D%22alert%283%29%26%3Cscript%3E#attachment"));
  assert.ok(operator.html.includes("View protected screenshot in private report"));
  assert.ok(operator.html.includes("Follow-up permitted."));
  assert.ok(operator.text.includes("The message:"));
  assert.ok(operator.text.includes(hostileMessage));
  assert.ok(operator.text.includes("Follow-up permitted at"));
  assert.ok(noPermission.html.includes("Follow-up not permitted."));
  assert.ok(noPermission.text.includes("Contact: Follow-up not permitted"));

  assert.ok(!receipt.html.includes(hostileMessage));
  assert.ok(!receipt.text.includes(hostileMessage));
  assert.ok(!receipt.html.includes(hostileEmail));
  assert.ok(!receipt.text.includes(hostileEmail));
  assert.ok(!receipt.html.includes(previewReport.context.parkName!));
  assert.ok(!receipt.html.includes(previewReport.context.build!));
  assert.ok(receipt.html.includes("Your feedback has been saved."));
  assert.ok(receipt.html.includes("Feedback receipt"));
  assert.ok(receipt.text.includes("Feedback type: Bug report"));

  assert.throws(
    () => renderReceiptEmail(previewReport, { appUrl: "javascript:alert(1)" }),
    /HTTP or HTTPS/i,
  );
}

async function main(): Promise<void> {
  runSafetyChecks();
  await mkdir(outDir, { recursive: true });

  const operator = renderOperatorEmail(previewReport, { appUrl });
  const receipt = renderReceiptEmail(previewReport, { appUrl });
  await Promise.all([
    writeFile(resolve(outDir, "operator.html"), operator.html, "utf8"),
    writeFile(resolve(outDir, "receipt.html"), receipt.html, "utf8"),
  ]);

  console.log(`Email safety checks passed. Previews written to ${outDir}`);
}

void main();
