import { waitUntil } from "@vercel/functions";
import { createSnapshotHandler } from "../../worker/content_sync.js";

export default createSnapshotHandler({ waitUntil });
