import { parseJsonlStrict, type MergedStore } from '../store/jsonl-dir.js'
import { SafeError } from '../errors/index.js'
import { deepFreeze } from '../util/index.js'
import { redactCredentialsWithReport } from '../config/credential-shape.js'

/**
 * The append-only audit vocabulary. Three of these are negative outcomes and are
 * deliberately distinct: `invalid` = the plan failed its checks at the validate step;
 * `refused` = an action was not permitted (a wrong or wrong-portal approval phrase, an
 * execute before approval, a missing target, contamination caught at execute, a
 * refusal at draft or inspect, ...); `fail` = the write reached HubSpot and the API
 * call itself failed. Keeping them separate lets an operator tell "a write was blocked
 * before it left the process" from "a write was attempted and errored".
 *
 * These were `reject` and `deny` until the 2026-09-27 naming pass (#58). They are plain
 * -English synonyms, and this log is the surface an operator reads every time they ask
 * what happened, so two words for "no" in one column was the confusion that pass set out
 * to remove. NOTE for anyone reading a trail written by an older build: `toStoredEvent`
 * validates only that `type` is a string, never against this union, so those lines still
 * parse and still merge. They carry the OLD words, and nothing translates them, because
 * this log is append-only and presenting a line under a name it was not written with
 * would be a different kind of lie. Expect a trail that spans the change to contain both.
 *
 * `attempt` is a durable write-ahead marker recorded IMMEDIATELY BEFORE a HubSpot
 * mutation. If it cannot be durably recorded, the write is refused (fail-closed) —
 * so an `attempt` with NO following `execute`/`fail` for the same plan means "a
 * write was attempted but its outcome was not durably recorded; reconcile against
 * HubSpot." It closes the window where a real write could leave no durable trace.
 */
export type AuditEventType =
  | 'draft'
  | 'validate'
  | 'invalid'
  | 'inspect'
  | 'approve'
  | 'attempt'
  | 'execute'
  | 'fail'
  | 'refused'

/**
 * Redact an event and stamp the server's own fields onto it, for both sinks (#147).
 *
 * TWO separate things, and the first version of this comment confused them.
 *
 * The SAFETY is the explicit `redacted: handles` AFTER the caller's fields are spread. It
 * always overwrites, so an event arriving with its own `redacted` cannot survive whatever
 * the walk found. Measured rather than assumed: with the delete below disabled, a forged
 * `['deadbeef']` becomes `[]`, not itself.
 *
 * The DELETE is semantics, not safety. Absent means "nothing was redacted"; an empty
 * array would read as "a redaction with no handle", which is a different and untrue
 * claim. It is worth having for that reason alone, and it is not what stops a forgery.
 */
function stamp(event: AuditEvent, own: { seq: number; writer?: string }): AuditEvent {
  const { value, handles } = redactCredentialsWithReport(event)
  const out: AuditEvent = { ...value, ...own, redacted: handles }
  if (handles.length === 0) delete out.redacted
  return out
}

export interface AuditEvent {
  type: AuditEventType
  planId: string
  portalKey: string
  /** Epoch millis (injected clock at the call site — never a token or payload). */
  at: number
  /**
   * 1-based sequence number within ONE writer's trail, assigned on record. It counts
   * that writer's events across EVERY portal that process touched, so any filtered
   * view (one portal, one plan) shows the numbering restart per writer and skip the
   * numbers that belonged to other portals. Those restarts and gaps are expected and
   * do NOT mean events are missing. Only meaningful paired with `writer` (#49).
   */
  seq?: number
  /** Which server copy recorded it; absent on events from the single-writer era. */
  writer?: string
  detail?: Record<string, unknown>
  /**
   * The handles of material this server redacted while storing THIS event (#147).
   *
   * Set by the sink, never by a caller. The marker `(redacted: credential-shaped value)`
   * is not itself credential-shaped, so a caller can type it and nothing transforms it:
   * a refusal reason containing it is byte-identical whether the server redacted
   * something or the caller wrote the marker. This field is the out-of-band fact, so a
   * marker with no matching handle here was not put there by the server.
   *
   * Also the correlation handle (#148): the same unidentified value produces the same
   * handle across events, so "refused four hundred times since the deploy" is answerable
   * without the value ever being stored. Absent when nothing was redacted.
   */
  redacted?: readonly string[]
}

export interface AuditSink {
  record(event: AuditEvent): void
}

/** Read side of the audit log. */
export interface AuditQuery {
  all(): readonly AuditEvent[]
  forPortal(portalKey: string): AuditEvent[]
  forPlan(planId: string): AuditEvent[]
}

/**
 * Events from before per-writer files: one trail, no writer id. Exported because a
 * caller that must PRESENT the writer (the MCP `get_audit_log` tool) has to be able to
 * name an unattributed event honestly instead of inventing a writer id for it. A real
 * writer id is a `<UTC time>-<8 hex>` file stem, so this cannot collide with one.
 */
export const LEGACY_WRITER = 'legacy'

/**
 * An event that has been attributed to a writer — every event this log holds, and the
 * shape the read side hands out: `seq` is counted per writer, so it cannot be read
 * without the `writer` that counted it (#49).
 */
export type AttributedAuditEvent = AuditEvent & { writer: string }

type StoredEvent = AttributedAuditEvent

/**
 * CHOKEPOINT. Strip credential-shaped text from an event before it is stored.
 *
 * This log is append-only by design: `there is deliberately no mutate/delete API`,
 * events are deep-frozen on write, and the file store never rewrites a line. That is
 * the right property for an audit trail and it is exactly what makes a leak into it
 * permanent, because there is no in-product way to take it back out. Deleting the
 * trail file by hand destroys the history the log exists for, so the remedy would be
 * worse than the leak.
 *
 * So it is filtered on the way IN, once, rather than at each of the dozen callers that
 * build a `reason` from a caller-supplied argument (#112 7a). Applied in both sinks:
 * a new sink that forgets to call `redactCredentialsDeep` is a sink that writes the
 * trail unfiltered.
 *
 * The redactor itself lives in `src/config/credential-shape.js`, next to the shape it
 * strips and SHARED with the MCP result boundary. It was a private copy here until the
 * two boundaries drifted: this one redacted the data, the other redacted the serialized
 * JSON, and only one of them was right (#123 3b).
 */

/**
 * The single definition of "an event with no writer id belongs to the legacy trail".
 * The JSONL merge and the MCP read side must agree on it; if they drift, one of them
 * is inventing an attribution.
 */
export function attributeToWriter(event: AuditEvent): AttributedAuditEvent {
  // Deliberately NOT `?? LEGACY_WRITER`: `??` falls through on undefined/null but keeps
  // an EMPTY STRING, and `toStoredEvent` validates type/planId/portalKey/at without ever
  // checking `writer` — so a hand-edited or corrupted line carrying `"writer": ""` would
  // surface as an unnamed writer and silently defeat the guarantee this function exists
  // to make. Our own ids can never be blank (`newWriterId` is `<stamp>-<hex>`), so this
  // only covers a malformed file — which is precisely when an audit trail must not start
  // inventing attributions. Same shape as the `??`-keeps-empty-string defect in #38.
  const writer = event.writer?.trim()
  return { ...event, writer: writer !== undefined && writer !== '' ? writer : LEGACY_WRITER }
}

/**
 * Append-only in-memory audit log, queryable per portal and per plan. There is
 * deliberately no mutate/delete API — events are deep-frozen on write, carry a
 * monotonic sequence number, and queries return copies, so callers cannot alter
 * the trail after the fact. `FileAuditLog` below is the persisted peer; this one
 * backs tests and any caller that wants no disk.
 */
export class InMemoryAuditLog implements AuditSink, AuditQuery {
  private readonly events: AuditEvent[] = []

  record(event: AuditEvent): void {
    const seq = this.events.length + 1
    this.events.push(deepFreeze(stamp(event, { seq })))
  }

  all(): readonly AuditEvent[] {
    return this.events.slice()
  }

  forPortal(portalKey: string): AuditEvent[] {
    return this.events.filter((e) => e.portalKey === portalKey)
  }

  forPlan(planId: string): AuditEvent[] {
    return this.events.filter((e) => e.planId === planId)
  }
}

/**
 * Oldest first: event time, then writer (the legacy trail first), then that
 * writer's own sequence number. Copies share a clock, so time orders the merged
 * trail; the writer + seq tie-break keeps one copy's events in the order it
 * recorded them.
 */
function byTrailOrder(a: StoredEvent, b: StoredEvent): number {
  if (a.at !== b.at) return a.at - b.at
  if (a.writer !== b.writer) {
    if (a.writer === LEGACY_WRITER) return -1
    if (b.writer === LEGACY_WRITER) return 1
    return a.writer < b.writer ? -1 : 1
  }
  return (a.seq ?? 0) - (b.seq ?? 0)
}

/**
 * A line from another copy is data, not a promise. Check its shape before it
 * becomes an event: a malformed line would otherwise reach the model through
 * `get_audit_log` with undefined fields, and give the sort comparator a NaN.
 */
function toStoredEvent(record: unknown): StoredEvent {
  const e = record as Partial<AuditEvent>
  if (
    typeof e.type !== 'string' ||
    typeof e.planId !== 'string' ||
    typeof e.portalKey !== 'string' ||
    typeof e.at !== 'number'
  ) {
    throw new SafeError(
      'corrupt JSONL store: an audit line is missing type, planId, portalKey or at',
    )
  }
  return attributeToWriter(e as AuditEvent)
}

/**
 * Append-only audit log persisted to per-writer JSONL files, so several server
 * copies can share one data folder (#24). This copy appends only to its own file
 * and never rewrites any file; queries first pick up whatever the other copies
 * appended since the last read.
 *
 * Three properties the merge must not break:
 *  - **Foreign events keep the `seq` their own writer assigned.** Re-numbering them
 *    on arrival (as `InMemoryAuditLog.record` would) destroys the only signal that a
 *    writer's trail is complete: a missing line shows up as a gap in that writer's
 *    sequence. `seq` is therefore counted per writer, from this copy's own appends.
 *  - **Corruption still fails loud, and still at start-up.** The constructor reads
 *    the whole history, and the store hands over only complete lines, so any
 *    unparseable line is real corruption (P2.1).
 *  - **A corrupt read stays failed.** The store advances its read offset as it
 *    hands lines over, so retrying after a parse failure would return a trail
 *    silently missing that batch. The failure is sticky instead.
 */
export class FileAuditLog implements AuditSink, AuditQuery {
  private events: StoredEvent[] = []
  private ownSeq = 0
  private sorted = true
  private fatal?: SafeError
  private readonly warned = new Set<string>()

  constructor(
    private readonly store: MergedStore,
    private readonly warn: (message: string) => void = () => {},
  ) {
    this.refresh()
  }

  record(event: AuditEvent): void {
    // Persist to the durable file BEFORE reflecting the event in the in-memory
    // (queryable) log, so a query can never surface an event that isn't durable
    // (the read-side peer of the write-ahead `attempt`). If the append throws, the
    // in-memory log is left untouched and the throw propagates.
    const stamped: StoredEvent = stamp(event, {
      seq: this.ownSeq + 1,
      writer: this.store.writer,
    }) as StoredEvent
    this.store.appendLine(JSON.stringify(stamped))
    this.ownSeq += 1
    this.events.push(deepFreeze(stamped))
    this.sorted = false
  }

  all(): readonly AuditEvent[] {
    return this.view().slice()
  }

  forPortal(portalKey: string): AuditEvent[] {
    return this.view().filter((e) => e.portalKey === portalKey)
  }

  forPlan(planId: string): AuditEvent[] {
    return this.view().filter((e) => e.planId === planId)
  }

  /** Pick up the other copies' new events, in trail order. */
  private view(): StoredEvent[] {
    this.refresh()
    if (!this.sorted) {
      this.events.sort(byTrailOrder)
      this.sorted = true
    }
    return this.events
  }

  private refresh(): void {
    // Once a batch failed to parse, its lines are gone from the store's point of
    // view — it advanced past them as it handed them over. Answering the next
    // query would mean answering from a trail missing those lines, and saying so
    // only once. Fail the same way, every time, until the operator fixes the file.
    if (this.fatal) throw this.fatal
    const read = this.store.readNew()
    for (const name of read.ignored) {
      this.warnOnce(`audit log: ignoring "${name}" — not a server trail file`)
    }
    for (const name of read.tornTails) {
      this.warnOnce(
        `audit log: "${name}" ends mid-line (a copy crashed or is still writing); the incomplete record is not read`,
      )
    }
    if (read.lines.length === 0) return
    try {
      for (const record of parseJsonlStrict(read.lines)) {
        this.events.push(deepFreeze(toStoredEvent(record)))
      }
    } catch (e) {
      this.fatal = e instanceof SafeError ? e : new SafeError('corrupt JSONL store')
      throw this.fatal
    }
    this.sorted = false
  }

  /** One warning per file, so a refresh on every query cannot flood stderr. */
  private warnOnce(message: string): void {
    if (this.warned.has(message)) return
    this.warned.add(message)
    this.warn(message)
  }
}
