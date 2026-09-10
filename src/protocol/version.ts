/**
 * Wire-protocol version, carried in `hello` and echoed in `welcome`.
 *
 * Versioning is ADDITIVE: bump this only when a peer that does not know about
 * the change would misbehave, not when a field is added. Adding an optional
 * field, a new `event.kind`, or a new method is not a bump — unknown fields
 * survive a parse by design (see `messages.ts`), and an unknown method already
 * answers with a `MALFORMED_MESSAGE` error rather than a broken session.
 *
 * A bump means a removal or a semantic change, and it obliges the daemon to
 * either keep serving the old shape or refuse the connection outright with
 * `PROTOCOL_VERSION_MISMATCH`. Silently accepting a mismatched peer is how a
 * remote client ends up rendering a session it is quietly misreading.
 */
export const PROTOCOL_VERSION = 1;
