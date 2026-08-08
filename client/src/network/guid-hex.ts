/**
 * THE ONE guid representation in this client: a lowercase `0x`-prefixed hex string, no leading zeros.
 *
 * WHY A STRING AND NOT A NUMBER. A WoW guid is 64 bits. `Number` holds 53 exactly, so the top eleven
 * bits of a real guid cannot survive one -- and the failure is not a rounding error, it is a wrong
 * identity. `Packet#readPackedGUID` used to OR its bytes into a Number with `guid |= bit << (i * 8)`,
 * which is worse still: `|` coerces to **int32**, so any guid with bit 31 set came back NEGATIVE and
 * any guid above 2^32 came back truncated. The owner's own report has one printed: `-250601794`.
 *
 * WHY A STRING AND NOT `BigInt`. `tsconfig.json` targets **es6**; BigInt literals are a compile error
 * below ES2020, and the `lib` entry only types the calls. More decisively, the hex string is the
 * representation this codebase *already* declared: `CharacterRecord.guid`'s type comment says
 * "Hex string: a 64-bit guid does not survive a JS number" (`network/protocol/types.ts:48`), and
 * `decodeCharEnum` has produced exactly this shape since the roster first parsed. Making the wire
 * decoder agree with the roster is a smaller and more honest change than converting the roster to a
 * numeric type nothing else uses. A string is also a valid `Map` key by value, which is what
 * `World#entities` (`Map<string, Unit>`) was already typed for and never actually received.
 *
 * NORMALISATION IS THE POINT, not the formatting. Two paths produce guids -- `decodeCharEnum`'s
 * little-endian 8-byte read and `readPackedGUID`'s sparse mask -- and they must produce the SAME
 * string for the same guid or nothing matches. That is why both now go through `guidHex` here rather
 * than each formatting its own: `Gesf`'s guid is `0x59a6` from the roster and must be `0x59a6` from a
 * `SMSG_UPDATE_OBJECT`, not `0x00000000000059a6` and not `22950`.
 */

/** How many bytes a guid is. */
export const GUID_BYTES = 8;

/**
 * 8 little-endian bytes -> the normalised hex string.
 *
 * Reads high byte first so the string reads big-endian, which is how a guid is written everywhere a
 * human looks at one. Shorter input is zero-extended: `readPackedGUID`'s mask only ever hands over
 * the bytes it was told about.
 */
export function guidHex(bytes: ArrayLike<number>): string {
  let hex = '';
  for (let i = GUID_BYTES - 1; i >= 0; --i) {
    hex += ((bytes[i] ?? 0) & 0xff).toString(16).padStart(2, '0');
  }
  // Trim leading zeros but never to the empty string -- guid 0 is a real value on the wire (an
  // absent transport, an empty target) and must round-trip as `0x0`.
  return `0x${hex.replace(/^0+(?=.)/, '')}`;
}

/**
 * The normalised hex string -> 8 little-endian bytes.
 *
 * Parsed as two 32-bit halves rather than one number, for the same reason `encodeGuidBody` does: the
 * whole 64-bit value has no exact `Number`. Anything unparseable answers eight zeros, which is the
 * guid the wire uses for "none" -- a NaN written into a packet would corrupt every field after it.
 */
export function guidBytes(hex: string): Uint8Array {
  const out = new Uint8Array(GUID_BYTES);
  const digits = (hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex).padStart(16, '0');
  const high = parseInt(digits.slice(0, 8), 16);
  const low = parseInt(digits.slice(8, 16), 16);
  if (!Number.isFinite(high) || !Number.isFinite(low)) {
    return out;
  }
  for (let i = 0; i < 4; ++i) {
    out[i] = (low >>> (i * 8)) & 0xff;
    out[i + 4] = (high >>> (i * 8)) & 0xff;
  }
  return out;
}

/**
 * Anything that claims to be a guid -> the normalised hex string.
 *
 * The bridge for the legacy call sites that still hold a Number (or a differently-cased/padded
 * string) and for comparing one against a roster guid. A NUMBER argument is taken as UNSIGNED --
 * `>>> 0` -- because the only numbers that reach here came from the old `|=` accumulator, whose
 * negatives are int32 reinterpretations of a positive low half, not negative guids.
 */
export function normaliseGuid(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return '0x0';
  }
  if (typeof value === 'number') {
    return guidHex(guidBytes(`0x${(value >>> 0).toString(16)}`));
  }
  if (/^0x[0-9a-f]+$/.test(value) && !value.startsWith('0x0')) {
    return value; // already normalised; the common case, and it allocates nothing
  }
  if (/^-?\d+$/.test(value)) {
    // A decimal guid, which is what a Number that had been stringified looks like. Same unsigned
    // reading as above.
    return normaliseGuid(Number(value));
  }
  return guidHex(guidBytes(value));
}
