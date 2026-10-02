/**
 * Credential SHAPE (a HubSpot PAT or a PEM key), and the redactor for anywhere a
 * key is shown.
 *
 * Its own module because BOTH config/index.ts and config/vault.ts need it, and
 * config/index.ts re-exports vault.js, so importing across the two would be
 * circular. Still one TS copy, not two: the other copy is the shell scanners'
 * scripts/cred-pattern.sh, and the parity test in config.test.ts asserts the two
 * agree so drift fails CI rather than resting on a comment.
 *
 * Portal keys and labels pass the key grammar, but a token pasted as either would
 * round-trip to list_portals and the approval phrase, so the shape is rejected
 * (RT-10a).
 *
 * TWO patterns live here, and only the first is mirrored in the shell. DETECTION
 * (`CREDENTIAL_SHAPE`, behind `looksLikeCredential`) answers "is this credential-shaped"
 * and is the one the parity test locks to `cred-pattern.sh`, because the shell scanners
 * ask exactly that question of committed text. REDACTION (`CREDENTIAL_IN_TEXT`) is
 * deliberately BROADER: it has to remove the material, not merely recognise it, so it
 * swallows a whole PEM block where detection stops at the header label (#123 3a). Do not
 * "restore parity" by narrowing the redactor, and do not widen the shell pattern to
 * match it — a scanner that flags a header is doing its job.
 */

import { createHash } from 'node:crypto'
const PAT_SHAPE =
  'pat-[a-z0-9]{2,4}-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'

/** The PEM header LABEL alone. */
const PEM_HEADER = 'BEGIN [A-Z ]*PRIVATE KEY'

const CREDENTIAL_SHAPE = new RegExp(`${PAT_SHAPE}|${PEM_HEADER}`)

export function looksLikeCredential(s: string): boolean {
  return CREDENTIAL_SHAPE.test(s)
}

/** Stands in for a key that must not be shown. */
export const REDACTED_KEY = '(key redacted: it has the shape of a credential)'

/**
 * A map key that is safe to print or interpolate.
 *
 * A credential in the KEY position is a live input class, not a contrived one: a
 * token file written the wrong way round gives `{"<token>": "PORTAL_A"}`, and a PAT
 * satisfies the portal-key grammar, which is exactly why config keys and labels are
 * already guarded. The token-file and vault paths had no such guard, so every site
 * that printed one of their keys printed it verbatim: `vault encrypt` and `vault
 * status` to stdout, and a token-file error into the doctor report the published
 * docs describe as safe to paste back to the assistant (#74, #75).
 *
 * Both of those paths now REFUSE a credential-shaped key at the source. This stays
 * as the second layer, for any key that reaches a print site by another route.
 */
export function redactKey(key: string): string {
  return looksLikeCredential(key) ? REDACTED_KEY : key
}

/** Stands in for a credential-shaped substring found inside free text. */
export const REDACTED_IN_TEXT = '(redacted: credential-shaped value)'

/**
 * A WHOLE PEM block, not the header label alone (#123 3a).
 *
 * `looksLikeCredential` asks "is this value credential-SHAPED", and the header label is
 * a sufficient answer to that. Redaction is a different question, and answering it with
 * the same pattern replaced the header and LEFT THE BASE64 BODY. That is worse than not
 * redacting at all: the record reads as redacted, so whoever reads it concludes the
 * secret is gone. A disposable PKCS#8 key was persisted through `FileAuditLog`, reloaded
 * from disk, re-wrapped in the fixed (public) header and footer, and imported back to
 * byte-identical DER.
 *
 * So the block is consumed whole: from the header, through an `END ... PRIVATE KEY` line
 * if there is one, and OTHERWISE TO THE END OF THE STRING. A header with no END line is
 * still key material, and nothing here can know where such a body stops — taking the
 * remainder of that one string is the only answer that cannot leave a tail behind.
 *
 * The cost is deliberate and bounded: text following an unterminated header inside the
 * SAME string is redacted with it, so a message that quotes such a header loses its own
 * tail. Sibling keys and values are untouched, because `redactCredentialsDeep` below
 * walks the structure and redacts each string separately. Losing the rest of one
 * sentence is the cheaper mistake.
 */
const PEM_BLOCK =
  `(?:-----)?${PEM_HEADER}` + `(?:[\\s\\S]*?END [A-Z ]*PRIVATE KEY(?:-----)?|[\\s\\S]*)`

/**
 * The shape to strip from free TEXT: a PAT, or a whole PEM block. Held as a source
 * string rather than a RegExp because `redactCredentials` needs a fresh object per call.
 */
const CREDENTIAL_IN_TEXT = `${PAT_SHAPE}|${PEM_BLOCK}`

/**
 * Remove every credential-shaped substring from free text.
 *
 * `redactKey` above answers "is this WHOLE value a credential", which is the right
 * question for a map key. It is the wrong one for a sentence, and the sentences are
 * where the problem was: refusal messages interpolate the caller's own words, as in
 * `object type "<objectType>" is not allowed`, so a token supplied as an argument came
 * back in the tool result and went into the append-only trail (#112 7a).
 *
 * Applied at two chokepoints rather than at the twelve sites that build such
 * sentences: the MCP result boundary and the audit sink. Twelve patches would leave
 * the thirteenth site to be written next month.
 */
function redactInto(text: string, note: (handle: string) => void): string {
  // A fresh RegExp per call: a module-level /g object carries lastIndex between uses,
  // and this is not a hot path.
  return text.replace(new RegExp(CREDENTIAL_IN_TEXT, 'g'), (matched) => {
    note(credentialHandle(matched))
    return REDACTED_IN_TEXT
  })
}

export function redactCredentials(text: string): string {
  return redactInto(text, () => {})
}

/**
 * A short, stable handle for redacted material: the first 8 hex of its SHA-256 (#148).
 *
 * WHY THIS IS SAFE HERE, and why it would not be safe generally. A digest of a secret is
 * a commitment to it, so it is only safe over material an attacker cannot enumerate. The
 * two shapes this module redacts are high-entropy BY CONSTRUCTION: a HubSpot PAT is
 * `pat-<region>-<uuid>`, and a PEM block carries base64 key material. Neither is
 * guessable, so 32 bits of digest discloses nothing while letting an operator say "the
 * same unidentified value has been refused four hundred times since the deploy".
 *
 * THE RESIDUAL, stated rather than left for someone to find. An UNTERMINATED PEM header
 * is consumed to the end of its string, by design, because nothing here can know where
 * such a body stops. So the handle for that case covers the trailing text as well, which
 * is the one case where the material may be ordinary low-entropy prose. The docstring on
 * PEM_BLOCK already says that tail is lost; this is the same trade seen from the other
 * side, and it is why this function must not be reused for arbitrary input.
 *
 * Collisions are possible at 32 bits and are harmless in the direction they fail: two
 * distinct values sharing a handle merge in a count, which under-reports rather than
 * discloses.
 */
export function credentialHandle(material: string): string {
  return createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 8)
}

/**
 * Redact a whole DATA STRUCTURE — every string value and every KEY, at any depth.
 *
 * ONE implementation, deliberately, because there are two chokepoints and they must not
 * drift: the audit sink (`src/audit/index.ts`) and the MCP result boundary
 * (`src/mcp/server.ts`). They diverged once, and the divergence was the defect: the MCP
 * boundary redacted the SERIALIZED JSON, which turns two distinct credential-shaped
 * property names into two identical keys in one object. That is not valid JSON in any
 * useful sense — a parser keeps the LAST, so the caller silently loses a property while
 * the stored plan retains both (#123 3b). Redacting the data BEFORE serializing is the
 * only ordering where the output cannot be malformed, because the keys are deduplicated
 * while they are still keys.
 */
/**
 * Only a PLAIN object gets walked. Anything else is returned untouched.
 *
 * Rebuilding an arbitrary object from `Object.entries` destroys it: `Object.entries(new
 * Date())` is `[]`, so a Date became `{}` and `{ at: date }` became `{ at: {} }`. That
 * mattered the moment this walker was applied to every MCP tool result rather than only
 * to audit events. No tool result returns a Date today, so the suite passed and the
 * defect was latent, which is exactly the shape of the two findings this function exists
 * to fix.
 *
 * The cost of not walking them is that a non-plain object's FIELDS are not examined, so
 * the caller pairs this with a final pass over the serialized text. See src/mcp/server.ts.
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v) as unknown
  return proto === Object.prototype || proto === null
}

function deepInto<T>(value: T, note: (handle: string) => void): T {
  if (typeof value === 'string') return redactInto(value, note) as unknown as T
  if (Array.isArray(value)) return value.map((v) => deepInto(v, note)) as unknown as T
  if (isPlainObject(value)) {
    // `Object.create(null)`, not `{}`. On a plain object `out["__proto__"] = v` sets the
    // PROTOTYPE rather than an own property, so a `__proto__` key vanished from the
    // stored event with no error: `{detail:{__proto__:"x", keep:"y"}}` stored as
    // `{detail:{keep:"y"}}`. A plan's `properties` is caller-supplied and `__proto__` is
    // legal JSON, so that is silent loss in an append-only trail, which is the one place
    // silent loss is least acceptable. Same class as RT-06.
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    // KEYS as well as values: a credential can arrive as a property name, which is how
    // the token-file-written-backwards case produced `{"<token>": "PORTAL_A"}` (RT-10a).
    for (const [k, v] of Object.entries(value)) {
      let key = redactInto(k, note)
      // Several keys can land on ONE placeholder, so collisions are numbered rather than
      // allowed to overwrite: losing an entry in order to hide a key trades one problem
      // for a worse one. Numbered WHATEVER THE ORIGIN — the earlier version numbered only
      // when the key had CHANGED, so an object whose key was literally the placeholder
      // string silently overwrote a redacted one and a value vanished (#123 3b). Keys
      // reaching here are unique, so `key in out` can only mean redaction collided.
      if (key in out) {
        let n = 2
        while (`${key} #${n}` in out) n += 1
        key = `${key} #${n}`
      }
      out[key] = deepInto(v, note)
    }
    return out as unknown as T
  }
  return value
}

export function redactCredentialsDeep<T>(value: T): T {
  return deepInto(value, () => {})
}

/**
 * The deep redaction, plus a report of WHAT was redacted (#147).
 *
 * The marker `(redacted: credential-shaped value)` is not itself credential-shaped, so a
 * caller can type it verbatim and nothing transforms it. That makes a refusal reason
 * containing it byte-identical whether the server redacted something or the caller simply
 * wrote the marker: the log could record a redaction that never happened.
 *
 * Signalling redaction inside a caller-influenced string cannot be fixed by escaping,
 * because escaping is a race against the next way to spell it. So the fact moves OUT of
 * band: callers record these handles in a field the caller cannot reach, and a marker
 * with no matching handle is then a forgery rather than an ambiguity.
 *
 * Sorted and de-duplicated: the same value redacted twice in one event is one fact, and a
 * stable order keeps stored events comparable.
 */
export function redactCredentialsWithReport<T>(value: T): { value: T; handles: string[] } {
  const seen = new Set<string>()
  const redacted = deepInto(value, (h) => void seen.add(h))
  return { value: redacted, handles: [...seen].sort() }
}
