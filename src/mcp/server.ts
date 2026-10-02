import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { AuditQuery } from '../audit/index.js'
import type { PlanService, WriteOperation } from '../plans/index.js'
import {
  compileAddNote,
  compileCreateTask,
  compileLogCall,
  compileLogMeeting,
  compileUpdateDealStage,
} from '../plans/named-operations.js'
import type { PortalRegistry } from '../portals/index.js'
import type { ReadService } from '../reads/index.js'
import { publicErrorMessage } from '../errors/index.js'
import { redactCredentials, redactCredentialsDeep } from '../config/credential-shape.js'
import { createHandlers } from './handlers.js'

const associationSpec = z.object({ toType: z.string(), toId: z.string() })

const writeOperationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('create'),
    objectType: z.string(),
    properties: z.record(z.string(), z.string()),
    associations: z.array(associationSpec).optional(),
  }),
  z.object({
    kind: z.literal('update'),
    objectType: z.string(),
    objectId: z.string(),
    properties: z.record(z.string(), z.string()),
  }),
])

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

// CHOKEPOINT. Every tool result leaves through one of these two, so credential-shaped
// text supplied by the caller is removed here rather than at each of the dozen places
// that build a message from an argument. A refusal reads `object type "<objectType>"
// is not allowed`, so a token passed as an argument came straight back (#112 7a).
//
// The DATA is redacted, then serialized — not the other way round (#123 3b). Redacting
// the serialized JSON minted DUPLICATE keys, because two distinct credential-shaped
// property names collapse to one placeholder: a parser keeps the last, so the caller
// silently lost a property while the stored plan retained both. Deduplicating keys while
// they are still keys is the only ordering whose output cannot be malformed, and it is
// the same `redactCredentialsDeep` the audit sink uses, so the two cannot drift apart.
const ok = (data: unknown): ToolResult => ({
  // TWO passes, and both are needed. The deep walk handles KEYS, which redacting
  // serialized JSON cannot: two credential-shaped keys reduce to one placeholder and mint
  // a duplicate JSON key, after which a parser keeps the last and the caller silently
  // loses a property. The walk deliberately does not descend into non-plain objects,
  // because rebuilding one destroys it, so the string pass afterwards covers whatever the
  // walk did not reach. Where the walk already did the work, the string pass is a no-op.
  content: [
    { type: 'text', text: redactCredentials(JSON.stringify(redactCredentialsDeep(data), null, 2)) },
  ],
})

const fail = (e: unknown): ToolResult => ({
  // Only branded SafeError messages are surfaced; unknown errors are genericized (P2.3).
  content: [{ type: 'text', text: redactCredentials(publicErrorMessage(e)) }],
  isError: true,
})

export interface McpServerDeps {
  registry: PortalRegistry
  plans: PlanService
  reads: ReadService
  audit: AuditQuery
  serverName?: string
  version?: string
}

/**
 * Build the ManyPortals MCP server: the skeleton tool surface. Reads + the
 * write-PLAN lifecycle are exposed; no raw write tools are registered (AR-2).
 */
export function createMcpServer(deps: McpServerDeps): McpServer {
  const server = new McpServer({
    name: deps.serverName ?? 'manyportals-mcp',
    version: deps.version ?? '0.0.0',
  })

  const h = createHandlers({
    registry: deps.registry,
    plans: deps.plans,
    reads: deps.reads,
    auditForPortal: (k) => deps.audit.forPortal(k),
    auditAll: () => deps.audit.all(),
  })

  const portal = deps.registry.requiredPortalSchema()

  // MCP tool annotations: read-only tools carry `readOnlyHint: true` and the sole
  // HubSpot-mutating tool (execute_plan) carries `destructiveHint: true`, so a client
  // can auto-allow the safe reads and always gate the one write — the machine-readable
  // form of the SAFETY_MODEL guidance "do not auto-approve execute". The HubSpot-read
  // tools record returned ids to the internal contamination index — a benign,
  // idempotent internal write, not a user-visible state change — so readOnlyHint
  // still holds semantically. Draft/validate/preflight/approve mutate local plan
  // state + audit, so they are deliberately NOT marked read-only.
  server.registerTool(
    'list_portals',
    {
      description: 'List configured portals (non-secret) and the selected default.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return ok(h.listPortals())
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'set_default_read_portal',
    {
      description:
        'Set the selected default portal. Used as a fallback for READS only — never for writes.',
      inputSchema: { portal },
    },
    async ({ portal: p }) => {
      try {
        return ok(h.setPortal(p))
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'get_record',
    {
      description:
        'Read one CRM record by object type and id. Uses the explicit portal, else the selected default (reads may default; writes never do). The result names the portal that was read. Without properties, HubSpot returns only its default property set, which can leave out the content a write set (hs_note_body on a note, for one) — to verify a write, name the properties you wrote.',
      inputSchema: {
        portal: portal.optional(),
        objectType: z.string(),
        objectId: z.string(),
        properties: z.array(z.string()).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ portal: p, objectType, objectId, properties }) => {
      try {
        return ok(await h.getRecord({ portalKey: p, objectType, objectId, properties }))
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'search_records',
    {
      description:
        'Search CRM records of an object type with structured filters (propertyName/operator/value, AND-combined). Uses the explicit portal, else the selected default. Filter and returned property names are screened against blocked (sensitive) fields. The result names the portal searched; returned ids feed the cross-portal safety check.',
      inputSchema: {
        portal: portal.optional(),
        objectType: z.string(),
        filters: z
          .array(
            z.object({
              propertyName: z.string(),
              operator: z.string(),
              value: z.string().optional(),
            }),
          )
          .optional(),
        properties: z.array(z.string()).optional(),
        limit: z.number().int().positive().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ portal: p, objectType, filters, properties, limit }) => {
      try {
        return ok(await h.searchRecords({ portalKey: p, objectType, filters, properties, limit }))
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'recent_activity',
    {
      description:
        'Most recently modified records across one or more object types, newest first. objectTypes defaults to the engagement types (notes, calls, emails, meetings, tasks) but ANY object type may be named (e.g. contacts, deals) — it is a general recency reader, capped at 20 types. Uses the explicit portal, else the selected default. Returned property names are screened against blocked (sensitive) fields; a type whose search fails is reported in unavailableTypes WITH a reason (not-found vs auth/permission vs rate-limited), not fatal.',
      inputSchema: {
        portal: portal.optional(),
        objectTypes: z.array(z.string()).optional(),
        properties: z.array(z.string()).optional(),
        limit: z.number().int().positive().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ portal: p, objectTypes, properties, limit }) => {
      try {
        return ok(await h.recentActivity({ portalKey: p, objectTypes, properties, limit }))
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'summarize_pipeline',
    {
      description:
        "Summarize a deal or ticket pipeline: the number of records in each stage (and the total) for the given pipeline, or the portal's first pipeline for that object type if none is named. objectType defaults to 'deals'. Uses the explicit portal, else the selected default. Returns stage labels and counts only — no record fields are returned (a sampled record id per stage is recorded to the internal cross-portal index, per the data-at-rest note in SAFETY_MODEL).",
      inputSchema: {
        portal: portal.optional(),
        objectType: z.enum(['deals', 'tickets']).optional(),
        pipelineId: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ portal: p, objectType, pipelineId }) => {
      try {
        return ok(await h.summarizePipeline({ portalKey: p, objectType, pipelineId }))
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'draft_plan',
    {
      description:
        'Draft a write plan for an EXPLICIT portal. Does not execute. Refuses without an explicit portal key, and refuses any object type or operation not allowlisted for that portal (default-deny). Plans are session-local — a server restart invalidates pending plans; recreate them.',
      inputSchema: { portal, operation: writeOperationSchema },
    },
    async ({ portal: p, operation }) => {
      try {
        return ok(h.draftPlan(p, operation as WriteOperation))
      } catch (e) {
        return fail(e)
      }
    },
  )

  // --- Named low-risk write tools (P1.1): drafting sugar over draft_plan. ---
  // Each compiles its inputs to the internal WriteOperation and enters the SAME
  // lifecycle at draft — no new mutation path (AR-2); every existing gate
  // (default-deny allowlists, blocked properties, contamination, approval) applies.
  const draftNamed = (portalKey: string, operation: WriteOperation) => {
    try {
      return ok(h.draftPlan(portalKey, operation))
    } catch (e) {
      return fail(e)
    }
  }
  const nowIso = () => new Date().toISOString()

  server.registerTool(
    'add_note',
    {
      description:
        'Draft a plan to add a note to an EXPLICIT portal (optionally associated to records). DRAFTS ONLY — nothing is written until the plan passes validate → (preflight) → approve → execute. The portal must allowlist "notes" + "create".',
      inputSchema: {
        portal,
        body: z.string().min(1),
        at: z.string().optional(),
        associations: z.array(associationSpec).optional(),
      },
    },
    async ({ portal: p, body, at, associations }) =>
      draftNamed(p, compileAddNote({ body, at, associations }, nowIso())),
  )

  server.registerTool(
    'create_task',
    {
      description:
        'Draft a plan to create a task in an EXPLICIT portal. DRAFTS ONLY — the plan still requires validate → approve → execute. Status/priority use HubSpot values (e.g. NOT_STARTED, HIGH). The portal must allowlist "tasks" + "create".',
      inputSchema: {
        portal,
        subject: z.string().min(1),
        body: z.string().optional(),
        dueAt: z.string().optional(),
        status: z.string().optional(),
        priority: z.string().optional(),
        associations: z.array(associationSpec).optional(),
      },
    },
    async ({ portal: p, subject, body, dueAt, status, priority, associations }) =>
      draftNamed(
        p,
        compileCreateTask({ subject, body, dueAt, status, priority, associations }, nowIso()),
      ),
  )

  server.registerTool(
    'log_call',
    {
      description:
        'Draft a plan to log a call in an EXPLICIT portal. DRAFTS ONLY — the plan still requires validate → approve → execute. Direction is INBOUND/OUTBOUND; duration is milliseconds. The portal must allowlist "calls" + "create".',
      inputSchema: {
        portal,
        body: z.string().min(1),
        title: z.string().optional(),
        at: z.string().optional(),
        direction: z.string().optional(),
        durationMs: z.string().optional(),
        associations: z.array(associationSpec).optional(),
      },
    },
    async ({ portal: p, body, title, at, direction, durationMs, associations }) =>
      draftNamed(
        p,
        compileLogCall({ body, title, at, direction, durationMs, associations }, nowIso()),
      ),
  )

  server.registerTool(
    'log_meeting',
    {
      description:
        'Draft a plan to log a meeting in an EXPLICIT portal. DRAFTS ONLY — the plan still requires validate → approve → execute. The portal must allowlist "meetings" + "create".',
      inputSchema: {
        portal,
        title: z.string().min(1),
        body: z.string().optional(),
        startAt: z.string().optional(),
        endAt: z.string().optional(),
        associations: z.array(associationSpec).optional(),
      },
    },
    async ({ portal: p, title, body, startAt, endAt, associations }) =>
      draftNamed(p, compileLogMeeting({ title, body, startAt, endAt, associations }, nowIso())),
  )

  server.registerTool(
    'update_deal_stage',
    {
      description:
        'Draft a plan to move a deal to another stage in an EXPLICIT portal. DRAFTS ONLY — the plan still requires validate → preflight (it updates an existing record) → approve → execute. Stage ids are discoverable via summarize_pipeline. The portal must allowlist "deals" + "update".',
      inputSchema: {
        portal,
        dealId: z.string().min(1),
        stageId: z.string().min(1),
        pipelineId: z.string().optional(),
      },
    },
    async ({ portal: p, dealId, stageId, pipelineId }) =>
      draftNamed(p, compileUpdateDealStage({ dealId, stageId, pipelineId })),
  )

  server.registerTool(
    'validate_plan',
    {
      description:
        'Validate a drafted plan (runs the blocked-property policy and the cross-portal contamination check).',
      inputSchema: { planId: z.string() },
    },
    async ({ planId }) => {
      try {
        return ok(h.validatePlan(planId))
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'inspect_plan_target',
    {
      description:
        'Preflight a validated plan that references existing records (update or association): reads each referenced record IN THE TARGET PORTAL and returns a screened identity summary so you can confirm the right record in the right portal before approving. A target not found in the target portal is flagged found=false.',
      inputSchema: { planId: z.string() },
    },
    async ({ planId }) => {
      try {
        return ok(await h.inspectPlanTarget(planId))
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'show_plan',
    {
      description:
        'Show a plan by id, including `approvalPhrase` — the exact phrase to pass to approve_plan.',
      inputSchema: { planId: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ planId }) => {
      try {
        return ok(h.showPlan(planId))
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'approve_plan',
    {
      description:
        'Approve a validated plan. The confirmation must be EXACTLY "approve plan <planId> for <portalKey>" (the plan\'s own id and target portal key) — naming the destination portal at the moment of commit. show_plan returns this string as `approvalPhrase`.',
      inputSchema: { planId: z.string(), confirmation: z.string() },
      // approve_plan is the human authorization gate — NOT read-only. It is marked
      // destructive so an annotation-honoring client gates it (does not auto-allow),
      // preventing the model from self-approving with the phrase it can read from
      // show_plan. It does not mutate HubSpot itself, but it authorizes the write
      // that execute_plan then commits (R4.4).
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ planId, confirmation }) => {
      try {
        return ok(h.approvePlan(planId, confirmation))
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'execute_plan',
    {
      description:
        'Execute a plan. In propose mode it must be approved first; in apply mode it auto-executes ONLY object types blessed for apply (applyAllowedObjects) — every other write still needs approval. A plan referencing existing records must be preflighted first unless skipInspection=true; a preflight-missing target requires acceptMissingTargets=true. In apply mode both options are ignored for object types in applyAllowedObjects, even on an approved plan. Always runs the full pipeline.',
      inputSchema: {
        planId: z.string(),
        skipInspection: z.boolean().optional(),
        acceptMissingTargets: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ planId, skipInspection, acceptMissingTargets }) => {
      try {
        return ok(await h.executePlan(planId, { skipInspection, acceptMissingTargets }))
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'get_audit_log',
    {
      description:
        "Read the append-only audit log for a portal. Defaults to the selected portal (like the read tools); pass an explicit `portal`, or `allPortals: true` for every portal. Errors if no portal is given and none is selected. The result is UNBOUNDED and is not truncated: it returns every recorded event, so on a long-lived setup it can be large — and it grows faster than it used to, because each server copy merges every other copy's trail. Prefer a single `portal` when you only need one, and expect the whole history rather than a recent window. READING THE NUMBERS: each event carries `writer` (the server copy that recorded it) and `seq` (that writer's own 1-based counter). `seq` is per-writer-process — NOT per-portal and NOT global — and it spans every portal that process touched, so in a filtered view the numbering RESTARTS at each writer and SKIPS the numbers that went to other portals. Those restarts and gaps are EXPECTED and do NOT mean events are missing or were removed. `seq` is only meaningful paired with `writer`; `writer: 'legacy'` marks events recorded before per-writer trails existed. For this view's own extent read `n` (each event's position in this result) out of `count`. READING `redacted`: when present it lists short handles for material the SERVER removed from that event, one per distinct value. It is set by the server and cannot be supplied by a caller, so a `(redacted: ...)` marker in an event with no matching handle was typed by whoever made the call rather than put there by the redactor. The same value yields the same handle in every event, so repeated failures involving one unidentified value can be counted without the value ever being stored.",
      inputSchema: { portal: portal.optional(), allPortals: z.boolean().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ portal: p, allPortals }) => {
      try {
        return ok(h.getPlanLog({ portalKey: p, allPortals }))
      } catch (e) {
        return fail(e)
      }
    },
  )

  return server
}
