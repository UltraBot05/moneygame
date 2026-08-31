/**
 * Values shared by the web client and the worker. Kept transport- and
 * framework-agnostic so both sides depend on a single definition.
 */

/** Wire-protocol version. Bump when the client/worker contract changes. */
export const PROTOCOL_VERSION = 1;
