import { z } from 'zod'
import type { ManyPortalsConfig, PortalConfig } from '../config/index.js'
import { redactKey } from '../config/index.js'
import { SafeError } from '../errors/index.js'

export class PortalError extends SafeError {
  constructor(message: string) {
    super(message)
    this.name = 'PortalError'
  }
}

/** Non-secret summary of a portal — safe to return to the model. No token material. */
export interface PortalSummary {
  key: string
  label: string
  apiHost: string
  expectedHubId: number
  allowRead: boolean
  allowWrite: boolean
}

/**
 * The portal registry: resolution + the explicit-portal gate + reads-only
 * default handling. Holds no tokens (those are resolved separately via the
 * config layer); only non-secret portal metadata lives here.
 */
export class PortalRegistry {
  private selected: string | undefined

  constructor(private readonly config: ManyPortalsConfig) {}

  keys(): string[] {
    return Object.keys(this.config.portals)
  }

  has(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.config.portals, key)
  }

  /** Resolve a portal's config by explicit key. Throws `PortalError` if unknown. */
  get(key: string): PortalConfig {
    const portal = this.config.portals[key]
    if (!portal) {
      // The key is CALLER-supplied and this message reaches both the model and the
      // audit log, so a token pasted where a portal key belongs would be echoed to
      // one and persisted in the other. Same redactor as the vault and token-file
      // paths (#84, found by the audit test for those).
      throw new PortalError(
        `unknown portal "${redactKey(key)}"; known portals: ${this.keys().join(', ')}`,
      )
    }
    return portal
  }

  /** Non-secret summaries (no tokens / no env-var names) for a list_portals tool. */
  list(): PortalSummary[] {
    return this.keys().map((key) => {
      const p = this.get(key)
      return {
        key,
        label: p.label,
        apiHost: p.apiHost,
        expectedHubId: p.expectedHubId,
        allowRead: p.allowRead,
        allowWrite: p.allowWrite,
      }
    })
  }

  /**
   * Required portal-key schema for tool inputs: a zod enum built from the
   * configured keys. No default, no optional — a missing or unknown portal is
   * rejected at validation, before any portal call. This is the structural
   * "explicit portal" gate every tool depends on.
   */
  requiredPortalSchema() {
    const keys = this.keys()
    // Config validation (src/config) guarantees at least one portal.
    return z.enum(keys as [string, ...string[]])
  }

  // --- selected/default portal: READS ONLY ---

  getSelected(): string | undefined {
    return this.selected
  }

  /** Set the selected default portal (a fallback for READS only). Throws if unknown. */
  setSelected(key: string): void {
    if (!this.has(key)) {
      throw new PortalError(
        `cannot select unknown portal "${key}"; known portals: ${this.keys().join(', ')}`,
      )
    }
    this.selected = key
  }

  /**
   * Resolve the portal for a READ: the explicit key if given, else the selected
   * default. Writes must NOT use this — they require an explicit key and never
   * fall back to a default (enforced in the plan layer). There is deliberately
   * no write-defaulting counterpart to this method.
   */
  resolveForRead(explicitKey?: string): { key: string; portal: PortalConfig } {
    const key = explicitKey ?? this.selected
    if (key === undefined) {
      throw new PortalError('no portal specified and no default portal selected')
    }
    return { key, portal: this.get(key) }
  }
}
