import { randomBytes } from 'node:crypto'
import type { AuditSink } from '../audit/index.js'
import type { HubSpotClient, HubSpotObject, PortalContext } from '../hubspot/index.js'
import { HubSpotError } from '../hubspot/index.js'
import type { PortalRegistry } from '../portals/index.js'
import {
  assertNoContamination,
  findContamination,
  matchBlockedProperties,
  type PortalIdIndex,
} from '../safety/index.js'
import { redactKey, type WriteMode, type PortalConfig } from '../config/index.js'
import { SafeError, publicErrorMessage } from '../errors/index.js'
import { deepFreeze } from '../util/index.js'

export class WritePlanError extends SafeError {
  constructor(message: string) {
    super(message)
    this.name = 'WritePlanError'
  }
}

/**
 * The exact phrase required to approve a plan. Naming the destination portal at
 * the moment of commit is exactly when a wrong-portal write would otherwise slip
 * through (brief §8). The phrase is exact (not a substring match), so loose text
 * like "do not approve PORTAL_A" cannot satisfy it.
 */
export function expectedApprovalPhrase(planId: string, portalKey: string): string {
  return `approve plan ${planId} for ${portalKey}`
}

/**
 * Plan id used for a refusal that happened BEFORE a plan existed, so there is nothing
 * to attach it to. Parenthesised, so it cannot collide with a generated `plan_<tag>_<n>`.
 */
export const REFUSED_BEFORE_DRAFT = '(refused-before-draft)'

/** Stands in for a portal key the caller did not supply at all. */
const NO_PORTAL_KEY = '(none)'

export interface AssociationSpec {
  toType: string
  toId: string
}

export type WriteOperation =
  | {
      kind: 'create'
      objectType: string
      properties: Record<string, string>
      associations?: AssociationSpec[]
    }
  | { kind: 'update'; objectType: string; objectId: string; properties: Record<string, string> }

export type PlanStatus =
  | 'draft'
  | 'validated'
  | 'approved'
  | 'executing'
  | 'executed'
  | 'invalid'
  | 'failed'

/** A referenced existing record (update target or association target), with its type. */
export interface ReferencedTarget {
  objectType: string
  id: string
}

/** Preflight result per referenced target: found in the target portal (+ a screened identity summary), or not. */
export interface InspectedTarget {
  objectType: string
  id: string
  found: boolean
  /** Screened identity properties (blocked/sensitive fields removed) when found. */
  properties?: Record<string, string>
}

/** Preflight verification of portal-scoped reference PROPERTIES (pipeline/stage) in the target portal (RT-01). */
export interface ReferenceCheck {
  /** Did the write set a resolvable reference property that we verified? */
  checked: boolean
  ok: boolean
  issues: string[]
}

export interface WritePlan {
  id: string
  portalKey: string
  hubLabel: string
  operation: WriteOperation
  status: PlanStatus
  referencedIds: string[]
  createdAt: number
  validation?: { ok: boolean; issues: string[] }
  /** Preflight-read summaries of referenced targets + reference-property verification in the target portal (P1.5 / RT-01). */
  inspection?: { at: number; results: InspectedTarget[]; references?: ReferenceCheck }
  approvedBy?: string
  result?: { objectId?: string; error?: string }
}

export interface PlanServiceDeps {
  registry: PortalRegistry
  client: HubSpotClient
  idIndex: PortalIdIndex
  audit: AuditSink
  /** Resolve a portal's token (kept out of plans; injected from the config layer). */
  resolveToken: (portalKey: string) => string
  writeMode?: WriteMode
  perPortalWriteMode?: Record<string, WriteMode>
  now?: () => number
  genId?: () => string
}

/** Ids a write references that could belong to another portal (contamination surface). */
function referencedIdsOf(op: WriteOperation): string[] {
  if (op.kind === 'update') return [op.objectId]
  return (op.associations ?? []).map((a) => a.toId)
}

/** Existing records a write references, WITH their object type, for the preflight read (P1.5). */
function referencedTargetsOf(op: WriteOperation): ReferencedTarget[] {
  if (op.kind === 'update') return [{ objectType: op.objectType, id: op.objectId }]
  return (op.associations ?? []).map((a) => ({ objectType: a.toType, id: a.toId }))
}

/**
 * Portal-SCOPED reference properties whose VALUES are ids owned by a specific
 * portal (RT-01 — the no-data-mixing hole where a foreign stage/pipeline/owner id
 * rides in a property value, unseen by the record-id contamination check). Two
 * classes: RESOLVABLE per object type (a deal/ticket pipeline + stage, verified in
 * the target portal at preflight — mirrors reads' PIPELINE_OBJECT_TYPES), and
 * DENIED (owner/team ids — no confirmed in-target resolver in v1, so a generic
 * write setting one is refused at validate; typed references are v-next). Property
 * and object-type matching is case-insensitive.
 */
const RESOLVABLE_REFERENCE_PROPS: Record<string, { pipeline: string; stage: string }> = {
  deals: { pipeline: 'pipeline', stage: 'dealstage' },
  tickets: { pipeline: 'hs_pipeline', stage: 'hs_pipeline_stage' },
}
/**
 * HubSpot addresses the same object type by NAME or by numeric objectTypeId
 * (deals = 0-3, tickets = 0-5 — repo reference; NEEDS_VERIFICATION at preflight).
 * Canonicalize so `objectType: "0-3"` is verified exactly like `"deals"` — else a
 * deal addressed by its type-id would skip the reference gate (a reopening of the
 * RT-01 break). Any UNRECOGNIZED type that sets a RESERVED pipeline/stage property
 * is DENIED at validate (fail-closed for pipeline-bearing custom objects, only
 * addressable as 2-XXXX) — the invariant must not rest on the operator's spelling.
 */
const OBJECT_TYPE_ALIASES: Record<string, string> = { '0-3': 'deals', '0-5': 'tickets' }
/** HubSpot-reserved pipeline/stage property names — denied on an UNVERIFIABLE type. */
const RESERVED_REFERENCE_PROPS: ReadonlySet<string> = new Set([
  'dealstage',
  'hs_pipeline',
  'hs_pipeline_stage',
])
const DENIED_REFERENCE_PROPS: ReadonlySet<string> = new Set([
  'hubspot_owner_id',
  'hubspot_team_id',
  'hs_all_owner_ids',
  'hs_all_team_ids',
  'hs_created_by_user_id',
])

function propCI(props: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase()
  for (const [k, v] of Object.entries(props)) if (k.toLowerCase() === lower) return v
  return undefined
}

function canonicalType(objectType: string): string {
  const lower = objectType.toLowerCase()
  return OBJECT_TYPE_ALIASES[lower] ?? lower
}

function resolvableRefsFor(objectType: string): { pipeline: string; stage: string } | undefined {
  return RESOLVABLE_REFERENCE_PROPS[canonicalType(objectType)]
}

/** Does this write set a resolvable portal-scoped reference (pipeline/stage) for its type? */
function setsReferenceProperty(op: WriteOperation): boolean {
  const map = resolvableRefsFor(op.objectType)
  if (map === undefined) return false
  return (
    propCI(op.properties, map.pipeline) !== undefined ||
    propCI(op.properties, map.stage) !== undefined
  )
}

/** DENIED (unverifiable) portal-scoped reference property names present in a write. */
function deniedReferencePropsIn(props: Record<string, string>): string[] {
  return Object.keys(props).filter((k) => DENIED_REFERENCE_PROPS.has(k.toLowerCase()))
}

/**
 * A reserved pipeline/stage property set on an object type we CANNOT verify (not
 * deals/tickets, incl. their type-ids) — e.g. a pipeline-bearing custom object
 * (2-XXXX). We cannot resolve its pipelines with confidence, so DENY it
 * (fail-closed) rather than let a foreign stage/pipeline id ride an unrecognized
 * spelling. `pipeline` (generic; a legit custom property elsewhere) is not reserved.
 */
function unverifiableReferencePropsIn(op: WriteOperation): string[] {
  if (resolvableRefsFor(op.objectType) !== undefined) return [] // recognized → verified at preflight
  return Object.keys(op.properties).filter((k) => RESERVED_REFERENCE_PROPS.has(k.toLowerCase()))
}

/**
 * Defensive snapshot of a plan for callers (get/draft/validate/approve/execute).
 * The stored plan stays internal/mutable for status transitions; callers receive
 * a copy whose nested fields they cannot use to mutate service state. The
 * `operation` is already deep-frozen at draft, so it is shared safely (P1.3).
 */
function snapshot(plan: WritePlan): WritePlan {
  return {
    ...plan,
    referencedIds: [...plan.referencedIds],
    operation: plan.operation,
    validation: plan.validation
      ? { ok: plan.validation.ok, issues: [...plan.validation.issues] }
      : undefined,
    inspection: plan.inspection
      ? {
          at: plan.inspection.at,
          results: plan.inspection.results.map((r) => ({ ...r })),
          references: plan.inspection.references
            ? { ...plan.inspection.references, issues: [...plan.inspection.references.issues] }
            : undefined,
        }
      : undefined,
    result: plan.result ? { ...plan.result } : undefined,
  }
}

/**
 * The write-plan lifecycle and the only path through which a mutation can reach
 * HubSpot. There is no execute-without-a-plan API: every write is drafted,
 * validated, (approved,) and executed — in every write mode (AR-2 / AR-3).
 */
export class PlanService {
  private readonly plans = new Map<string, WritePlan>()
  /** Plan ids with a preflight currently in flight (C1: guards preflight‖execute). */
  private readonly inspecting = new Set<string>()
  private readonly d: PlanServiceDeps
  private readonly now: () => number
  private readonly genId: () => string

  constructor(deps: PlanServiceDeps) {
    this.d = deps
    this.now = deps.now ?? (() => Date.now())
    let n = 0
    // Plan ids must never repeat across restarts (#22): the approval phrase names the id,
    // so a phrase given before a restart must not match a different plan after it. A random
    // per-process tag makes a repeat vanishingly unlikely; the counter keeps ids unique here.
    const tag = randomBytes(4).toString('hex')
    this.genId = deps.genId ?? (() => `plan_${tag}_${++n}`)
  }

  private modeFor(portalKey: string): WriteMode {
    return this.d.perPortalWriteMode?.[portalKey] ?? this.d.writeMode ?? 'propose'
  }

  private require(planId: string): WritePlan {
    const plan = this.plans.get(planId)
    if (plan === undefined) {
      // Recorded HERE, not in each of the five callers. This is the one place the
      // decision is made, and it sat OUTSIDE every caller's try/catch, so show_plan,
      // validate_plan, inspect_plan_target, approve_plan and execute_plan all refused
      // an unknown plan id with an audit delta of zero (#112 7b). A model probing for
      // live plan ids left no trace at all, and "what did the assistant try" is the
      // question this log exists to answer.
      //
      // There is no portal to attribute it to, which is the point: the plan is what
      // would have carried one. NO_PORTAL_KEY says that rather than guessing.
      const cause = new WritePlanError(`unknown plan "${planId}"`)
      this.auditRefusal(planId, NO_PORTAL_KEY, 'lookup', cause)
      throw cause
    }
    return plan
  }

  get(planId: string): WritePlan {
    return snapshot(this.require(planId))
  }

  /**
   * Every reason a draft can be refused, in one place so the caller records each of
   * them exactly once. Returns the portal on success.
   */
  private checkDraftAllowed(input: { portalKey: string; operation: WriteOperation }): PortalConfig {
    if (input.portalKey.trim() === '') {
      throw new WritePlanError('a write requires an explicit portal key; none was provided')
    }
    const portal = this.d.registry.get(input.portalKey) // throws PortalError if unknown
    const mode = this.modeFor(input.portalKey)
    if (mode === 'off') {
      throw new WritePlanError(
        `writes are disabled (writeMode=off) for portal "${input.portalKey}"`,
      )
    }
    if (!portal.allowWrite) {
      throw new WritePlanError(`portal "${input.portalKey}" is read-only (allowWrite=false)`)
    }
    // Default-deny write policy (P1.1): the object type and operation kind must
    // both be explicitly allowlisted for this portal.
    if (!portal.allowedObjects.includes(input.operation.objectType)) {
      throw new WritePlanError(
        `object type "${input.operation.objectType}" is not allowed for portal "${input.portalKey}" (allowedObjects)`,
      )
    }
    if (!portal.allowedOperations.includes(input.operation.kind)) {
      throw new WritePlanError(
        `operation "${input.operation.kind}" is not allowed for portal "${input.portalKey}" (allowedOperations)`,
      )
    }
    return portal
  }

  /**
   * Record a refusal at a lifecycle step that had none. validate() and execute()
   * already audit this class; draft and preflight were the exceptions (#84).
   *
   * The portal key is CALLER-supplied and can be anything, including an unknown key or
   * a credential-shaped string, and the audit log is durable — so it goes through the
   * same redactor the vault and token-file paths use.
   *
   * A failure of the audit sink itself is deliberately NOT swallowed: it replaces the
   * refusal with a louder problem, which is the correct order of concerns here.
   */
  private auditRefusal(
    planId: string,
    portalKey: string,
    stage: 'draft' | 'inspect' | 'lookup',
    cause: unknown,
  ): void {
    this.d.audit.record({
      type: 'refused',
      planId,
      portalKey: redactKey(portalKey.trim() === '' ? NO_PORTAL_KEY : portalKey),
      at: this.now(),
      detail: { stage, reason: publicErrorMessage(cause) },
    })
  }

  /**
   * Draft a write plan. REFUSES to form without an explicit, known portal key —
   * the selected/default portal is never enough for a write. Also refuses when
   * the portal is read-only or writes are disabled.
   */
  draft(input: { portalKey: string; operation: WriteOperation }): WritePlan {
    let portal: PortalConfig
    try {
      portal = this.checkDraftAllowed(input)
    } catch (e) {
      // Every refusal is recorded. draft() had no try/catch at all, so a model
      // probing which object types a portal accepts, or pushing repeatedly at a
      // portal with writes disabled, left ZERO forensic trail — against the rule that
      // every refusal is recorded, and unnoticed because the suite's own
      // audit-completeness block covers approve and execute only (#84).
      this.auditRefusal(REFUSED_BEFORE_DRAFT, input.portalKey, 'draft', e)
      throw e
    }
    // Deep-clone + freeze the operation so a caller's reference cannot mutate it
    // after validation and before execution (P1.3).
    const operation = deepFreeze(structuredClone(input.operation))
    const plan: WritePlan = {
      id: this.genId(),
      portalKey: input.portalKey,
      hubLabel: portal.label,
      operation,
      status: 'draft',
      referencedIds: referencedIdsOf(operation),
      createdAt: this.now(),
    }
    this.plans.set(plan.id, plan)
    this.d.audit.record({
      type: 'draft',
      planId: plan.id,
      portalKey: plan.portalKey,
      at: plan.createdAt,
    })
    return snapshot(plan)
  }

  /** Validate a draft: enforce the blocked-property policy and the contamination check. */
  validate(planId: string): WritePlan {
    const plan = this.require(planId)
    if (plan.status !== 'draft') {
      throw new WritePlanError(`plan "${planId}" is ${plan.status}, not draft`)
    }
    const portal = this.d.registry.get(plan.portalKey)
    const issues: string[] = []

    // Blocked-property policy: reject a write touching a portal's blocked
    // (sensitive) fields before it can be approved.
    const blocked = matchBlockedProperties(
      portal.blockedProperties,
      Object.keys(plan.operation.properties),
    )
    if (blocked.length > 0) {
      issues.push(`blocked propert${blocked.length > 1 ? 'ies' : 'y'}: ${blocked.join(', ')}`)
    }

    // Cross-portal contamination: ids referenced by this write that belong to another portal.
    // findContamination refreshes the id-index from the other copies' files first, so it can
    // fail on a store read. That refusal is fail-closed either way, but without this catch the
    // throw escapes before the validate/reject entry below is written and the plan leaves no
    // trail at all — while the same failure at execute IS recorded (the deny near the
    // execute-time re-check). Record the sanitized `deny` here too, then re-throw: `deny` is
    // already this log's "a gate refused this plan" event at both approve and execute time,
    // and a store failure is not a policy rejection, so it must not be recorded as `reject`.
    try {
      for (const h of findContamination(this.d.idIndex, plan.portalKey, plan.referencedIds)) {
        issues.push(`id ${h.id} belongs to ${h.foreignPortals.join(', ')}`)
      }
    } catch (e) {
      this.d.audit.record({
        type: 'refused',
        planId,
        portalKey: plan.portalKey,
        at: this.now(),
        detail: { reason: publicErrorMessage(e) },
      })
      throw e
    }

    // RT-01: refuse a portal-scoped reference we cannot verify in the target portal
    // (owner/team ids) when set through a generic write — typed references are v-next.
    const deniedRefs = deniedReferencePropsIn(plan.operation.properties)
    if (deniedRefs.length > 0) {
      issues.push(
        `portal-scoped reference propert${deniedRefs.length > 1 ? 'ies' : 'y'} not settable via a generic write in v1: ${deniedRefs.join(', ')} — assign it in HubSpot directly`,
      )
    }

    // RT-01 (N4): a reserved pipeline/stage property on a type we CANNOT verify (a
    // custom pipeline object, or an unrecognized type-id) is denied — fail-closed,
    // so a foreign stage/pipeline id cannot ride an unrecognized object-type spelling.
    const unverifiableRefs = unverifiableReferencePropsIn(plan.operation)
    if (unverifiableRefs.length > 0) {
      issues.push(
        `reference propert${unverifiableRefs.length > 1 ? 'ies' : 'y'} on an unverifiable object type "${plan.operation.objectType}": ${unverifiableRefs.join(', ')} — use the canonical deals/tickets type, or set it in HubSpot directly`,
      )
    }

    const ok = issues.length === 0
    plan.validation = { ok, issues }
    plan.status = ok ? 'validated' : 'invalid'
    this.d.audit.record({
      type: ok ? 'validate' : 'invalid',
      planId,
      portalKey: plan.portalKey,
      at: this.now(),
      detail: ok ? undefined : { issues },
    })
    return snapshot(plan)
  }

  /**
   * Preflight a validated plan that references existing records (an update target
   * or association targets): read each referenced record IN THE TARGET PORTAL and
   * attach a screened identity summary, so the operator can confirm the right
   * record in the right portal before approving (P1.5). A target not found in the
   * target portal is flagged (`found: false`) — the wrong-portal catch the
   * contamination guard cannot make for never-seen ids. A found target is recorded
   * to the contamination index (the read teaches ownership).
   */
  async inspectTarget(planId: string): Promise<WritePlan> {
    const plan = this.require(planId)
    try {
      return await this.inspectInner(planId, plan)
    } catch (e) {
      // The wrong-status refusal, the in-flight refusal and the rethrow of any
      // non-404 HubSpot error all bypassed the single record at the end, so a
      // preflight that made live API calls and then failed left the trail at
      // draft, validate (#84). execute() and validate() already audit this class.
      this.auditRefusal(planId, plan.portalKey, 'inspect', e)
      throw e
    }
  }

  private async inspectInner(planId: string, plan: WritePlan): Promise<WritePlan> {
    // Allow preflight before OR after approve (avoids a propose-mode deadlock where
    // an already-approved plan could have neither its target inspected nor be executed).
    if (plan.status !== 'validated' && plan.status !== 'approved') {
      throw new WritePlanError(
        `only a validated or approved plan can have its target inspected (plan is ${plan.status})`,
      )
    }
    // In-flight guard (C1): claim synchronously before any await so a concurrent
    // execute can't act on a stale plan.inspection while this one recomputes it,
    // and two preflights can't interleave.
    if (this.inspecting.has(planId)) {
      throw new WritePlanError(`plan "${planId}" is already having its target inspected`)
    }
    this.inspecting.add(planId)
    try {
      const portal = this.d.registry.get(plan.portalKey)
      const ctx: PortalContext = {
        token: this.d.resolveToken(plan.portalKey),
        apiHost: portal.apiHost,
      }
      const targets = referencedTargetsOf(plan.operation)
      const results: InspectedTarget[] = []
      for (const t of targets) {
        try {
          const obj = await this.d.client.getObject(ctx, t.objectType, t.id)
          // Drop any blocked/sensitive fields from the identity summary.
          const blocked = new Set(
            matchBlockedProperties(portal.blockedProperties, Object.keys(obj.properties)),
          )
          const properties = Object.fromEntries(
            Object.entries(obj.properties).filter(([k]) => !blocked.has(k)),
          )
          results.push({ objectType: t.objectType, id: t.id, found: true, properties })
          // A confirmed read attributes this id to the target portal (feeds the guard).
          this.d.idIndex.record(plan.portalKey, t.id)
        } catch (e) {
          if (e instanceof HubSpotError && e.status === 404) {
            results.push({ objectType: t.objectType, id: t.id, found: false })
          } else {
            throw e // unknown error — sanitized at the MCP boundary (P2.3)
          }
        }
      }
      // RT-01: verify portal-scoped reference PROPERTIES (a deal/ticket pipeline/
      // stage) against the target portal's pipelines — a SEPARATE path whose result
      // feeds neither plan.referencedIds nor the contamination index (a stage id is
      // not a record id). A non-404 getPipelines failure rethrows (sanitized),
      // leaving the plan retryable, not bricked (N3).
      const references = await this.verifyReferences(ctx, plan.portalKey, plan.operation)
      plan.inspection = { at: this.now(), results, references }
      this.d.audit.record({
        type: 'inspect',
        planId,
        portalKey: plan.portalKey,
        at: this.now(),
        detail: {
          targets: results.map((r) => ({ objectType: r.objectType, id: r.id, found: r.found })),
        },
      })
      return snapshot(plan)
    } finally {
      this.inspecting.delete(planId)
    }
  }

  /**
   * Verify a write's portal-scoped reference PROPERTIES (a deal/ticket pipeline +
   * stage) EXIST in the TARGET portal — the fix for foreign stage/pipeline ids
   * riding in property values (RT-01). Pair-verifies the stage against the named
   * pipeline when both are set. Reads the target portal's pipelines only; records
   * nothing to the contamination index. A non-404 failure rethrows (sanitized).
   */
  private async verifyReferences(
    ctx: PortalContext,
    portalKey: string,
    op: WriteOperation,
  ): Promise<ReferenceCheck> {
    const map = resolvableRefsFor(op.objectType)
    if (map === undefined) return { checked: false, ok: true, issues: [] }
    const pipelineVal = propCI(op.properties, map.pipeline)
    const stageVal = propCI(op.properties, map.stage)
    if (pipelineVal === undefined && stageVal === undefined) {
      return { checked: false, ok: true, issues: [] }
    }
    const pipelines = await this.d.client.getPipelines(ctx, op.objectType)
    const issues: string[] = []
    if (pipelineVal !== undefined && !pipelines.some((p) => p.id === pipelineVal)) {
      issues.push(`pipeline "${pipelineVal}" does not exist in portal "${portalKey}"`)
    }
    if (stageVal !== undefined) {
      // Pair-verify: within the named pipeline if given, else any pipeline.
      const scope =
        pipelineVal !== undefined ? pipelines.filter((p) => p.id === pipelineVal) : pipelines
      if (!scope.some((p) => p.stages.some((s) => s.id === stageVal))) {
        issues.push(
          pipelineVal !== undefined
            ? `stage "${stageVal}" is not in pipeline "${pipelineVal}" in portal "${portalKey}"`
            : `stage "${stageVal}" does not exist in portal "${portalKey}"`,
        )
      }
    }
    return { checked: true, ok: issues.length === 0, issues }
  }

  /**
   * Approve a validated plan. The confirmation phrase must be EXACTLY
   * `approve plan <planId> for <portalKey>` — an exact match (not a substring),
   * so the destination portal is named unambiguously at the moment of commit and
   * loose phrases (e.g. "do not approve PORTAL_A") cannot satisfy it.
   */
  approve(planId: string, confirmationPhrase: string): WritePlan {
    const plan = this.require(planId)
    // Only the refusal checks live in the try; a thrown check is recorded as `deny`.
    // The success path (status mutation + the `approve` record + return) sits OUTSIDE
    // the try, so a failing audit sink on a SUCCESSFUL approval can never also emit a
    // contradictory `deny` (mirrors execute()'s gate/execution split).
    try {
      if (plan.status !== 'validated') {
        throw new WritePlanError(`only a validated plan can be approved (plan is ${plan.status})`)
      }
      const expected = expectedApprovalPhrase(plan.id, plan.portalKey)
      if (confirmationPhrase.trim() !== expected) {
        throw new WritePlanError(`approval phrase must be exactly: "${expected}"`)
      }
    } catch (e) {
      // A refused approval — a wrong or for-the-wrong-portal phrase, or a plan not
      // in the validated state — is security-relevant: it is an attempt to authorize
      // a write that the gate blocked. Record a sanitized `deny` before re-throwing.
      // The reason carries only the (already sanitized) refusal message: no token,
      // no payload — publicErrorMessage collapses anything unexpected to generic.
      this.d.audit.record({
        type: 'refused',
        planId,
        portalKey: plan.portalKey,
        at: this.now(),
        detail: { reason: publicErrorMessage(e) },
      })
      throw e
    }
    plan.status = 'approved'
    plan.approvedBy = confirmationPhrase.trim()
    this.d.audit.record({ type: 'approve', planId, portalKey: plan.portalKey, at: this.now() })
    return snapshot(plan)
  }

  /**
   * Execute a plan against HubSpot. Requires a validated plan; in `propose` mode
   * it must also be approved, in `apply` mode a validated plan may proceed
   * (standing pre-authorization) — but the full draft → validate pipeline always
   * ran first (AR-3). Re-checks contamination immediately before the call.
   *
   * A plan that references existing records (update/association) must be
   * have its target inspected first (P1.5), unless the caller explicitly sets
   * `skipInspection`. If preflight found a referenced target missing in the target
   * portal, execution is refused unless the operator explicitly sets
   * `acceptMissingTargets`. Both choices are audited.
   */
  async execute(
    planId: string,
    opts?: { skipInspection?: boolean; acceptMissingTargets?: boolean },
  ): Promise<WritePlan> {
    const plan = this.require(planId)
    const mode = this.modeFor(plan.portalKey)
    const portal = this.d.registry.get(plan.portalKey)
    const referencesExisting = referencedTargetsOf(plan.operation).length > 0
    const setsRef = setsReferenceProperty(plan.operation)
    // apply auto-exec: object types the operator explicitly blessed for no-approval.
    const autoExec =
      mode === 'apply' && portal.applyAllowedObjects.includes(plan.operation.objectType)
    // RT-02: in apply auto-exec there is NO human, so the model must not be able to
    // waive the target read via execute options — neutralize the flags. In propose
    // mode a human is approving, so they remain honored (the pre-existing posture;
    // that human pause rests on the client gating destructiveHint — see SAFETY_MODEL).
    const skipInspection = autoExec ? false : opts?.skipInspection === true
    const acceptMissingTargets = autoExec ? false : opts?.acceptMissingTargets === true

    // Gate section. Every throw below is a REFUSAL (policy, safety, or a
    // concurrency guard) — no HubSpot call happens in the gates, so a throw here is
    // never an execution error (that path records `fail`, further down). Any refused
    // execution is recorded as a sanitized `deny` audit event before re-throwing, so
    // a blocked write attempt — pre-approval, a rejected plan, a missing target,
    // contamination caught at execute — leaves a forensic trail. (Closes the
    // audit-completeness gap the sandbox QA surfaced: refusals were previously
    // invisible in get_audit_log.) The reason is publicErrorMessage(e): the already
    // sanitized refusal text, never a token or payload.
    try {
      // In-flight guard (F1): the MCP SDK dispatches requests concurrently, so two
      // overlapping execute() calls for the same plan could both pass the gates
      // before either mutates status — a double write. We flip to 'executing'
      // synchronously (below) before the first await; a re-entrant call is rejected
      // here, atomically on the single-threaded event loop.
      if (plan.status === 'executing') {
        throw new WritePlanError(`plan "${planId}" is already executing`)
      }
      if (mode === 'off') throw new WritePlanError(`writeMode=off for portal "${plan.portalKey}"`)
      if (plan.status === 'draft') {
        throw new WritePlanError('plan must be validated before execution')
      }
      if (plan.validation && !plan.validation.ok) {
        throw new WritePlanError('plan failed validation; cannot execute')
      }
      // `apply` auto-executes ONLY objects the operator explicitly blessed for it;
      // every other write still requires explicit approval, even in apply mode (P1.6).
      if (!autoExec && plan.status !== 'approved') {
        throw new WritePlanError(
          `plan "${planId}" requires approval before execution (writeMode=${mode})`,
        )
      }
      if (plan.status !== 'approved' && plan.status !== 'validated') {
        throw new WritePlanError(`plan "${planId}" is not in an executable state (${plan.status})`)
      }

      // C1 / RT-01: don't act on plan.inspection (or its .references) while a preflight
      // is recomputing it — ONE guard for both gates below. A plan that triggers
      // neither gate never reads plan.inspection, so it needs no in-flight guard.
      if (((referencesExisting && !skipInspection) || setsRef) && this.inspecting.has(planId)) {
        throw new WritePlanError(
          `plan "${planId}" is having its target inspected — wait for that to finish before executing`,
        )
      }

      // Preflight gate (P1.5): a plan referencing existing records must be
      // inspected (or explicitly skipped); a missing target needs explicit accept.
      // In apply auto-exec both waivers are neutralized (RT-02), so the refusal must
      // not advise them: a model that follows the advice is refused again, in a loop (#53).
      if (referencesExisting && !skipInspection) {
        if (!plan.inspection) {
          throw new WritePlanError(
            autoExec
              ? `plan "${planId}" references existing records — run inspect_plan_target first (in apply mode skipInspection is ignored for object types in applyAllowedObjects, even on an approved plan)`
              : `plan "${planId}" references existing records — run inspect_plan_target first, or execute with skipInspection`,
          )
        }
        const missing = plan.inspection.results.filter((r) => !r.found)
        if (missing.length > 0 && !acceptMissingTargets) {
          const ids = missing.map((m) => m.id).join(', ')
          throw new WritePlanError(
            autoExec
              ? `referenced record(s) not found in portal "${plan.portalKey}": ${ids} — re-draft with the correct id/portal (in apply mode acceptMissingTargets is ignored for object types in applyAllowedObjects, even on an approved plan)`
              : `referenced record(s) not found in portal "${plan.portalKey}": ${ids} — re-draft with the correct id/portal, or execute with acceptMissingTargets`,
          )
        }
      }

      // RT-01: a write that sets a portal-scoped reference (pipeline/stage) must be
      // preflight-verified in the TARGET portal — NON-waivable (skipInspection /
      // acceptMissingTargets do not apply; a foreign stage/pipeline id is a
      // cross-portal signature, not a friction, and in apply there is no human).
      if (setsRef) {
        const ref = plan.inspection?.references
        if (ref === undefined || !ref.checked) {
          throw new WritePlanError(
            `plan "${planId}" sets a portal-scoped reference (pipeline/stage) — run inspect_plan_target first to verify it in the target portal (this check cannot be skipped)`,
          )
        }
        if (!ref.ok) {
          throw new WritePlanError(
            `portal-scoped reference not valid in portal "${plan.portalKey}": ${ref.issues.join('; ')} (a cross-portal id, or a stale/foreign pipeline or stage)`,
          )
        }
      }

      // Defense in depth: re-check contamination at the moment of execution.
      assertNoContamination(this.d.idIndex, plan.portalKey, plan.referencedIds)
    } catch (e) {
      this.d.audit.record({
        type: 'refused',
        planId,
        portalKey: plan.portalKey,
        at: this.now(),
        detail: { reason: publicErrorMessage(e) },
      })
      throw e
    }

    // Gates passed. Recording the explicit lower-friction choice (skipInspection /
    // acceptMissingTargets) is NOT a refusal, so it lives OUTSIDE the deny-catch — a
    // failing audit sink here must not emit a spurious `deny` (peer of approve()'s
    // success-path split). Recorded only now that the gates, including the execute-
    // time contamination re-check, have passed.
    if (
      (referencesExisting || setsRef) &&
      (opts?.skipInspection === true || opts?.acceptMissingTargets === true)
    ) {
      this.d.audit.record({
        type: 'inspect',
        planId,
        portalKey: plan.portalKey,
        at: this.now(),
        detail: {
          // The TRUE effective outcome — never "skipped" when the check actually ran.
          skipped: skipInspection,
          acceptedMissingTargets: acceptMissingTargets,
          // In apply auto-exec the requested flags were neutralized (RT-02).
          requestedFlagsIgnored: autoExec,
        },
      })
    }

    // Resolving the token can fail (a portal configured with no token passes draft and
    // validate, which never touch credentials). That is a refusal like any other, so it
    // is audited as a `deny` rather than propagating silently: the gate catch above has
    // already closed by this point (review 2026-09-27).
    let ctx: PortalContext
    try {
      ctx = { token: this.d.resolveToken(plan.portalKey), apiHost: portal.apiHost }
    } catch (e) {
      this.d.audit.record({
        type: 'refused',
        planId,
        portalKey: plan.portalKey,
        at: this.now(),
        detail: { reason: publicErrorMessage(e) },
      })
      throw e
    }

    // Write-ahead durability (P1): record a durable `attempt` BEFORE any HubSpot
    // mutation. If the audit sink cannot append it (disk full / EACCES / a broken
    // sink), FAIL CLOSED — refuse to mutate rather than risk a real write that
    // leaves no durable record. The post-write `execute`/`fail` records below are
    // then best-effort: even if they later fail, the durable `attempt` (with no
    // matching execute/fail) tells the operator on restart that a write was
    // attempted and must be reconciled against HubSpot.
    try {
      this.d.audit.record({ type: 'attempt', planId, portalKey: plan.portalKey, at: this.now() })
    } catch {
      throw new WritePlanError(
        `refusing to execute plan "${planId}": the audit log could not durably record the attempt (a durable audit entry is required before any write)`,
      )
    }

    // Claim the plan synchronously (no await since the in-flight guard above) so a
    // concurrent execute() is rejected before it can issue a second write (F1).
    plan.status = 'executing'

    try {
      const obj = await this.runOperation(ctx, plan)
      plan.status = 'executed'
      plan.result = { objectId: obj.id }
      // The affected object now belongs to this portal — record it for the index.
      this.d.idIndex.record(plan.portalKey, obj.id)
      this.d.audit.record({
        type: 'execute',
        planId,
        portalKey: plan.portalKey,
        at: this.now(),
        detail: { objectId: obj.id },
      })
      return snapshot(plan)
    } catch (e) {
      // Only a branded SafeError's message is trusted into the audit/result; an
      // unknown error (raw network/JSON error, third-party client leak) becomes
      // generic (P2.3 / Q5).
      const message = publicErrorMessage(e)
      plan.status = 'failed'
      // Preserve any partial side effect (e.g. an object created before a later
      // association step failed) so the operator can find/clean the orphan — and
      // surface its id in the failure audit (red-team P1).
      const partialObjectId = plan.result?.objectId
      plan.result = {
        ...(partialObjectId !== undefined ? { objectId: partialObjectId } : {}),
        error: message,
      }
      this.d.audit.record({
        type: 'fail',
        planId,
        portalKey: plan.portalKey,
        at: this.now(),
        detail: { error: message, ...(partialObjectId !== undefined ? { partialObjectId } : {}) },
      })
      throw e
    }
  }

  private async runOperation(ctx: PortalContext, plan: WritePlan): Promise<HubSpotObject> {
    const op = plan.operation
    if (op.kind === 'create') {
      const obj = await this.d.client.createObject(ctx, op.objectType, op.properties)
      // Record the create side effect IMMEDIATELY: the object now exists in the
      // portal even if a following association step throws, so a partial failure
      // never hides an orphan from the audit / contamination index.
      plan.result = { objectId: obj.id }
      this.d.idIndex.record(plan.portalKey, obj.id)
      for (const a of op.associations ?? []) {
        await this.d.client.createDefaultAssociation(ctx, op.objectType, obj.id, a.toType, a.toId)
      }
      return obj
    }
    return this.d.client.updateObject(ctx, op.objectType, op.objectId, op.properties)
  }
}
