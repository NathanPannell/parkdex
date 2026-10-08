import { waitUntil } from "@vercel/functions";
import { createChangesHandler } from "../../worker/content_sync.js";

export default createChangesHandler({ waitUntil });
