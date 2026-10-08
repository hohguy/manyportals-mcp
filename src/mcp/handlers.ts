import { attributeToWriter, type AttributedAuditEvent, type AuditEvent } from '../audit/index.js'
import { SafeError } from '../errors/index.js'
import { expectedApprovalPhrase } from '../plans/index.js'
import type { PlanService, WriteOperation, WritePlan } from '../plans/index.js'
import type { PortalRegistry } from '../portals/index.js'
import type {
  GetRecordInput,
  GetRecordResult,
  ReadService,
  RecentActivityInput,
  RecentActivityResult,
  SearchRecordsInput,
  SearchRecordsResult,
  SummarizePipelineInput,
  SummarizePipelineResult,
} from '../reads/index.js'

/**
 * Dependencies for the MCP tool handlers. The handlers are deliberately thin and
 * SDK-free so they can be unit-tested directly; `server.ts` adapts MCP-parsed
 * args onto them.
 */
export interface McpHandlerDeps {
  registry: PortalRegistry
  plans: PlanService
  reads: ReadService
  auditForPortal: (portalKey: string) => AuditEvent[]
  auditAll: () => readonly AuditEvent[]
}

/**
 * One event as `get_audit_log` hands it over. `writer` is REQUIRED here even though it
 * is optional on `AuditEvent`: `seq` is that writer's own counter, so a `seq` arriving
 * without its `writer` cannot be interpreted at all (#49). `n` is the event's 1-based
 * position in THIS result — a reading aid, recomputed per view and never an identity;
 * `seq` + `writer` remain the forensic pair.
 */
export type PlanLogEvent = AttributedAuditEvent & { n: number }

/**
 * Present a trail to the caller: guarantee the `writer` so `seq` is readable, and
 * number the view so a reader can see it is whole — a portal-scoped view interleaves
 * several independent per-writer counters, so `seq` alone reads as gappy (#49).
 * The events are fresh copies; the log's own entries stay frozen, and `detail` is
 * still the frozen original, so nothing here can alter the trail after the fact.
 */
function asPlanLog(
  events: readonly AuditEvent[],
  limit?: number,
): {
  events: readonly PlanLogEvent[]
  count: number
} {
  // A BOUND, because the caller that reads this most is a model with a context window
  // (#146). #30 decided to DECLARE the log unbounded rather than cap it, and the
  // declaration was honest and well written; what it could not change is that "expect the
  // whole history" moves the cost to the reader, and when the reader is an assistant the
  // cost lands as silently degraded evidence rather than as an error anyone sees.
  //
  // `n` STAYS ABSOLUTE. It is the event's position in the whole log, not in this slice, so
  // a limit of 3 against 174 events returns n 172, 173, 174 out of count 174 — which says
  // both that this is a window and WHERE the window sits. An unbounded read is unchanged,
  // since the offset is then zero.
  const total = events.length
  const from = limit === undefined ? 0 : Math.max(0, total - limit)
  return {
    events: events
      .slice(from)
      .map((event, i) => ({ ...attributeToWriter(event), n: from + i + 1 })),
    count: total,
  }
}

export function createHandlers(deps: McpHandlerDeps) {
  return {
    listPortals() {
      return { portals: deps.registry.list(), selected: deps.registry.getSelected() ?? null }
    },
    setPortal(portalKey: string) {
      deps.registry.setSelected(portalKey)
      return { selected: portalKey }
    },
    getRecord(input: GetRecordInput): Promise<GetRecordResult> {
      return deps.reads.getRecord(input)
    },
    searchRecords(input: SearchRecordsInput): Promise<SearchRecordsResult> {
      return deps.reads.searchRecords(input)
    },
    recentActivity(input: RecentActivityInput): Promise<RecentActivityResult> {
      return deps.reads.recentActivity(input)
    },
    summarizePipeline(input: SummarizePipelineInput): Promise<SummarizePipelineResult> {
      return deps.reads.summarizePipeline(input)
    },
    draftPlan(portalKey: string, operation: WriteOperation): WritePlan {
      return deps.plans.draft({ portalKey, operation })
    },
    validatePlan(planId: string): WritePlan {
      return deps.plans.validate(planId)
    },
    inspectPlanTarget(planId: string): Promise<WritePlan> {
      return deps.plans.inspectTarget(planId)
    },
    showPlan(planId: string): WritePlan & { approvalPhrase: string } {
      const plan = deps.plans.get(planId)
      // Echo the exact phrase needed to approve, so it can be copied verbatim.
      return { ...plan, approvalPhrase: expectedApprovalPhrase(plan.id, plan.portalKey) }
    },
    approvePlan(planId: string, confirmation: string): WritePlan {
      return deps.plans.approve(planId, confirmation)
    },
    async executePlan(
      planId: string,
      opts?: { skipInspection?: boolean; acceptMissingTargets?: boolean },
    ): Promise<WritePlan> {
      return deps.plans.execute(planId, opts)
    },
    getPlanLog(opts?: { portalKey?: string; allPortals?: boolean; limit?: number }): {
      events: readonly PlanLogEvent[]
      count: number
    } {
      // Default-hygiene (RT-08): the audit log is per-portal by default — a no-arg
      // call returns the SELECTED portal's events (mirroring the read tools), not
      // every portal's. Whole-log review is the explicit `allPortals` opt-in.
      // NOTE: this is not an isolation boundary — an explicit portal key can still
      // name any configured portal, and `allowRead` is not enforced here (operator
      // forensic access).
      const allPortals = opts?.allPortals ?? false
      const portalKey = opts?.portalKey
      if (portalKey !== undefined && allPortals) {
        throw new SafeError('get_audit_log: pass a portal OR allPortals, not both')
      }
      const limit = opts?.limit
      if (allPortals) return asPlanLog(deps.auditAll(), limit)
      const key = portalKey ?? deps.registry.getSelected()
      if (key === undefined) {
        throw new SafeError(
          'get_audit_log: no portal given and none selected — name a portal, set a default, or pass allPortals',
        )
      }
      return asPlanLog(deps.auditForPortal(key), limit)
    },
  }
}
