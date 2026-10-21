/**
 * Media artwork helpers shared by the providers and the host.
 *
 * The phone never loads artwork from the internet: a provider mints an opaque
 * key per track, the host serves `/api/media/artwork?key=` and the provider
 * fetches or extracts the image itself. These helpers keep that path narrow:
 * keys are hashes, remote fetches go to one allowlisted https host with no
 * redirects and a size cap, and only real PNG/JPEG bytes are passed on.
 */

import { createHash } from "node:crypto";

/** Largest edge the host serves. */
export const ARTWORK_MAX_PX = 512;
/** An image whose larger edge is at most this may be served as is when it cannot be resized. */
export const ARTWORK_KEEP_PX = 640;
/** Upper bound on any artwork payload, fetched or extracted. */
export const ARTWORK_MAX_BYTES = 2 * 1024 * 1024;
export const ARTWORK_FETCH_TIMEOUT_MS = 8_000;
/** The only host Spotify artwork URLs may point at. */
export const SPOTIFY_ARTWORK_HOST = "i.scdn.co";

/** A 32-hex artwork key from the given parts (stable per track). */
export function artworkKey(...parts) {
  return createHash("sha256").update(parts.map((p) => String(p ?? "")).join("\u0000")).digest("hex").slice(0, 32);
}

/** The URL when it is an https URL on the Spotify artwork host, else null. */
export function spotifyArtworkUrl(value) {
  if (typeof value !== "string" || value.length > 512) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== SPOTIFY_ARTWORK_HOST || url.port || url.username || url.password) return null;
  return url.href;
}

/** `{ mime, width, height }` for PNG or JPEG bytes, else null. */
export function imageInfo(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24) return null;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { mime: "image/png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  // Walk JPEG segments to the first start-of-frame marker.
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const length = bytes.readUInt16BE(i + 2);
    if (length < 2) return null;
    const sof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (sof) return { mime: "image/jpeg", width: bytes.readUInt16BE(i + 7), height: bytes.readUInt16BE(i + 5) };
    i += 2 + length;
  }
  return null;
}

/**
 * Fetch artwork bytes from an allowlisted Spotify URL. No redirects (a
 * redirect could leave the allowlist), a hard timeout and a byte cap.
 * Returns a Buffer of PNG/JPEG bytes or null.
 */
export async function fetchSpotifyArtwork(value, { fetchImpl = globalThis.fetch, timeoutMs = ARTWORK_FETCH_TIMEOUT_MS } = {}) {
  const url = spotifyArtworkUrl(value);
  if (!url || typeof fetchImpl !== "function") return null;
  let res;
  try {
    res = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(timeoutMs), headers: { accept: "image/jpeg, image/png" } });
  } catch {
    return null;
  }
  if (!res?.ok) return null;
  const declared = Number(res.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > ARTWORK_MAX_BYTES) return null;
  let bytes;
  try {
    bytes = Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
  if (bytes.length > ARTWORK_MAX_BYTES || !imageInfo(bytes)) return null;
  return bytes;
}
