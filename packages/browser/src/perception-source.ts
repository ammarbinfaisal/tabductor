import { readFileSync } from "node:fs";
/** Also copied into the Python worker image; both drivers evaluate identical source. */
export const PERCEPTION_SCRIPT = readFileSync(new URL("./perception-script.js", import.meta.url), "utf8");
