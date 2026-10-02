import type { ManyPortalsConfig, PortalConfig, WriteMode } from '../config/index.js'

/**
 * The on-demand `doctor`/`status` report (v1: LOCAL checks only — no live HubSpot
 * calls). It verifies wiring an operator can get wrong before any session: Node
 * version, config validity, the portal inventory, write modes, and whether each
 * portal's token env var is SET (presence only — the value is never read or
 * printed). The live hub-id / scope-preflight checks belong to the operator-run
 * preflight (gated separately); the network version-check ships at release (AR-7).
 */
export interface PortalDoctorReport {
  key: string
  label: string
  apiHost: string
  writeMode: WriteMode
  allowRead: boolean
  allowWrite: boolean
  /** Configured expected hub id, or 'unknown' (0 → boot assertion skips). */
  expectedHubId: number | 'unknown'
  blockedPropertyPatterns: number
  /** Env var name (if the portal uses one), else undefined (file-backed). */
  tokenEnv?: string
  /** Is a token available from any source? The token VALUE is never read or reported. */
  tokenPresent: boolean
  /** Which source provided it ('env' | 'vault' | 'file'), if present. */
  tokenSource?: string
}

export interface DoctorReport {
  product: string
  nodeVersion: string
  nodeOk: boolean
  minNodeMajor: number
  configPath: string
  configOk: boolean
  configError?: string
  writeModeDefault?: WriteMode
  portals: PortalDoctorReport[]
  /** Prominent security warnings (e.g. a group/world-readable token file). */
  securityWarnings: string[]
  /** Non-health setup guidance (e.g. a vault key set but no vault file). Does NOT affect doctorHealthy. */
  notes: string[]
  /** Resolved plaintext token-file path the server would read (#34). Path only, never a value. */
  tokenFilePath?: string
  /** Resolved vault path the server would read (#34) — the bundle passes an override only when
   * the operator filled its OPTIONAL vault-path field, so this can be the default even when the
   * config lives elsewhere. Path only, never a value. */
  vaultFilePath?: string
  /**
   * Is a file present at the resolved vault path? Existence only, contents are never
   * read here. Three states, not two: this was a boolean derived from `existsSync`,
   * which answers false both for "nothing there" and for "I could not look", and the
   * second printed "not found" while token resolution silently used the plaintext
   * file instead (#111). Renamed from vaultFileExists so a stale boolean read cannot
   * compile, since 'absent' is a truthy string.
   */
  vaultFilePresence?: 'present' | 'absent' | 'unknown'
  /** Is the vault ACTIVE (a passphrase was supplied)? The passphrase is never read or printed. */
  vaultActive?: boolean
  /** This build's version, resolved by the caller (#39). */
  serverVersion?: string
  /** Why the version could not be resolved — a PROBLEM, since the server refuses to start without it. */
  versionError?: string
  dataBoundary: string
}

export interface DoctorContext {
  configPath: string
  configError?: string
  /** Token presence per portal (value never read) + which source provided it. */
  tokenPresence: (portalKey: string, portal: PortalConfig) => { present: boolean; source?: string }
  /** Prominent security warnings surfaced by the caller (e.g. loose token-file perms). */
  securityWarnings?: string[]
  /** Non-health setup notes surfaced by the caller (e.g. vault key set but no vault file). */
  notes?: string[]
  /** Resolved token-source paths + vault state, supplied by the caller (paths only, #34). */
  tokenFilePath?: string
  vaultFilePath?: string
  vaultFilePresence?: 'present' | 'absent' | 'unknown'
  vaultActive?: boolean
  /** This build's version, or why it could not be read (#39) — resolved by the caller: this is pure. */
  serverVersion?: string
  versionError?: string
  nodeVersion: string
  minNodeMajor: number
}

function nodeMajor(version: string): number {
  return Number(version.replace(/^v/, '').split('.')[0])
}

/** Build the doctor report. Pure: no IO, no live calls — config + env are passed in. */
export function buildDoctorReport(
  config: ManyPortalsConfig | null,
  ctx: DoctorContext,
): DoctorReport {
  const portals: PortalDoctorReport[] = config
    ? Object.entries(config.portals).map(([key, p]) => {
        // Presence only — never read the value into the report.
        const tp = ctx.tokenPresence(key, p)
        return {
          key,
          label: p.label,
          apiHost: p.apiHost,
          // The EFFECTIVE mode for this portal. This line printed the server-wide
          // value on every portal, which read as a per-portal setting and was one of
          // the things that made the missing per-portal support hard to see (#86).
          writeMode: p.writeMode ?? config.writeMode,
          allowRead: p.allowRead,
          allowWrite: p.allowWrite,
          expectedHubId: p.expectedHubId === 0 ? 'unknown' : p.expectedHubId,
          blockedPropertyPatterns: p.blockedProperties.length,
          tokenEnv: p.tokenEnv,
          tokenPresent: tp.present,
          tokenSource: tp.source,
        }
      })
    : []

  return {
    product: 'manyportals-mcp',
    nodeVersion: ctx.nodeVersion,
    nodeOk: nodeMajor(ctx.nodeVersion) >= ctx.minNodeMajor,
    minNodeMajor: ctx.minNodeMajor,
    configPath: ctx.configPath,
    configOk: config !== null,
    configError: ctx.configError,
    writeModeDefault: config?.writeMode,
    portals,
    securityWarnings: ctx.securityWarnings ?? [],
    notes: ctx.notes ?? [],
    tokenFilePath: ctx.tokenFilePath,
    vaultFilePath: ctx.vaultFilePath,
    vaultFilePresence: ctx.vaultFilePresence,
    vaultActive: ctx.vaultActive,
    serverVersion: ctx.serverVersion,
    versionError: ctx.versionError,
    dataBoundary:
      `${portals.length} portal(s) configured; each routed independently by explicit key. ` +
      `Writes require an explicit portal + the plan lifecycle; reads may use the selected default. ` +
      // The vault was missing from this sentence: it is the middle source, and the
      // one the docs tell operators to move to. A summary of the data boundary that
      // omits a credential source is the same class of stale claim this review has
      // been closing in the published docs.
      `Tokens are read from the environment, then the encrypted vault, then the token ` +
      `file, and are never logged or printed.`,
  }
}

/**
 * Healthy = nothing is WRONG: no security warnings, config valid, Node new enough.
 * Missing tokens are NOT a health failure — they're reported separately as "setup
 * incomplete" (see `doctorSetupComplete`). This keeps a real SECURITY warning from
 * reading the same as a half-finished onboarding portal, so operators don't learn
 * to ignore the red light (P3.5).
 */
export function doctorHealthy(report: DoctorReport): boolean {
  return (
    report.securityWarnings.length === 0 &&
    report.configOk &&
    report.nodeOk &&
    report.versionError === undefined
  )
}

/**
 * Setup complete = every configured portal has a token from some source. Distinct
 * from health: an onboarding portal without a token yet is incomplete, not broken.
 * The server still refuses to start for a tokenless portal — this only changes how
 * `doctor` labels it.
 */
export function doctorSetupComplete(report: DoctorReport): boolean {
  return report.portals.length > 0 && report.portals.every((p) => p.tokenPresent)
}

/** Render the report as operator-facing text. Contains no token values. */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = []
  const mark = (ok: boolean) => (ok ? 'OK ' : 'XX ')
  lines.push(`${report.product} doctor`)
  // Security warnings first, distinct from routine setup issues, so they're never lost (P3.5).
  for (const w of report.securityWarnings) lines.push(`!! ${w}`)
  for (const n of report.notes) lines.push(`ii ${n}`)
  lines.push(
    `${mark(report.nodeOk)} node ${report.nodeVersion} (requires >=${report.minNodeMajor})`,
  )
  // This build's own version (#39). The server reads it strictly at startup, so a layout
  // it cannot be read from is a PROBLEM here, never a silent green.
  if (report.versionError !== undefined) {
    lines.push(`${mark(false)} version: ${report.versionError}`)
  } else if (report.serverVersion !== undefined) {
    lines.push(`${mark(true)} version ${report.serverVersion}`)
  }
  lines.push(`${mark(report.configOk)} config ${report.configPath}`)
  if (!report.configOk) {
    lines.push(`     error: ${report.configError ?? 'could not load config'}`)
    return lines.join('\n')
  }
  // The RESOLVED token-source paths (#34), next to the config path they are easily confused
  // with: the .mcpb bundle passes MANYPORTALS_VAULT_FILE from an OPTIONAL field, so a blank one
  // leaves the vault at the default while the config lives elsewhere. Showing both turns that
  // into a visible fact instead of a false alarm. Paths and existence only — never a token or
  // the passphrase.
  if (report.tokenFilePath !== undefined) lines.push(`   token file: ${report.tokenFilePath}`)
  if (report.vaultFilePath !== undefined) {
    const where =
      report.vaultFilePresence === 'present'
        ? 'present'
        : report.vaultFilePresence === 'unknown'
          ? 'CANNOT TELL: the path could not be read'
          : 'not found'
    const active = report.vaultActive ? 'ACTIVE' : 'INACTIVE'
    lines.push(`   vault file: ${report.vaultFilePath} (${where}; vault ${active})`)
  }
  lines.push(`   write mode (default): ${report.writeModeDefault}`)
  lines.push(`   portals: ${report.portals.length}`)
  for (const p of report.portals) {
    lines.push(`   - ${p.key} (${p.label})`)
    lines.push(
      `       host=${p.apiHost} writeMode=${p.writeMode} allowRead=${p.allowRead} allowWrite=${p.allowWrite} hubId=${p.expectedHubId} blockedPatterns=${p.blockedPropertyPatterns}`,
    )
    const tokenWhere = p.tokenPresent
      ? `set${p.tokenSource ? ` [${p.tokenSource}]` : ''}`
      : 'MISSING'
    const tokenLabel = p.tokenEnv ? `token (env ${p.tokenEnv})` : 'token'
    lines.push(`     ${mark(p.tokenPresent)} ${tokenLabel}: ${tokenWhere}`)
  }
  lines.push(`   data boundary: ${report.dataBoundary}`)
  // Distinguish a real problem (security/config/node) from an unfinished setup
  // (missing tokens), so the SECURITY signal can't be mistaken for "not done yet" (P3.5).
  if (report.securityWarnings.length > 0) {
    lines.push('status: SECURITY WARNING — review the !! line(s) above')
  } else if (!report.nodeOk || !report.configOk || report.versionError !== undefined) {
    lines.push('status: PROBLEMS FOUND')
  } else if (!doctorSetupComplete(report)) {
    lines.push('status: setup incomplete — set the missing token(s) above before connecting')
  } else {
    lines.push('status: healthy')
  }
  return lines.join('\n')
}
