# Pass the full prompt to image generation and bind each result to its call

Recorded: before 2026-10-07. Applies to: generating park, badge or mascot art with the built-in image tool.

## What went wrong

There were several failures:

- A saved prompt filename was passed instead of the prompt text, so renders ran without the style and crop blocks.
- Encoding wrappers failed in the exec runtime before the render even started.
- In parallel runs, the globally newest image was picked instead of the image the call returned, so results were attached to the wrong park.

## Rule

- Pass the full prompt text as the tool's `prompt` argument. Before each park render, confirm the submitted string contains the active style block and the mandatory crop and banner block. If the intended prompt and the submitted one differ, keep both.
- In `functions.exec`, call ImageGen with a plain JavaScript prompt string and explicit reference paths. The runtime has no `TextEncoder`, `btoa` or Node filesystem helpers. Save prompt and receipt files separately with file tools.
- Record each actual call by its call ID and output hash. Preparatory folders and snapshot checks are not renders.
- For parallel work, keep the entire returned result before parsing it, and bind the exact returned file to that call. Never select the newest generated image.
- If receipt handling fails, recover only from that worker's own session and exact call window. Verify visual identity and hash, and disclose the lost receipt. Do not generate again to cover the loss.
- Save each revision at a unique path. Update final metadata only after the PNG and WebP decoded pixels and QA are verified, and leave earlier attempts unchanged.

## How to check

Every render has a receipt with call ID, submitted prompt, output path and hash, and the hash matches the file on disk.

## History

- 2026-10-07: moved from the workspace AGENTS.md. Per-park badge art is being retired; keep this for meta badge and mascot art.
