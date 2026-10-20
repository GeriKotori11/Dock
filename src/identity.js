/**
 * Stable host identity.
 *
 * A random UUID is created the first time the host runs and persisted in the
 * data directory, so phones can recognise the same computer across restarts
 * and address changes. It is an identifier, not a secret.
 */

import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { writeFileAtomic } from "./fsutil.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isValidHostId(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Load the host identity from `path`, creating and persisting a new one when
 * the file is missing, unreadable or malformed. Never throws: if the new
 * identity cannot be written, it is still returned for this run.
 * @returns {Promise<{hostId: string}>}
 */
export async function loadHostIdentity({ path } = {}) {
  if (!path) throw new TypeError("loadHostIdentity requires a path");
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (parsed && parsed.version === 1 && isValidHostId(parsed.hostId)) {
      return { hostId: parsed.hostId };
    }
  } catch {
    /* missing or corrupt: regenerate below */
  }
  const hostId = randomUUID();
  try {
    await writeFileAtomic(path, `${JSON.stringify({ version: 1, hostId }, null, 2)}\n`);
  } catch {
    /* read-only data dir: the identity is still usable for this run */
  }
  return { hostId };
}
