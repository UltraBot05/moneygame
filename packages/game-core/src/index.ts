/**
 * Pure, framework-free game core. Must not import React, DOM/browser APIs,
 * Cloudflare, D1, WebSockets, Google auth or UI libraries (ARCHITECTURE.md §5).
 */

export * from "./board";
export * from "./command";
export * from "./economy";
export * from "./lobby";
export * from "./random";
export * from "./state";
