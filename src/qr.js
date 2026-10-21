/**
 * QR Code encoder (byte mode, error correction level M, versions 1–10) and the
 * WinDock pairing payload (docs/design/HOST-CONTROL-PAGE.md, section 9).
 *
 * The encoder is a reduced port of Project Nayuki's "QR Code generator
 * library" (TypeScript/JavaScript edition), https://www.nayuki.io/page/qr-code-generator-library,
 * keeping only what the pairing code needs: one byte-mode segment, ECC level
 * M, versions 1 to 10, and automatic mask selection by the standard penalty
 * rules. Function names follow the original so the two can be compared.
 *
 * Original copyright and license (MIT):
 *
 *   Copyright (c) Project Nayuki. (MIT License)
 *   https://www.nayuki.io/page/qr-code-generator-library
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy of
 *   this software and associated documentation files (the "Software"), to deal in
 *   the Software without restriction, including without limitation the rights to
 *   use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 *   the Software, and to permit persons to whom the Software is furnished to do so,
 *   subject to the following conditions:
 *   - The above copyright notice and this permission notice shall be included in
 *     all copies or substantial portions of the Software.
 *   - The Software is provided "as is", without warranty of any kind, express or
 *     implied, including but not limited to the warranties of merchantability,
 *     fitness for a particular purpose and noninfringement. In no event shall the
 *     authors or copyright holders be liable for any claim, damages or other
 *     liability, whether in an action of contract, tort or otherwise, arising from,
 *     out of or in connection with the Software or the use or other dealings in the
 *     Software.
 */

export const MIN_VERSION = 1;
export const MAX_VERSION = 10;
/** Modules of light margin around the symbol (drawn by the page's viewBox). */
export const QUIET_ZONE = 4;

// Error correction level M, indexed by version (index 0 unused).
const ECC_CODEWORDS_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const NUM_ERROR_CORRECTION_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
// Alignment pattern centre coordinates, indexed by version.
const ALIGNMENT_POSITIONS = [
  null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];
const ECL_M_FORMAT_BITS = 0; // L=1, M=0, Q=3, H=2
const MODE_BYTE = 0x4;

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

function getBit(x, i) {
  return ((x >>> i) & 1) !== 0;
}

/** Data and ECC bits available in a symbol of this version (excludes function modules). */
function getNumRawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

/** 8-bit data codewords at ECC level M. */
export function getNumDataCodewords(ver) {
  return Math.floor(getNumRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[ver] * NUM_ERROR_CORRECTION_BLOCKS[ver];
}

/** Character count bits for a byte-mode segment. */
function numCharCountBits(ver) {
  return ver <= 9 ? 8 : 16;
}

/** Largest byte payload a version holds at ECC level M. */
export function byteCapacity(ver) {
  return Math.floor((getNumDataCodewords(ver) * 8 - 4 - numCharCountBits(ver)) / 8);
}

// ---- Reed–Solomon over GF(2^8 / 0x11D) ----

function reedSolomonMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function reedSolomonComputeDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < result.length; j += 1) {
      result[j] = reedSolomonMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = reedSolomonMultiply(root, 0x02);
  }
  return result;
}

function reedSolomonComputeRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] ^= reedSolomonMultiply(coef, factor);
    });
  }
  return result;
}

// ---- the symbol ----

function createSymbol(version) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));

  const setFunctionModule = (x, y, isDark) => {
    modules[y][x] = isDark;
    isFunction[y][x] = true;
  };

  function drawFormatBits(mask) {
    const data = (ECL_M_FORMAT_BITS << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    // First copy, around the top-left finder.
    for (let i = 0; i <= 5; i += 1) setFunctionModule(8, i, getBit(bits, i));
    setFunctionModule(8, 7, getBit(bits, 6));
    setFunctionModule(8, 8, getBit(bits, 7));
    setFunctionModule(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i += 1) setFunctionModule(14 - i, 8, getBit(bits, i));
    // Second copy, split between the other two finders.
    for (let i = 0; i < 8; i += 1) setFunctionModule(size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i += 1) setFunctionModule(8, size - 15 + i, getBit(bits, i));
    setFunctionModule(8, size - 8, true); // always dark
  }

  function drawVersion() {
    if (version < 7) return;
    let rem = version;
    for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i += 1) {
      const bit = getBit(bits, i);
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunctionModule(a, b, bit);
      setFunctionModule(b, a, bit);
    }
  }

  function drawFinderPattern(x, y) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) setFunctionModule(xx, yy, dist !== 2 && dist !== 4);
      }
    }
  }

  function drawAlignmentPattern(x, y) {
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }

  function drawFunctionPatterns() {
    for (let i = 0; i < size; i += 1) {
      setFunctionModule(6, i, i % 2 === 0);
      setFunctionModule(i, 6, i % 2 === 0);
    }
    drawFinderPattern(3, 3);
    drawFinderPattern(size - 4, 3);
    drawFinderPattern(3, size - 4);
    const pos = ALIGNMENT_POSITIONS[version];
    const n = pos.length;
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        drawAlignmentPattern(pos[i], pos[j]);
      }
    }
    drawFormatBits(0); // placeholder, overwritten once the mask is chosen
    drawVersion();
  }

  function drawCodewords(data) {
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert += 1) {
        for (let j = 0; j < 2; j += 1) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!isFunction[y][x] && i < data.length * 8) {
            modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
            i += 1;
          }
        }
      }
    }
  }

  function applyMask(mask) {
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        let invert;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          case 7: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: throw new RangeError("mask out of range");
        }
        if (!isFunction[y][x] && invert) modules[y][x] = !modules[y][x];
      }
    }
  }

  function finderPenaltyCountPatterns(runHistory) {
    const n = runHistory[1];
    const core = n > 0 && runHistory[2] === n && runHistory[3] === n * 3 && runHistory[4] === n && runHistory[5] === n;
    return (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0)
      + (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0);
  }

  function finderPenaltyAddHistory(currentRunLength, runHistory) {
    let length = currentRunLength;
    if (runHistory[0] === 0) length += size; // add light border to the initial run
    runHistory.pop();
    runHistory.unshift(length);
  }

  function finderPenaltyTerminateAndCount(currentRunColor, currentRunLength, runHistory) {
    let length = currentRunLength;
    if (currentRunColor) {
      finderPenaltyAddHistory(length, runHistory);
      length = 0;
    }
    length += size; // add light border to the final run
    finderPenaltyAddHistory(length, runHistory);
    return finderPenaltyCountPatterns(runHistory);
  }

  function getPenaltyScore() {
    let result = 0;
    for (let pass = 0; pass < 2; pass += 1) {
      // pass 0: rows; pass 1: columns
      for (let a = 0; a < size; a += 1) {
        let runColor = false;
        let run = 0;
        const runHistory = [0, 0, 0, 0, 0, 0, 0];
        for (let b = 0; b < size; b += 1) {
          const color = pass === 0 ? modules[a][b] : modules[b][a];
          if (color === runColor) {
            run += 1;
            if (run === 5) result += PENALTY_N1;
            else if (run > 5) result += 1;
          } else {
            finderPenaltyAddHistory(run, runHistory);
            if (!runColor) result += finderPenaltyCountPatterns(runHistory) * PENALTY_N3;
            runColor = color;
            run = 1;
          }
        }
        result += finderPenaltyTerminateAndCount(runColor, run, runHistory) * PENALTY_N3;
      }
    }
    for (let y = 0; y < size - 1; y += 1) {
      for (let x = 0; x < size - 1; x += 1) {
        const color = modules[y][x];
        if (color === modules[y][x + 1] && color === modules[y + 1][x] && color === modules[y + 1][x + 1]) result += PENALTY_N2;
      }
    }
    let dark = 0;
    for (const row of modules) for (const m of row) if (m) dark += 1;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * PENALTY_N4;
    return result;
  }

  return { size, modules, drawFunctionPatterns, drawCodewords, applyMask, drawFormatBits, getPenaltyScore };
}

/** Split into blocks, append Reed–Solomon ECC to each, and interleave. */
function addEccAndInterleave(data, ver) {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ver];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ver];
  const rawCodewords = Math.floor(getNumRawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const blocks = [];
  const rsDiv = reedSolomonComputeDivisor(blockEccLen);
  for (let i = 0, k = 0; i < numBlocks; i += 1) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = reedSolomonComputeRemainder(dat, rsDiv);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const result = [];
  for (let i = 0; i < blocks[0].length; i += 1) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
    });
  }
  return result;
}

/**
 * Encode text (UTF-8) as one byte-mode segment at ECC level M in the smallest
 * version from 1 to 10 that fits, choosing the mask with the lowest penalty.
 * @returns {{version:number, size:number, mask:number, modules:boolean[][]}}
 *   `modules[y][x]` is true for a dark module; no quiet zone included.
 */
export function encodeQr(text, { minVersion = MIN_VERSION, maxVersion = MAX_VERSION } = {}) {
  const bytes = [...Buffer.from(String(text), "utf8")];
  let version = 0;
  for (let ver = Math.max(MIN_VERSION, minVersion); ver <= Math.min(MAX_VERSION, maxVersion); ver += 1) {
    if (bytes.length <= byteCapacity(ver)) {
      version = ver;
      break;
    }
  }
  if (!version) throw new RangeError(`QR payload too long (${bytes.length} bytes)`);

  // Bit stream: mode, count, data, terminator, byte padding, pad codewords.
  const bits = [];
  const append = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  append(MODE_BYTE, 4);
  append(bytes.length, numCharCountBits(version));
  for (const b of bytes) append(b, 8);
  const capacityBits = getNumDataCodewords(version) * 8;
  append(0, Math.min(4, capacityBits - bits.length));
  append(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) append(pad, 8);
  const dataCodewords = new Array(bits.length / 8).fill(0);
  bits.forEach((bit, i) => {
    dataCodewords[i >>> 3] |= bit << (7 - (i & 7));
  });

  const symbol = createSymbol(version);
  symbol.drawFunctionPatterns();
  symbol.drawCodewords(addEccAndInterleave(dataCodewords, version));
  let mask = 0;
  let minPenalty = Infinity;
  for (let i = 0; i < 8; i += 1) {
    symbol.applyMask(i);
    symbol.drawFormatBits(i);
    const penalty = symbol.getPenaltyScore();
    if (penalty < minPenalty) {
      mask = i;
      minPenalty = penalty;
    }
    symbol.applyMask(i); // XOR again to undo
  }
  symbol.applyMask(mask);
  symbol.drawFormatBits(mask);
  return { version, size: symbol.size, mask, modules: symbol.modules };
}

/**
 * One SVG path (`d`) drawing every dark module as unit squares, horizontal
 * runs merged. Coordinates are in modules; the page adds the quiet zone with
 * `viewBox="-4 -4 (size+8) (size+8)"`.
 */
export function qrSvgPath(modules) {
  let d = "";
  modules.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      if (!row[x]) continue;
      let run = 1;
      while (x + run < row.length && row[x + run]) run += 1;
      d += `M${x} ${y}h${run}v1h-${run}z`;
      x += run - 1;
    }
  });
  return d;
}

/**
 * The QR code as terminal text: two module rows per line with half-block
 * characters, drawn black on a white background whatever the terminal's
 * theme (light-on-dark codes confuse some scanners). Includes the quiet zone.
 */
export function qrTerminalText(modules, { quiet = QUIET_ZONE } = {}) {
  const size = modules.length;
  const dark = (x, y) => x >= 0 && y >= 0 && x < size && y < size && modules[y][x];
  const lines = [];
  for (let y = -quiet; y < size + quiet; y += 2) {
    let line = "\x1b[30;47m"; // black on white
    for (let x = -quiet; x < size + quiet; x += 1) {
      const top = dark(x, y);
      const bottom = dark(x, y + 1);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(`${line}\x1b[0m`);
  }
  return `${lines.join("\n")}\n`;
}

// ---- the pairing payload (section 9.1) ----

export const PAYLOAD_NAME_MAX_BYTES = 32;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A canonical UUID as 16 raw bytes in base64url without padding (22 chars). */
export function uuidToBase64url(uuid) {
  if (typeof uuid !== "string" || !UUID_RE.test(uuid)) throw new TypeError("hostId must be a UUID");
  return Buffer.from(uuid.replace(/-/g, ""), "hex").toString("base64url");
}

/** A SHA-256 hex fingerprint as 32 raw bytes in base64url without padding (43 chars). */
export function fingerprintToBase64url(hex) {
  if (typeof hex !== "string" || !/^[0-9a-f]{64}$/i.test(hex)) throw new TypeError("fingerprint must be 64 hex characters");
  return Buffer.from(hex, "hex").toString("base64url");
}

/**
 * The host name for the payload: control, format and line-separator
 * characters removed, percent-encoded keeping only RFC 3986 unreserved
 * characters, and cut on a character (code point) boundary to at most
 * PAYLOAD_NAME_MAX_BYTES encoded bytes.
 */
export function encodePayloadName(name, maxBytes = PAYLOAD_NAME_MAX_BYTES) {
  const clean = String(name ?? "").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "").trim();
  let out = "";
  for (const ch of clean) {
    const enc = encodeURIComponent(ch).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    if (out.length + enc.length > maxBytes) break;
    out += enc;
  }
  return out;
}

/**
 * `windock://pair?v=1&id&addr&fp&pin&name`, fields in this order.
 * @param {{hostId:string, address:string, port:number, fingerprint:string, pin:string, name:string}} fields
 */
export function buildPairingPayload({ hostId, address, port, fingerprint, pin, name }) {
  if (typeof address !== "string" || !/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) throw new TypeError("address must be dotted IPv4");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError("port out of range");
  if (typeof pin !== "string" || !/^\d{6}$/.test(pin)) throw new TypeError("pin must be 6 digits");
  return `windock://pair?v=1&id=${uuidToBase64url(hostId)}&addr=${address}:${port}`
    + `&fp=${fingerprintToBase64url(fingerprint)}&pin=${pin}&name=${encodePayloadName(name)}`;
}

/** Payload, symbol and SVG path in the shape GET /api/host/pairing returns. */
export function pairingQr(fields) {
  const text = buildPairingPayload(fields);
  const { size, version, modules } = encodeQr(text);
  return { text, size, version, path: qrSvgPath(modules) };
}
