import { waitUntil } from "@vercel/functions";
import { createSceneHandler } from "../../worker/content_sync.js";

export default createSceneHandler({ waitUntil });
