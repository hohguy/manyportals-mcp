import type { AssociationSpec, WriteOperation } from './index.js'

/**
 * Named low-risk write operations (the public-facing v1 write surface, P1.1).
 *
 * Each function COMPILES ergonomic inputs into the internal `WriteOperation`
 * shape and nothing more — the result still enters the lifecycle at
 * `PlanService.draft` and passes every existing gate (explicit portal,
 * default-deny allowedObjects/allowedOperations, blocked-property screen,
 * contamination check, preflight, approval). There is NO new mutation path:
 * these are drafting sugar over the same single choke point (AR-2).
 *
 * Property names: notes/tasks names are confirmed against HubSpot's public
 * docs; calls/meetings names follow the same engagement pattern but their
 * guide pages are login-gated — confirmed at the operator preflight.
 * A wrong name fails loudly at execute with a
 * sanitized HubSpot 400 — it cannot mis-route or leak.
 *
 * `hs_timestamp` is required by HubSpot for engagement creation; callers may
 * pass an explicit ISO-8601/epoch-ms string, else `defaultTimestamp` (the
 * draft time, supplied by the MCP layer) is used.
 */

/** Build a properties record, dropping undefined optionals (never sends an empty key). */
function props(entries: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(entries)) if (v !== undefined) out[k] = v
  return out
}

export interface AddNoteInput {
  body: string
  /** Engagement timestamp (ISO 8601 or epoch ms). Defaults to the draft time. */
  at?: string
  associations?: AssociationSpec[]
}

export function compileAddNote(input: AddNoteInput, defaultTimestamp: string): WriteOperation {
  return {
    kind: 'create',
    objectType: 'notes',
    properties: props({
      hs_note_body: input.body,
      hs_timestamp: input.at ?? defaultTimestamp,
    }),
    associations: input.associations,
  }
}

export interface CreateTaskInput {
  subject: string
  body?: string
  /** Due date (ISO 8601 or epoch ms). Defaults to the draft time. */
  dueAt?: string
  /** e.g. NOT_STARTED / IN_PROGRESS / COMPLETED (HubSpot task status). */
  status?: string
  /** e.g. LOW / MEDIUM / HIGH (HubSpot task priority). */
  priority?: string
  associations?: AssociationSpec[]
}

export function compileCreateTask(
  input: CreateTaskInput,
  defaultTimestamp: string,
): WriteOperation {
  return {
    kind: 'create',
    objectType: 'tasks',
    properties: props({
      hs_task_subject: input.subject,
      hs_task_body: input.body,
      hs_timestamp: input.dueAt ?? defaultTimestamp,
      hs_task_status: input.status,
      hs_task_priority: input.priority,
    }),
    associations: input.associations,
  }
}

export interface LogCallInput {
  body: string
  title?: string
  /** When the call happened (ISO 8601 or epoch ms). Defaults to the draft time. */
  at?: string
  /** INBOUND or OUTBOUND (HubSpot call direction). */
  direction?: string
  /** Duration in milliseconds, as a string. */
  durationMs?: string
  associations?: AssociationSpec[]
}

export function compileLogCall(input: LogCallInput, defaultTimestamp: string): WriteOperation {
  return {
    kind: 'create',
    objectType: 'calls',
    properties: props({
      hs_call_body: input.body,
      hs_call_title: input.title,
      hs_timestamp: input.at ?? defaultTimestamp,
      hs_call_direction: input.direction,
      hs_call_duration: input.durationMs,
    }),
    associations: input.associations,
  }
}

export interface LogMeetingInput {
  title: string
  body?: string
  /** Meeting start (ISO 8601 or epoch ms). Also used as the engagement timestamp; defaults to the draft time. */
  startAt?: string
  /** Meeting end (ISO 8601 or epoch ms). */
  endAt?: string
  associations?: AssociationSpec[]
}

export function compileLogMeeting(
  input: LogMeetingInput,
  defaultTimestamp: string,
): WriteOperation {
  const start = input.startAt ?? defaultTimestamp
  return {
    kind: 'create',
    objectType: 'meetings',
    properties: props({
      hs_meeting_title: input.title,
      hs_meeting_body: input.body,
      hs_timestamp: start,
      hs_meeting_start_time: start,
      hs_meeting_end_time: input.endAt,
    }),
    associations: input.associations,
  }
}

export interface UpdateDealStageInput {
  dealId: string
  /** Target stage id (discoverable via summarize_pipeline). */
  stageId: string
  /** Pipeline id, when the portal has more than one deal pipeline. */
  pipelineId?: string
}

export function compileUpdateDealStage(input: UpdateDealStageInput): WriteOperation {
  return {
    kind: 'update',
    objectType: 'deals',
    objectId: input.dealId,
    properties: props({
      dealstage: input.stageId,
      pipeline: input.pipelineId,
    }),
  }
}
