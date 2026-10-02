/**
 * Base for errors whose `.message` is SAFE to surface to the model, the audit
 * log, and the MCP client — i.e. errors WE construct with sanitized content (no
 * tokens, no response bodies, no payloads, no raw headers). Every typed error in
 * this codebase extends `SafeError`.
 *
 * Anything that is NOT a `SafeError` (a raw fetch/network error, a JSON
 * `SyntaxError`, a third-party `HubSpotClient` impl's leak) is treated as
 * untrusted and genericized by `publicErrorMessage` — safety over debug richness
 * (red-team P2.3 / review Q5).
 */
export class SafeError extends Error {}

/** The message safe to surface publicly: a branded error's own message, else a generic string. */
export function publicErrorMessage(e: unknown): string {
  return e instanceof SafeError ? e.message : 'an internal error occurred'
}
