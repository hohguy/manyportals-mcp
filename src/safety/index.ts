import { parseJsonlStrict, type MergedStore } from '../store/jsonl-dir.js'
import { SafeError } from '../errors/index.js'

export class SafetyError extends SafeError {
  constructor(message: string) {
    super(message)
    this.name = 'SafetyError'
  }
}

/**
 * Per-portal index of record IDs the server has seen, populated as objects are
 * read (the index-population strategy). Best-effort substrate for the
 * cross-portal contamination check: it can only reason about IDs already
 * attributed to a portal.
 */
export class PortalIdIndex {
  private readonly byPortal = new Map<string, Set<string>>()

  record(portalKey: string, id: string): void {
    let set = this.byPortal.get(portalKey)
    if (set === undefined) {
      set = new Set()
      this.byPortal.set(portalKey, set)
    }
    set.add(id)
  }

  recordMany(portalKey: string, ids: Iterable<string>): void {
    for (const id of ids) this.record(portalKey, id)
  }

  isKnownFor(portalKey: string, id: string): boolean {
    return this.byPortal.get(portalKey)?.has(id) ?? false
  }

  /** Portals OTHER than `targetPortal` that have this id attributed to them. */
  foreignOwners(targetPortal: string, id: string): string[] {
    const owners: string[] = []
    for (const [portalKey, ids] of this.byPortal) {
      if (portalKey !== targetPortal && ids.has(id)) owners.push(portalKey)
    }
    return owners
  }

  /**
   * Pick up attributions recorded by OTHER server copies (#24). A no-op in
   * memory; the file-backed index overrides it. `findContamination` calls it, so
   * the validate-time and execute-time checks both judge a write against what
   * every copy has recorded, not only this one.
   */
  refresh(): void {}
}

/**
 * Persistent PortalIdIndex over per-writer JSONL files (#24): this copy appends
 * only to its own file and never rewrites any file, and `refresh()` picks up what
 * the other copies recorded, so the cross-portal guard is blind neither after a
 * restart (red-team P1) nor to a copy running alongside. Per-portal separation is
 * preserved — each line carries its own portal key, never merged across portals.
 *
 * Each new line also carries the hub id its portal key resolved to when written.
 * A line whose hub id disagrees with this copy's config is DROPPED with a warning:
 * the same key pointing at a different hub means the two copies do not mean the
 * same portal, and trusting it would attribute one portal's ids to another. Lines
 * with no hub id (written before this, or by a portal configured without one) are
 * trusted exactly as before.
 */
export class FilePortalIdIndex extends PortalIdIndex {
  private readonly warned = new Set<string>()
  private fatal?: SafeError

  constructor(
    private readonly store: MergedStore,
    private readonly hubIdFor: (portalKey: string) => number | undefined = () => undefined,
    private readonly warn: (message: string) => void = () => {},
  ) {
    super()
    // Read every copy's history at start-up, so corruption fails loud here (P2.1)
    // rather than in the middle of a later write check.
    this.refresh()
  }

  /** Hydrate whatever the other copies appended since the last look. */
  override refresh(): void {
    // Once a batch failed, its lines are gone from the store's point of view — it
    // advanced past them as it handed them over. Carrying on would mean judging
    // the next write against attributions this index never saw, having complained
    // exactly once. Fail the same way every time instead.
    if (this.fatal) throw this.fatal
    const read = this.store.readNew()
    for (const name of read.ignored) {
      this.warnOnce(`id-index: ignoring "${name}" — not a server index file`)
    }
    for (const name of read.tornTails) {
      this.warnOnce(
        `id-index: "${name}" ends mid-line (a copy crashed or is still writing); the incomplete attribution is not read`,
      )
    }
    if (read.lines.length === 0) return
    try {
      for (const line of parseJsonlStrict(read.lines)) {
        const { portal, id, hub } = line as { portal?: string; id?: string; hub?: number }
        if (typeof portal !== 'string' || typeof id !== 'string') {
          throw new SafeError('corrupt JSONL store: an id-index line has no portal key or id')
        }
        const expected = this.hubIdFor(portal)
        if (
          typeof hub === 'number' &&
          expected !== undefined &&
          expected !== 0 &&
          hub !== expected
        ) {
          this.warnOnce(
            `id-index: ignoring ids recorded for portal "${portal}" under hub ${hub} — this copy has that key configured as hub ${expected}`,
          )
          continue
        }
        super.record(portal, id) // hydrate without re-appending
      }
    } catch (e) {
      this.fatal = e instanceof SafeError ? e : new SafeError('corrupt JSONL store')
      throw this.fatal
    }
  }

  override record(portalKey: string, id: string): void {
    // Dedup-on-write (F3): an already-attributed (portal, id) pair appends
    // nothing — the JSONL feeds a Set, so a duplicate line carries no
    // information and would grow the file with every repeat read. The same id
    // under a DIFFERENT portal still appends (a distinct attribution the
    // contamination check needs). History belongs to the audit log, not here.
    if (this.isKnownFor(portalKey, id)) return
    // Persist BEFORE marking in memory: if the append throws (disk full), the
    // set stays unmarked and the next read retries the persist — otherwise the
    // dedup guard would skip the retry and leave the file blind until restart.
    // (If we crash between the two, replay rebuilds the set from the file.)
    const hub = this.hubIdFor(portalKey)
    const attribution =
      hub === undefined || hub === 0 ? { portal: portalKey, id } : { portal: portalKey, id, hub }
    this.store.appendLine(JSON.stringify(attribution))
    super.record(portalKey, id)
  }

  /** One warning per message, so a refresh before every check cannot flood stderr. */
  private warnOnce(message: string): void {
    if (this.warned.has(message)) return
    this.warned.add(message)
    this.warn(message)
  }
}

/** Compile a blocked-property pattern (only `*` is a wildcard) to an anchored, case-insensitive RegExp. */
function blockedPatternToRegExp(pattern: string): RegExp {
  const body = pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === '*' ? '.*' : `\\${ch}`))
  return new RegExp(`^${body}$`, 'i')
}

/**
 * Best-effort sensitive-property screen: the property names (among `propertyNames`)
 * that match any of a portal's `blockedProperties` patterns. Used to reject a
 * write touching a blocked field BEFORE a plan can be approved (red-team P1 /
 * brief §6b — sensitive fields/bodies are blocked unless explicitly opted in).
 */
export function matchBlockedProperties(
  blockedPatterns: readonly string[],
  propertyNames: Iterable<string>,
): string[] {
  if (blockedPatterns.length === 0) return []
  const regexes = blockedPatterns.map(blockedPatternToRegExp)
  const hits: string[] = []
  for (const name of propertyNames) {
    if (regexes.some((re) => re.test(name))) hits.push(name)
  }
  return hits
}

export interface ContaminationHit {
  id: string
  foreignPortals: string[]
}

/**
 * Best-effort cross-portal ID-contamination check (AR-2 family / security-model).
 *
 * Flags any id — among those referenced by a write to `targetPortal` — that the
 * index has attributed to a DIFFERENT portal and NOT to the target.
 *
 * Deliberately NOT a hard guarantee:
 *  - never-seen ids are not flagged (cannot be — documented limitation),
 *  - an id legitimately known under BOTH portals is not flagged (avoids the
 *    false positive where the same integer is a valid record in both).
 * The hard guarantees live elsewhere (required-portal enum, hub-id assertion,
 * propose/apply); this is defense-in-depth.
 */
export function findContamination(
  index: PortalIdIndex,
  targetPortal: string,
  ids: Iterable<string>,
): ContaminationHit[] {
  // Pick up the other copies' attributions FIRST (#24). `validate` calls this
  // directly and `execute` reaches it through assertNoContamination, so both see
  // an id another copy read moments ago.
  index.refresh()
  const hits: ContaminationHit[] = []
  for (const id of ids) {
    if (index.isKnownFor(targetPortal, id)) continue // legitimately a target id too
    const foreign = index.foreignOwners(targetPortal, id)
    if (foreign.length > 0) hits.push({ id, foreignPortals: foreign })
  }
  return hits
}

/**
 * Throw `SafetyError` if any contamination is found. The error names only ids
 * and portal keys (no tokens, no secrets).
 */
export function assertNoContamination(
  index: PortalIdIndex,
  targetPortal: string,
  ids: Iterable<string>,
): void {
  const hits = findContamination(index, targetPortal, ids)
  if (hits.length > 0) {
    const detail = hits.map((h) => `${h.id} (belongs to ${h.foreignPortals.join(', ')})`).join('; ')
    throw new SafetyError(
      `cross-portal contamination blocked: write to "${targetPortal}" references id(s) from another portal: ${detail}`,
    )
  }
}
