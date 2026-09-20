/**
 * A plate reduced to what a plate can contain.
 *
 * Letters and digits are the entire alphabet of an Indian registration
 * number, so discarding everything else costs no legitimate search and buys
 * two things: `KA 01 AB 1234` finds the vehicle stored as `KA01AB1234`, and a
 * needle heading for a `LIKE` pattern cannot smuggle in a `%` that matches
 * the whole fleet or a `_` that matches any character.
 *
 * Stricter than the `[\s-]` strip applied when a vehicle is registered, and
 * identical to it for any plate that is actually a plate.
 */
export function normaliseRegistration(input: string): string {
  return input.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}
