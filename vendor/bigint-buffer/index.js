"use strict";

/**
 * Drop-in replacement for bigint-buffer 1.1.5.
 *
 * The original CVE-2025-3194 is a buffer overflow in toBigIntLE() that can
 * crash the process. These implementations use native BigInt and never read
 * past the end of the input, and they reject values that do not fit instead of
 * overflowing silently.
 */

function toBigIntLE(buf) {
  const bytes = Buffer.from(buf);
  if (bytes.length === 0) return 0n;
  return BigInt("0x" + bytes.slice().reverse().toString("hex"));
}

function toBigIntBE(buf) {
  const bytes = Buffer.from(buf);
  if (bytes.length === 0) return 0n;
  return BigInt("0x" + bytes.toString("hex"));
}

function checkWidth(width) {
  if (!Number.isInteger(width) || width < 0) {
    throw new RangeError("width must be a non-negative integer");
  }
}

function toBufferLE(value, width) {
  const number = BigInt(value);
  if (number < 0n) throw new RangeError("value must be non-negative");
  checkWidth(width);
  const out = Buffer.alloc(width);
  let rest = number;
  for (let i = 0; i < width; i += 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  if (rest !== 0n) throw new RangeError(`value does not fit in ${width} bytes`);
  return out;
}

function toBufferBE(value, width) {
  const number = BigInt(value);
  if (number < 0n) throw new RangeError("value must be non-negative");
  checkWidth(width);
  const out = Buffer.alloc(width);
  let rest = number;
  for (let i = width - 1; i >= 0; i -= 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  if (rest !== 0n) throw new RangeError(`value does not fit in ${width} bytes`);
  return out;
}

module.exports = { toBigIntLE, toBigIntBE, toBufferLE, toBufferBE };
