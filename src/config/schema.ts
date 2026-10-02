import { z } from 'zod'

export const DEFAULT_API_HOST = 'api.hubapi.com'

/**
 * Egress allowlist for the per-portal API host (AR-5: the sole legitimate
 * runtime outbound destination is api.hubapi.com). A bad config value must not
 * be able to send a bearer token to an arbitrary host.
 *
 * One host is enough for every region — VERIFIED 2026-09-14, not an assumption.
 * HubSpot embeds the Hublet in the credential itself and routes at the edge to
 * the regional backend (api-na1/api-eu1), so `api.hubapi.com` is correct for an
 * EU data-residency portal exactly as it is for a US one. Corroborated live: the
 * QA portals sit on a non-na1 hublet and every call confirmed at the operator
 * preflight succeeded against this host (2026-09-14).
 *
 * So do NOT add regional hosts here. They are internal routing targets no
 * integration calls, and listing them would widen the AR-5 egress surface to buy
 * nothing. A portal that genuinely needs another host is a deliberate, reviewed
 * code change — and would first need evidence that this one does not work.
 */
export const ALLOWED_API_HOSTS = [DEFAULT_API_HOST] as const

/**
 * A single portal's NON-SECRET configuration.
 *
 * The private-app token itself is never stored here — only `tokenEnv`, the name
 * of the environment variable that holds it. The token is resolved at use time
 * (see `resolvePortalToken`) so it never lives in a loggable config object.
 */
export const writeModeSchema = z.enum(['propose', 'apply', 'off'])

export const portalConfigSchema = z
  .object({
    /**
     * OPTIONAL name of the env var holding this portal's private-app token (NOT
     * the token itself). Omit it to supply the token via the token file instead
     * (keyed by portal key). Constrained to env-var-name form so a pasted token
     * (which contains '-'/lowercase) is rejected at load — it must never end up
     * in a field that surfaces (e.g. doctor prints tokenEnv).
     */
    tokenEnv: z
      .string()
      .min(1)
      .regex(
        /^[A-Za-z_][A-Za-z0-9_]*$/,
        'tokenEnv must be an environment variable NAME (letters, digits, underscore) — not a token value',
      )
      .optional(),
    /** Expected HubSpot hub/portal id for the boot assertion. 0 = unknown → assertion skips with a warning. */
    expectedHubId: z.number().int().nonnegative(),
    /**
     * Human-readable label echoed in plans/errors. Full unicode incl. emoji, but
     * control/bidi/zero-width chars are rejected so a label can't spoof its display
     * (RT-10a).
     */
    label: z
      .string()
      .min(1, 'label is required')
      .refine((l) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(l), {
        message: 'label must not contain control, bidi, or zero-width characters',
      }),
    /** API host, per portal (region-specific). Constrained to the egress allowlist (AR-5). */
    apiHost: z
      .string()
      .min(1)
      .default(DEFAULT_API_HOST)
      .refine((h) => (ALLOWED_API_HOSTS as readonly string[]).includes(h), {
        message: `apiHost must be one of: ${ALLOWED_API_HOSTS.join(', ')} (other HubSpot hosts are NEEDS_VERIFICATION before use)`,
      }),
    /**
     * Whether the safe READ tools (get_record, search_records, recent_activity,
     * summarize_pipeline) may target this portal. Default true (a configured portal
     * is readable). Set false to PARK a portal — disable read tools without removing
     * it from config. Internal preflight reads for an already-authorized write are
     * NOT gated by this (they belong to the write lifecycle, not the read surface).
     */
    allowRead: z.boolean().default(true),
    /** Whether writes are permitted to this portal at all (secure default: false). */
    allowWrite: z.boolean().default(false),
    /** Property-name patterns blocked from read/write unless explicitly opted in. */
    blockedProperties: z.array(z.string()).default([]),
    /**
     * Write policy — DEFAULT-DENY (red-team P1.1). A write is refused at draft
     * unless its object type is in `allowedObjects` AND its operation kind is in
     * `allowedOperations`. Both default empty: a writable portal writes NOTHING
     * until the operator allowlists object types + operations.
     */
    allowedObjects: z.array(z.string()).default([]),
    allowedOperations: z.array(z.enum(['create', 'update'])).default([]),
    /**
     * Subset of `allowedObjects` whose writes may auto-execute in `apply` mode
     * (no human pause). Default empty → `apply` auto-executes nothing; every
     * other write still requires explicit approval (AR-3 reach bounded — P1.6).
     */
    applyAllowedObjects: z.array(z.string()).default([]),
    /**
     * Write mode for THIS portal, overriding the server-wide default. AR-3 rules
     * that writeMode is per-portal; only the server-wide value was ever wired, so
     * `apply` applied to every configured portal at once, and the FAQ's advice to
     * set it on one portal failed config load against this strict object (#86).
     *
     * Optional: unset means inherit the server default, which is what every
     * existing config does.
     */
    writeMode: writeModeSchema.optional(),
  })
  .strict()
  // Fail closed: a writable portal must have a known hub id, so the boot
  // swapped-token guard cannot be skipped for any portal that can be written to
  // (red-team P1). expectedHubId 0 (unknown) is permitted only for read-only
  // portals / onboarding.
  .refine((p) => !(p.allowWrite && p.expectedHubId === 0), {
    message:
      'a writable portal (allowWrite=true) requires a nonzero expectedHubId (the swapped-token guard must not be skippable for writable portals)',
    path: ['expectedHubId'],
  })
  // apply auto-exec can only bless objects that are writable at all.
  .refine((p) => p.applyAllowedObjects.every((o) => p.allowedObjects.includes(o)), {
    message: 'applyAllowedObjects must be a subset of allowedObjects',
    path: ['applyAllowedObjects'],
  })
  // Refuse a state that cannot mean what it looks like (#87). `allowRead: false` is
  // documented as parking a portal, but it is enforced only in ReadService: the write
  // lifecycle reads target records through preflight, and `inspect_plan_target` is a
  // model-callable tool that runs on a merely VALIDATED plan, before approval. So a
  // parked-but-writable portal still discloses record contents to the assistant.
  // Enforcing allowRead inside preflight instead would make such a portal unable to
  // complete a reference write at all, because RT-01 requires preflight for those, so
  // the honest fix is to refuse the combination at load.
  .refine((p) => !(p.allowWrite && !p.allowRead), {
    message:
      'allowRead=false with allowWrite=true is refused: writes preflight-read their target, so a write-only portal is not actually parked. Set allowWrite=false to park it, or allowRead=true if it should be writable.',
    path: ['allowRead'],
  })

/**
 * Portal key grammar (RT-10a): a name the operator invents to tell portals apart,
 * in ANY script (letters, digits, combining marks) plus `_`/`-`, starting with a
 * letter or digit. The allowlist inherently EXCLUDES control, bidi, and zero-width
 * characters (a bidi override in a key would spoof the approval-phrase display),
 * whitespace, and punctuation. Keys are case-sensitive; `loadConfig` NFC-normalizes
 * them and refuses a normalization collision. NOT full i18n: no homoglyph /
 * confusables detection (documented residual in SAFETY_MODEL).
 */
export const portalKeySchema = z
  .string()
  .min(1)
  .regex(
    /^[\p{L}\p{N}][\p{L}\p{N}\p{M}_-]*$/u,
    'portal key must start with a letter or digit and contain only letters, digits, combining marks, "_" or "-" (any script)',
  )

export const configSchema = z
  .object({
    portals: z.record(portalKeySchema, portalConfigSchema),
    writeMode: writeModeSchema.default('propose'),
    /**
     * Where the encrypted vault lives, when it is not at the default (#145).
     *
     * Declared HERE rather than asked for in the Claude Desktop dialog, so setup is one
     * folder and one optional passphrase instead of three fields, two of them paths into
     * a hidden directory a file picker cannot reach.
     *
     * RELATIVE IS ALLOWED, and that is deliberate even though the environment paths
     * refuse it. The env rule exists because a relative path there resolves against the
     * process's working directory, which differs between Claude Desktop and a shell, so
     * the two would read different files (#42). A relative path HERE resolves against the
     * directory holding this config file, which is the same wherever the process is
     * started from. Same word, different anchor, and only one of them is ambiguous.
     *
     * So `"tokens.vault"` means "beside this config" without any default having to move.
     */
    vaultFile: z.string().min(1).optional(),
  })
  .strict()
  .refine((c) => Object.keys(c.portals).length > 0, {
    message: 'at least one portal must be configured',
    path: ['portals'],
  })

export type PortalConfig = z.infer<typeof portalConfigSchema>
export type WriteMode = z.infer<typeof writeModeSchema>
export type ManyPortalsConfig = z.infer<typeof configSchema>
