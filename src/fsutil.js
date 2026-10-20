/**
 * Small filesystem helpers shared by host state files.
 */

import { writeFile, rename, mkdir, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

/**
 * Write `data` to `path` atomically: write a uniquely named temp file beside
 * it, then rename over the target. The temp file is created with `mode`
 * (owner-only by default) and the rename keeps that mode, so a reader never
 * sees a truncated file and the target is never briefly world-readable.
 */
export async function writeFileAtomic(path, data, { mode = 0o600 } = {}) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, data, { encoding: "utf8", mode, flag: "wx" });
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}
