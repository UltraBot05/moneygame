/**
 * Values shared by the web client and the worker: the single wire-protocol definition (RT-002).
 * Transport- and framework-agnostic so both sides depend on one contract.
 */

export * from "./profile";
export * from "./protocol";
