#!/usr/bin/env node
// ManyPortals MCP — entry point + composition root.
// Wires config → registry → real HubSpot client → boot hub-id assertion →
// MCP server → stdio transport. Boot assertion and the transport make live
// calls / open stdio only when an OPERATOR runs the built binary with real
// tokens; nothing here calls HubSpot at import time.
import { randomBytes } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  lstatSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  ConfigError,
  EnvTokenSource,
  FileConfigProvider,
  MapTokenSource,
  VaultError,
  createTokenResolver,
  decryptVaultTokens,
  encryptVaultTokens,
  loadConfig,
  looksLikeCredential,
  readTokenFile,
  readVaultFile,
  vaultWithToken,
  vaultWithoutToken,
  type ManyPortalsConfig,
  type PortalConfig,
  type WriteMode,
  type TokenSource,
  redactKey,
} from './config/index.js'
import { PortalRegistry } from './portals/index.js'
import { HttpHubSpotClient, type HubSpotClient } from './hubspot/index.js'
import { FilePortalIdIndex, PortalIdIndex } from './safety/index.js'
import { FileAuditLog, InMemoryAuditLog, type AuditQuery, type AuditSink } from './audit/index.js'
import { PlanService } from './plans/index.js'
import { ReadService } from './reads/index.js'
import { assertHubIds } from './boot/index.js'
import { createMcpServer } from './mcp/server.js'
import { JsonlDir, isWriterFile, newWriterId } from './store/jsonl-dir.js'
import {
  buildDoctorReport,
  doctorHealthy,
  doctorSetupComplete,
  formatDoctorReport,
} from './doctor/index.js'
import { buildPreflightReport, formatPreflightReport } from './preflight/index.js'
import { SafeError, publicErrorMessage } from './errors/index.js'
import { expandTilde } from './util/index.js'

export const PRODUCT = 'manyportals-mcp' as const

/** Default config path when `MANYPORTALS_CONFIG` is unset. */
export function defaultConfigPath(): string {
  return join(homedir(), '.manyportals', 'config.json')
}

/** Default token-file path when `MANYPORTALS_TOKENS_FILE` is unset. */
export function defaultTokenFilePath(): string {
  return join(homedir(), '.manyportals', 'tokens.json')
}

/** Default encrypted-vault path when `MANYPORTALS_VAULT_FILE` is unset. */
export function defaultVaultFilePath(): string {
  return join(homedir(), '.manyportals', 'tokens.vault')
}

/**
 * A value the HOST was supposed to substitute and did not — `${user_config.x}`
 * arriving verbatim. Never a legitimate path, so it is never treated as one.
 *
 * ONE PLACE on purpose, and it STAYS. This was written on an unverified guess and
 * carried a note to delete it if the guess proved wrong — the guess was right.
 * OBSERVED 2026-09-14 at a Claude Desktop 0.1.2 install (#40): with the optional
 * "Token vault file" left blank, the server's environment arrives as
 *   MANYPORTALS_VAULT_FILE=${user_config.vault_path}
 * verbatim, alongside real values for the fields that were filled in. The MCPB
 * manifest spec does not define this case, so treat it as host behaviour that can
 * differ elsewhere rather than as a guarantee — which is the reason to keep
 * handling BOTH shapes (blank and template).
 *
 * Do not remove this without re-taking that observation. Without it the template
 * becomes the vault path: existsSync fails, readVaultFile reads ENOENT as "no
 * vault", and resolution drops to the plaintext token file — a silent downgrade to
 * the weaker credential source on any machine that still has one.
 */
function isUnexpandedTemplate(value: string): boolean {
  return value.startsWith('${')
}

/**
 * Refuse a RELATIVE path from the environment (#42). Applied after `~` expansion, so
 * `~/…` is accepted and only a path that still depends on the working directory fails.
 *
 * A relative path resolves against the process's working directory, and Claude Desktop
 * starts the server in a different one than the shell an operator runs `doctor` from, so
 * the two can silently read different files. For the vault that is worse than a wrong
 * report: a relative vault path that does not exist from the server's directory reads as
 * "no vault", and resolution falls through to the plaintext token file — the downgrade
 * the template guard above exists to prevent. Refused rather than resolved, because no
 * working directory is the right one to guess.
 *
 * The message names the variable but NOT its value. The vault-path field sits beside the
 * passphrase field in Desktop's settings, so a value pasted into the wrong one would be
 * printed on every start, and `doctor`/`preflight` output is documented as safe to share.
 *
 * Known gap, accepted: on Windows a rooted path with no drive letter (`\portals\x`) counts
 * as absolute but resolves against the CURRENT drive. Only a cross-drive difference can
 * bite, and refusing it would also refuse the POSIX-style fixtures the doctor tests use.
 */
function requireAbsolutePath(name: string, value: string): string {
  // A newline inside a path survives trimming and is rendered verbatim by the doctor
  // report, which lets a value forge report LINES: a decoy "vault file: ... (present;
  // vault ACTIVE)" and an extra "status: healthy" (#80). No secret leaks; what breaks
  // is the integrity of a report the docs tell operators to paste as evidence. The
  // config schema already refuses \p{Cc} in a label, so the convention exists.
  if (/\p{Cc}/u.test(value)) {
    throw new SafeError(
      `${name} contains a control character (a newline or similar). Paths do not, and a ` +
        `value like that can forge lines in the setup report. Value not shown.`,
    )
  }
  if (isAbsolute(value)) return value
  throw new SafeError(
    `${name} must be a full path, but it is relative. A relative path depends on the folder ` +
      `the process starts in, which differs between Claude Desktop and a shell, so the two ` +
      `could read different files. Use the full path, or one starting with ~/.`,
  )
}

/**
 * An env-var SECRET, or undefined when it is effectively unset — the peer of
 * `optionalEnvPath` for values that are not paths.
 *
 * Deliberately NOT built on `optionalEnvPath`: that one calls `expandTilde`, and a
 * passphrase may legitimately begin with `~`. It also returns the value RAW rather
 * than trimmed, because passphrase whitespace is significant on both sides of the
 * vault (config/vault.ts encrypts with exactly what it is given) — trimming here
 * would silently change which passphrases open an existing vault.
 *
 * The blank and template shapes both mean "the operator did not set one" (#40).
 * Reading the raw value instead would make a blank field look like an ACTIVE vault
 * whose key is the literal `${user_config.vault_key}`: with a vault present that is
 * a loud "wrong passphrase" for someone who never chose one, with no vault it makes
 * `doctor` report `vault ACTIVE` when it is not — and in `vault encrypt` it would
 * write a vault encrypted with the template string, which nobody could ever reopen.
 * #36 made the passphrase field optional, which is what put these in reach.
 */
function envSecret(name: string): string | undefined {
  const raw = process.env[name]
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (trimmed === '' || isUnexpandedTemplate(trimmed)) return undefined
  return raw
}

/**
 * An OPTIONAL env-var path, or undefined when it is effectively unset — the caller
 * then uses its default, which is the ordinary state for a field nobody filled in.
 *
 * `??` alone is NOT enough here. Claude Desktop substitutes `user_config` fields
 * into this server's environment, and an optional field the operator left blank
 * does not arrive as `undefined` — it arrives as an empty string, or (host
 * depending) as the literal unexpanded `${user_config.x}`. Neither is `undefined`,
 * so `??` would keep it and the server would go looking for a file that cannot
 * exist. What the guard actually buys, stated plainly: with a vault sitting at the
 * DEFAULT path, a blank field now FINDS it, where before the server looked for a
 * file that could not exist and fell through to the plaintext token file. (The fall
 * -through was never silent — the RT-09 note below fires — and an *unreadable* path
 * is EACCES, which fails loud; only an *absent* one is ENOENT.)
 */
function optionalEnvPath(name: string): string | undefined {
  const trimmed = process.env[name]?.trim()
  if (trimmed === undefined || trimmed === '' || isUnexpandedTemplate(trimmed)) return undefined
  return requireAbsolutePath(name, expandTilde(trimmed))
}

/**
 * The config path this server copy will read: `MANYPORTALS_CONFIG`, else the default.
 *
 * REQUIRED, which is exactly why it does not share `optionalEnvPath`'s rules (#38).
 * Blank still means unset — the default applies, matching the CLI's own unset
 * semantics — but an unexpanded template FAILS LOUD instead of falling back. For
 * this one variable "not configured" must never quietly mean "a different portal
 * set": the default config names other portals, and `main()` derives the data folder
 * from this same path, so the audit trail would land where the operator is not
 * looking. A loud failure is always an acceptable outcome here; a silent
 * substitution of the portal set is not.
 */
export function resolveConfigPath(): string {
  const trimmed = process.env.MANYPORTALS_CONFIG?.trim()
  if (trimmed === undefined || trimmed === '') return defaultConfigPath()
  if (isUnexpandedTemplate(trimmed)) {
    throw new SafeError(
      `MANYPORTALS_CONFIG arrived as an unexpanded template (${trimmed}) — the host did not ` +
        `substitute a path. Set it to a real config path; refusing to fall back to the default ` +
        `config, which would serve a different portal set.`,
    )
  }
  return requireAbsolutePath('MANYPORTALS_CONFIG', expandTilde(trimmed))
}

/**
 * This build's version, from the package.json that ships beside the code.
 *
 * Resolved RELATIVE TO THIS MODULE, so one expression covers every layout the
 * server runs in — `src/index.ts` in the repo, `dist/index.js` in the npm package,
 * and `dist/index.js` inside the installed `.mcpb` bundle. In all three the
 * manifest sits exactly one level up.
 *
 * All three carry package.json because something PUT it there — `scripts/build-mcpb.sh`
 * copies it beside `dist/` in the bundle, npm packaging always ships it, and the
 * Desktop mirror was installed with it — NOT because node requires it. Node runs an
 * ESM entry with no package.json at all (module-syntax detection, on by default
 * since v22.7.0; confirmed on v26.7.0), so a hand-copied `dist/` can arrive without
 * one and still load. It is read STRICTLY rather than defaulted to a placeholder
 * because the placeholder is the bug this replaces — the server advertised version
 * "0.0.0" to every MCP client — and `doctor` reports the failure so that layout
 * cannot look healthy (#39).
 */
export function packageVersion(): string {
  const manifestPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (e) {
    // Bound and named. Nothing here needs to discriminate, since every error rethrows,
    // but saying which one turns "cannot read the manifest" into something actionable.
    const code = (e as NodeJS.ErrnoException)?.code ?? (e as Error)?.name ?? 'read error'
    throw new SafeError(`cannot read the package manifest at ${manifestPath} (${code})`)
  }
  const version = (parsed as { version?: unknown }).version
  if (typeof version !== 'string' || version === '') {
    throw new SafeError(`the package manifest at ${manifestPath} declares no version`)
  }
  return version
}

/**
 * Warn if `path` is group/world-accessible (any 0o077 bit set). Returns undefined
 * if the file is absent (nothing to protect) or its mode is fine. POSIX-only in
 * effect. Shared by the token-file and data-file checks below.
 */
function fileModeWarning(
  path: string,
  what: string,
  fixMode: '600' | '700' = '600',
): string | undefined {
  let mode: number
  try {
    mode = statSync(path).mode
  } catch (e) {
    // ENOENT means there is nothing to protect. Any OTHER failure means we could not
    // look, and reporting "fine" would be a guess in the unsafe direction, so say so
    // (review 2026-09-27: this catch used to treat every error as absence).
    const code = (e as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return undefined
    return `!! SECURITY: cannot check the permissions of ${what} at ${path} (${code ?? 'stat failed'}); check it yourself`
  }
  if ((mode & 0o077) === 0) return undefined
  // A folder needs its execute bit to stay usable, so the advice differs: 600
  // for a file, 700 for a directory.
  return `SECURITY: ${what} is group/world-accessible (mode ${(mode & 0o777).toString(8)}): ${path} — run: chmod ${fixMode} "${path}"`
}

/**
 * Warn if the token file — or the directory containing it — is group/world-
 * accessible (P2.5, P2-b). The file is the only secret we read, so a readable
 * FILE leaks the token; a writable DIRECTORY lets another local user delete and
 * substitute the file (a token-swap the 0600 file-mode check cannot see, and one
 * the boot hub-id assertion only catches if the swap points at a different hub).
 * POSIX only (Windows perms are ACL-based). A missing file produces no warnings.
 */
/**
 * Is there a vault file at this path? Three answers, because there are three facts:
 * it is there, it is not there, or it could not be determined. `existsSync` collapses
 * the last two into false, and the caller read false as "no vault", so an unreadable
 * path reported no vault while token resolution quietly downgraded to the plaintext
 * file (#111).
 */
function probeVaultFile(vaultPath: string): 'present' | 'absent' | 'unknown' {
  try {
    statSync(vaultPath)
    return 'present'
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'absent' : 'unknown'
  }
}

function credentialFilePermWarnings(path: string, what: string): string[] {
  if (process.platform === 'win32') return []
  // `existsSync` answers false for "not there" AND for "I could not look", and both
  // returned []. With the vault's directory un-traversable, a mode-0666 vault produced
  // ZERO warnings and `doctor` printed "status: healthy". The catch below was hardened
  // in the 2026-09-27 sweep; this line, one above it, was not (#111).
  try {
    statSync(path)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return [] // nothing on disk → nothing to protect
    return [
      `!! SECURITY: cannot check ${what} at ${path} (${code ?? 'stat failed'}); check it yourself`,
    ]
  }
  const warnings: string[] = []
  const fileWarn = fileModeWarning(path, what)
  if (fileWarn) warnings.push(fileWarn)
  const dir = dirname(path)
  try {
    const dirMode = statSync(dir).mode
    if ((dirMode & 0o022) !== 0) {
      warnings.push(
        `SECURITY: the ${what}'s directory is group/world-writable (mode ${(dirMode & 0o777).toString(8)}): ${dir} — another user could substitute the file; run: chmod 700 "${dir}"`,
      )
    }
  } catch (e) {
    // Was: skipped in silence. Not being able to look is not the same as nothing
    // being wrong, and the file check above already fails closed this way.
    const code = (e as NodeJS.ErrnoException)?.code
    warnings.push(
      `!! SECURITY: cannot check the permissions of the ${what}'s directory at ${dir} (${code ?? 'stat failed'}); check it yourself`,
    )
  }
  return warnings
}

/**
 * Warn if the persisted data files are group/world-accessible (the P2.5 twin of the
 * token-file check). The id-index is a PLAINTEXT map of which record id belongs to
 * which portal — a cross-portal linkage another local user should not read; the
 * audit log carries object ids + portal keys. Neither holds a token, but both are
 * operator-private. POSIX only; a not-yet-created file warns nothing.
 */
export function dataFilePermWarnings(dataDir: string): string[] {
  if (process.platform === 'win32') return []
  const warnings: string[] = []
  for (const [file, what] of [
    ['id-index.jsonl', 'cross-portal id-index (record→portal linkage map)'],
    ['audit.jsonl', 'audit log'],
  ] as const) {
    const w = fileModeWarning(join(dataDir, file), what)
    if (w) warnings.push(w)
  }
  // The live data now lives in one file per server copy (#24), so the check has
  // to follow it there: the folder itself, then the first readable TRAIL file
  // inside it — one warning per folder, since a launch adds a file and the
  // operator needs the message once, not once per copy. Only writer files count:
  // warning about someone else's `.DS_Store` would make `doctor` exit non-zero
  // for a file that is none of our business.
  for (const [folder, what] of [
    ['id-index.d', 'cross-portal id-index (record→portal linkage map)'],
    ['audit.d', 'audit log'],
  ] as const) {
    const path = join(dataDir, folder)
    const folderWarning = fileModeWarning(path, `${what} folder`, '700')
    if (folderWarning) warnings.push(folderWarning)
    let names: string[]
    try {
      names = readdirSync(path)
    } catch (e) {
      // ENOENT is genuinely "nothing written yet". Anything else means the trail files
      // inside were never examined, and a mode-000 folder made a 0644 trail file
      // invisible to the very check that exists to find it (#111).
      const code = (e as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') continue
      warnings.push(
        `!! SECURITY: cannot list the ${what} folder at ${path} (${code ?? 'readdir failed'}); the files inside were NOT checked`,
      )
      continue
    }
    for (const name of names.filter(isWriterFile)) {
      const w = fileModeWarning(join(path, name), what)
      if (w) {
        warnings.push(w)
        break
      }
    }
  }
  return warnings
}

/**
 * How many per-copy trail files the data folder holds (#24). Each server run that
 * writes adds one — a run that never writes adds none — so the count grows slowly.
 * It is worth showing in `doctor` because every refresh opens each of these files:
 * the cost is invisible at a handful and starts to tell at hundreds, above all on
 * a synced folder or network mount. Tidying them is a manual choice.
 */
export function trailFileNotes(dataDir: string): string[] {
  const notes: string[] = []
  for (const [folder, what] of [
    ['audit.d', 'audit trail'],
    ['id-index.d', 'id-index'],
  ] as const) {
    let count: number
    try {
      count = readdirSync(join(dataDir, folder)).filter(isWriterFile).length
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') continue // absent → this copy has not written yet
      notes.push(
        `${what}: cannot list ${folder}/ (${code ?? 'readdir failed'}), so the count below is unknown`,
      )
      continue
    }
    if (count === 0) continue
    const tidy = count > 50 ? ' — tidy old ones while no server is running' : ''
    notes.push(
      `${what}: ${count} per-copy file${count === 1 ? '' : 's'} in ${folder}/ (one per server run that wrote)${tidy}`,
    )
  }
  return notes
}

/**
 * Build the token-source chain: per-portal env vars first, then a single token
 * file (portalKey → token) — so an operator can manage many portals' tokens in
 * one place instead of N env vars. Also exposes a presence checker for `doctor`
 * (never reads the value) and the RESOLVED paths it consulted. Throws ConfigError
 * only if the token file exists but is malformed.
 */
/**
 * Where the vault is, from the two places that may name it (#145).
 *
 * ONE implementation, deliberately. The server, `doctor`, `check-portals` and the
 * `vault` commands all ask this question, and four private copies of it is how a
 * setting comes to mean different things to different callers. This repository fixed
 * that exact shape twice on 2026-09-30, in the layout readers (#127) and in the bundle
 * surface check (#120), and the first version of THIS patch shipped a fourth caller
 * that quietly kept its own answer: `vault add` wrote to the default while the server
 * read the config's path, so a token could be added to a vault nothing read.
 *
 * A config-declared path may be RELATIVE, anchored to the directory holding that
 * config. `MANYPORTALS_VAULT_FILE` may not, because it resolves against the process's
 * working directory, which differs between Claude Desktop and a shell (#42). Same
 * word, different anchor, and only one of them is ambiguous.
 *
 * Both named and disagreeing is REFUSED rather than ranked. Choosing a winner means one
 * silently overrides the other for a credential store, and reading a different vault
 * than you meant is the worst failure this path has.
 */
export function resolveVaultPath(configVaultFile?: string, configDir?: string): string {
  const fromEnv = optionalEnvPath('MANYPORTALS_VAULT_FILE')
  const fromConfig =
    configVaultFile === undefined
      ? undefined
      : isAbsolute(expandTilde(configVaultFile))
        ? expandTilde(configVaultFile)
        : resolve(configDir ?? '.', configVaultFile)
  if (fromEnv !== undefined && fromConfig !== undefined && fromEnv !== fromConfig) {
    throw new SafeError(
      `the vault file is named twice and the two disagree: MANYPORTALS_VAULT_FILE says ` +
        `${fromEnv}, and vaultFile in the config says ${fromConfig}. Remove one, so which ` +
        `vault is read is not decided by which check runs first.`,
    )
  }
  return fromEnv ?? fromConfig ?? defaultVaultFilePath()
}

export function buildTokenSources(opts?: { vaultFile?: string; configDir?: string }): {
  resolve: (portalKey: string, portal: PortalConfig) => string
  presence: (portalKey: string, portal: PortalConfig) => { present: boolean; source?: string }
  securityWarnings: string[]
  notes: string[]
  /** Resolved plaintext token-file path — a PATH only; no token value is exposed (#34). */
  tokenFilePath: string
  /** Resolved vault path, whether a file is there, and whether a passphrase makes it active (#34). */
  vaultFilePath: string
  vaultFilePresence: 'present' | 'absent' | 'unknown'
  vaultActive: boolean
} {
  const tokenFilePath = optionalEnvPath('MANYPORTALS_TOKENS_FILE') ?? defaultTokenFilePath()
  // Two places may name the vault, and this REFUSES rather than picking a winner (#145).
  //
  // `vaultFile` in the config is the declared setting; MANYPORTALS_VAULT_FILE is the
  // environment override. Choosing a precedence means one silently overrides the other
  // for a CREDENTIAL STORE, and "silently reads a different vault than you meant" is
  // the worst failure this path has. Equal is fine. One set is fine. Both set and
  // different is a question nobody should answer by guessing, so it is asked out loud.
  //
  // Neither path is echoed as a secret: they are paths, and doctor already prints them.
  const vaultFilePath = resolveVaultPath(opts?.vaultFile, opts?.configDir)
  const env: TokenSource = new EnvTokenSource(process.env)
  // Encrypted vault (active only when the master passphrase is provided): sits
  // between env and the plaintext file — an intentional vault beats a leftover
  // plaintext file. A wrong passphrase fails loud here (sanitized VaultError).
  const vaultKey = envSecret('MANYPORTALS_VAULT_KEY')
  const vaultActive = vaultKey !== undefined
  // Probed once: used by the RT-09 note below and reported by `doctor` (#34).
  // Three states. `existsSync` gave two, and its false covered both "no vault" and
  // "the path could not be read", so doctor reported no vault while resolution
  // downgraded to the plaintext file (#111).
  const vaultFilePresence = probeVaultFile(vaultFilePath)
  const vault: TokenSource = new MapTokenSource(
    vaultKey !== undefined ? readVaultFile(vaultFilePath, vaultKey) : {},
  )
  // BOTH credential files. The vault was never checked, so the end state this tool
  // recommends — vault only, plaintext deleted — was the one configuration with no
  // permission check at all, on a machine whose sync is known to rewrite modes (#77).
  const warnings = [
    ...credentialFilePermWarnings(tokenFilePath, 'token file'),
    ...credentialFilePermWarnings(vaultFilePath, 'vault file'),
  ]
  const notes: string[] = []
  // The MIRROR of RT-09 below, and the direction that was never covered: a vault file
  // sitting at the resolved path with no passphrase set. Resolution drops to the
  // plaintext file and nothing was said, which is the same silent downgrade to the
  // weaker source that RT-09 exists to prevent. It also makes the documented go-live
  // gate misleading: with the plaintext file deleted, as the docs tell operators to
  // do, the failure reads "set an entry in the token file" and never mentions the
  // vault whose passphrase is the actual fix (#79).
  if (!vaultActive && vaultFilePresence === 'present') {
    notes.push(
      `a vault file exists at ${vaultFilePath} but MANYPORTALS_VAULT_KEY is not set, so the ` +
        `vault is INACTIVE and tokens come from the environment or the plaintext token file. ` +
        `Set the passphrase to use the vault.`,
    )
  }
  // RT-09: a vault key set but NO vault file at the resolved path is almost always a
  // typo'd MANYPORTALS_VAULT_FILE, or a key set before `vault encrypt`. readVaultFile
  // returns {} for BOTH "absent" and "empty", so probe existence explicitly. WARN so
  // the silent downgrade to the plaintext file is visible — but as a NON-health note,
  // not a security warning: key-before-encrypt is a legitimate onboarding step and
  // must not red-light `doctor` (P3.5).
  if (vaultFilePresence === 'unknown') {
    notes.push(
      `cannot tell whether a vault file exists at ${vaultFilePath}: the path could not be read. ` +
        `If a vault is configured there, tokens may be coming from the environment or the ` +
        `plaintext token file instead.`,
    )
  }
  if (vaultActive && vaultFilePresence === 'absent') {
    notes.push(
      `MANYPORTALS_VAULT_KEY is set but no vault file at ${vaultFilePath} — using other token ` +
        `sources. Create it with 'vault encrypt', unset the key, or fix MANYPORTALS_VAULT_FILE.`,
    )
  }
  // The plaintext token file is the LOWEST-priority source. When the vault is the
  // active source it outranks the file, so a leftover/malformed tokens.json must not
  // break startup — tolerate it as a warning. Without a vault, a malformed file is a
  // hard ConfigError (a genuine setup error worth failing on).
  let file: TokenSource
  try {
    file = new MapTokenSource(readTokenFile(tokenFilePath))
  } catch (e) {
    if (!vaultActive) throw e
    warnings.push(
      `WARNING: ignoring an unreadable/malformed token file (the vault is the active source): ${publicErrorMessage(e)}`,
    )
    file = new MapTokenSource({})
  }
  return {
    resolve: createTokenResolver([env, vault, file]),
    presence: (portalKey, portal) => {
      if (env.get(portalKey, portal) !== undefined) return { present: true, source: 'env' }
      if (vault.get(portalKey, portal) !== undefined) return { present: true, source: 'vault' }
      if (file.get(portalKey, portal) !== undefined) return { present: true, source: 'file' }
      return { present: false }
    },
    securityWarnings: warnings,
    notes,
    tokenFilePath,
    vaultFilePath,
    vaultFilePresence,
    vaultActive,
  }
}

export interface StartDeps {
  config: ManyPortalsConfig
  client: HubSpotClient
  resolveToken: (portalKey: string) => string
  /** Persistence (defaults to in-memory); main() injects file-backed stores. */
  idIndex?: PortalIdIndex
  audit?: AuditSink & AuditQuery
  /** Injectable for tests; defaults to a real stdio transport. */
  transport?: Transport
  warn?: (message: string) => void
}

/**
 * Compose the server and connect it. The boot hub-id assertion runs BEFORE the
 * transport connects — a swapped/mislabelled token refuses startup rather than
 * exposing tools (AR / §3.3). Returns the wired pieces for inspection.
 */
export async function startServer(deps: StartDeps): Promise<{
  registry: PortalRegistry
  plans: PlanService
  audit: AuditSink & AuditQuery
  /** Returned so the real entry can close it on a signal (#157). Tests ignore it. */
  close: () => Promise<void>
}> {
  const registry = new PortalRegistry(deps.config)
  const idIndex = deps.idIndex ?? new PortalIdIndex()
  const audit = deps.audit ?? new InMemoryAuditLog()
  const plans = new PlanService({
    registry,
    client: deps.client,
    idIndex,
    audit,
    resolveToken: deps.resolveToken,
    writeMode: deps.config.writeMode,
    // AR-3 rules that writeMode is per-portal. `perPortalWriteMode` existed on the
    // service and was set NOWHERE outside a test, so `apply` applied to every
    // configured portal at once, and the test proving apply-mode is bounded per
    // portal exercised a configuration production could not produce (#86).
    // Null-prototype (RT-06, as config.portals and the token map already are). A
    // portal may legally be named `toString` or `constructor`, and a plain object
    // would return the INHERITED function for that lookup instead of falling through
    // to the server-wide default — so such a portal would silently ignore a
    // server-wide `apply`. It fails toward propose, but it is still the wrong value.
    perPortalWriteMode: Object.assign(
      Object.create(null) as Record<string, WriteMode>,
      Object.fromEntries(
        Object.entries(deps.config.portals)
          .filter(([, portal]) => portal.writeMode !== undefined)
          .map(([key, portal]) => [key, portal.writeMode as WriteMode]),
      ),
    ),
  })
  const reads = new ReadService({
    registry,
    client: deps.client,
    idIndex,
    resolveToken: deps.resolveToken,
  })

  // Resolved BEFORE the boot guard (#39): it is a local read that can fail on a
  // hand-copied layout, and a start already doomed by it must not spend a live
  // HubSpot call per portal first.
  const version = packageVersion()

  // Boot guard FIRST (may make live calls when run with real tokens).
  await assertHubIds(registry, deps.client, deps.resolveToken, deps.warn)

  const server = createMcpServer({ registry, plans, reads, audit, version })
  await server.connect(deps.transport ?? new StdioServerTransport())
  return { registry, plans, audit, close: () => server.close() }
}

/**
 * Close on SIGTERM/SIGINT instead of dying by the default disposition (#157).
 *
 * MEASURED first, because the ticket's premise was wrong: this server already exits
 * code=0 when stdin closes, which is the path Claude Desktop uses, so stdin needs
 * nothing here. On a signal it was killed outright: `code=null signal=SIGTERM`.
 *
 * What that costs is small and specific. A supervisor, and Docker especially, records
 * the container as KILLED rather than stopped, and shutdown had no reporting surface
 * at all, which is the far end of #144 (a startup failure reports only "Server
 * disconnected"). The lifecycle was silent at both ends.
 *
 * NOT a durability fix, and must not be sold as one. An abrupt kill is already a
 * modelled case: SAFETY.md states that an `attempt` line with no `execute` or `fail`
 * after it means "check HubSpot", and that contract is unchanged.
 *
 * The timeout is the point of the whole thing. A close that hangs must not leave a
 * process holding portal tokens and a vault passphrase alive forever while LOOKING
 * like it shut down, which would be worse than being killed.
 */
export function installShutdown(
  close: () => Promise<void>,
  exit: (code: number) => void = (c) => process.exit(c),
  write: (s: string) => void = (s) => void process.stderr.write(s),
  timeoutMs = 2000,
): void {
  let closing = false
  const shutdown = (why: string): void => {
    if (closing) return // a second signal must not start a second close
    closing = true
    const forced = setTimeout(() => {
      write(`manyportals-mcp: ${why} received, close did not finish in ${timeoutMs}ms; exiting\n`)
      exit(1)
    }, timeoutMs)
    // unref so this timer alone cannot hold the process open if close resolves first
    if (typeof forced.unref === 'function') forced.unref()
    void close()
      .then(() => {
        clearTimeout(forced)
        write(`manyportals-mcp: ${why} received, shut down cleanly\n`)
        exit(0)
      })
      .catch(() => {
        clearTimeout(forced)
        // The reason is deliberately not printed: a close failure can carry a path or
        // a response body, and this message reaches the operator's logs unsanitized.
        write(`manyportals-mcp: ${why} received, close failed; exiting\n`)
        exit(1)
      })
  }
  process.once('SIGTERM', () => shutdown('SIGTERM'))
  process.once('SIGINT', () => shutdown('SIGINT'))
}

/** Real entry: assemble production deps (file config, env tokens, HTTP client, stdio). */
export async function main(): Promise<void> {
  const path = resolveConfigPath()
  const config = loadConfig(new FileConfigProvider(path))
  const tokens = buildTokenSources({ vaultFile: config.vaultFile, configDir: dirname(path) })
  for (const w of tokens.securityWarnings) process.stderr.write(`${w}\n`)
  for (const n of tokens.notes) process.stderr.write(`note: ${n}\n`)
  const resolveToken = (portalKey: string): string => {
    const portal = config.portals[portalKey]
    if (!portal) throw new ConfigError(`unknown portal "${portalKey}"`)
    return tokens.resolve(portalKey, portal)
  }
  // Persist audit + the contamination index alongside the config (non-secret).
  const dataDir = dirname(path)
  for (const w of dataFilePermWarnings(dataDir)) process.stderr.write(`${w}\n`)
  const warn = (m: string): void => void process.stderr.write(`${m}\n`)
  // This copy's own trail file (#24): copies append only to their own file, so
  // several can share one data folder. The legacy single-writer `audit.jsonl`
  // stays readable history and is never appended to again.
  const writerId = newWriterId()
  const started = await startServer({
    config,
    client: new HttpHubSpotClient(),
    resolveToken,
    idIndex: new FilePortalIdIndex(
      new JsonlDir(join(dataDir, 'id-index.d'), writerId, join(dataDir, 'id-index.jsonl')),
      (portalKey) => config.portals[portalKey]?.expectedHubId,
      warn,
    ),
    audit: new FileAuditLog(
      new JsonlDir(join(dataDir, 'audit.d'), writerId, join(dataDir, 'audit.jsonl')),
      warn,
    ),
    warn,
  })
  // Installed HERE and not in startServer: process-level handlers in a function the
  // tests call hundreds of times would leak across them.
  installShutdown(started.close)
}

/**
 * `doctor` subcommand: print a LOCAL wiring report (Node, config, portal
 * inventory, token-env presence) and exit. No live HubSpot calls; the token
 * value is never read or printed (presence only). Exits non-zero if any check
 * fails, so it is scriptable before starting the server.
 */
export function runDoctorCli(): never {
  // A config path the host failed to substitute is a hard stop, not a report line:
  // every line below it would describe a DIFFERENT portal set than the operator
  // named (#38). Reported as a doctor failure rather than a raw stack, like the
  // token-file failure below.
  let path: string
  try {
    path = resolveConfigPath()
  } catch (e) {
    process.stdout.write(`manyportals-mcp doctor\nXX  ${publicErrorMessage(e)}\n`)
    process.exit(1)
  }
  // This build's own version (#39). Resolved HERE, in the CLI layer, because
  // buildDoctorReport is pure — the same way the resolved paths are passed in. The
  // server reads it strictly at startup, so a failure is reported as a problem
  // rather than thrown: doctor must still produce a report.
  let serverVersion: string | undefined
  let versionError: string | undefined
  try {
    serverVersion = packageVersion()
  } catch (e) {
    versionError = publicErrorMessage(e)
  }
  let config: ManyPortalsConfig | null = null
  let configError: string | undefined
  try {
    config = loadConfig(new FileConfigProvider(path))
  } catch (e) {
    configError = publicErrorMessage(e)
  }
  let presence: (portalKey: string, portal: PortalConfig) => { present: boolean; source?: string }
  let securityWarnings: string[] = []
  let notes: string[] = []
  // The RESOLVED paths this server copy would actually read (#34) — paths only.
  let tokenFilePath: string
  let vaultFilePath: string
  let vaultFilePresence: 'present' | 'absent' | 'unknown' = 'absent'
  let vaultActive = false
  try {
    // The config's declared vaultFile, so doctor reports the vault the SERVER would read
    // rather than a different one. Optional-chained because the config may have failed to
    // load above; then this falls back to the environment and the default, as before.
    const ts = buildTokenSources({ vaultFile: config?.vaultFile, configDir: dirname(path) })
    presence = ts.presence
    securityWarnings = [...ts.securityWarnings, ...dataFilePermWarnings(dirname(path))]
    notes = [...ts.notes, ...trailFileNotes(dirname(path))]
    tokenFilePath = ts.tokenFilePath
    vaultFilePath = ts.vaultFilePath
    vaultFilePresence = ts.vaultFilePresence
    vaultActive = ts.vaultActive
  } catch (e) {
    // A malformed token file is a setup error worth failing on.
    process.stdout.write(`manyportals-mcp doctor\nXX  token file: ${publicErrorMessage(e)}\n`)
    process.exit(1)
  }
  // Defense-in-depth: any config-driven throw while building the report is
  // sanitized to a doctor failure, never a raw stack (which could carry paths or
  // values). The prototype-key guards in the token sources prevent the known crash.
  try {
    const report = buildDoctorReport(config, {
      configPath: path,
      configError,
      tokenPresence: presence,
      securityWarnings,
      notes,
      tokenFilePath,
      vaultFilePath,
      vaultFilePresence,
      vaultActive,
      serverVersion,
      versionError,
      nodeVersion: process.version,
      minNodeMajor: 22,
    })
    process.stdout.write(`${formatDoctorReport(report)}\n`)
    // Exit 0 only when nothing is wrong AND setup is complete, so `doctor && start`
    // still gates on tokens; the report text distinguishes the two cases (P3.5).
    process.exit(doctorHealthy(report) && doctorSetupComplete(report) ? 0 : 1)
  } catch (e) {
    process.stdout.write(`manyportals-mcp doctor\nXX  ${publicErrorMessage(e)}\n`)
    process.exit(1)
  }
}

/**
 * `preflight` subcommand: the stage-6 LIVE gate. Wires real config + tokens + the
 * HTTP client and runs READ-ONLY HubSpot checks per portal (hub id, read scope,
 * the search+sorts and pipelines paths), printing a sanitized report. The token is
 * never read or printed; the OPERATOR runs this and shares the (token-free) output.
 * Exits non-zero if any portal's checks fail. No writes — see docs/GO-LIVE.md.
 */
export async function runPreflightCli(): Promise<never> {
  const path = resolveConfigPath()
  const config = loadConfig(new FileConfigProvider(path))
  const tokens = buildTokenSources({ vaultFile: config.vaultFile, configDir: dirname(path) })
  for (const w of tokens.securityWarnings) process.stderr.write(`${w}\n`)
  for (const n of tokens.notes) process.stderr.write(`note: ${n}\n`)
  const resolveToken = (portalKey: string): string => {
    const portal = config.portals[portalKey]
    if (!portal) throw new ConfigError(`unknown portal "${portalKey}"`)
    return tokens.resolve(portalKey, portal)
  }
  const registry = new PortalRegistry(config)
  const report = await buildPreflightReport({
    registry,
    client: new HttpHubSpotClient(),
    resolveToken,
  })
  process.stdout.write(`${formatPreflightReport(report)}\n`)
  process.exit(report.ok ? 0 : 1)
}

/**
 * Prompt for a secret on the controlling terminal WITHOUT echoing it. The
 * prompt text goes to stderr; typed characters go to a muted stream, so the
 * passphrase never appears on screen, in argv, or in shell history.
 */
async function promptHidden(question: string): Promise<string> {
  process.stderr.write(question)
  const muted = new Writable({ write: (_chunk, _enc, cb) => cb() })
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true })
  try {
    const answer = await new Promise<string>((resolve) => rl.question('', resolve))
    process.stderr.write('\n')
    return answer
  } finally {
    rl.close()
  }
}

/** How the vault commands ask questions: the real terminal, or a test's answers. */
export interface VaultCliIo {
  prompt: (question: string) => Promise<string>
  isTTY: () => boolean
}

/**
 * The portal key argument of `vault add`/`vault remove`. It comes from argv because
 * it is not a secret — which is why a TOKEN pasted there is refused WITHOUT being
 * echoed: every message and report line below would otherwise print it back.
 */
function vaultPortalKeyOrExit(action: string, args: readonly string[]): string {
  const portalKey = args[0]
  if (portalKey === undefined || portalKey.trim() === '') {
    process.stderr.write(`missing portal key — use: vault ${action} <portalKey>\n`)
    process.exit(1)
  }
  // Stored and looked up exactly as typed, so a stray space would file the token under
  // a key the config never names. Refused rather than trimmed, and not echoed.
  if (portalKey !== portalKey.trim()) {
    process.stderr.write(
      `the portal key has leading or trailing spaces — nothing was changed. Use the key exactly as it appears in your config.\n`,
    )
    process.exit(1)
  }
  if (looksLikeCredential(portalKey)) {
    process.stderr.write(
      `that portal key looks like a token (value not shown) — give the portal KEY from your ` +
        `config, e.g. vault ${action} PORTAL_A. If it was a real token, remove it from your ` +
        `shell history.\n`,
    )
    process.exit(1)
  }
  // Anything after the key is refused, not ignored: the likeliest extra argument is
  // the token itself (`vault add PORTAL_A pat-…`), which is already in shell history
  // by the time this runs. Carrying on to the hidden prompt would hide that. The
  // extra arguments are never echoed.
  if (args.length > 1) {
    process.stderr.write(
      `vault ${action} takes one argument, the portal key — nothing was changed. The token ` +
        `is read only at a hidden prompt, never from the command line. If you typed a token ` +
        `here, it is now in your shell history: rotate that key in HubSpot and remove the ` +
        `history entry.\n`,
    )
    process.exit(1)
  }
  return portalKey
}

/**
 * The passphrase for `vault add`/`vault remove`: MANYPORTALS_VAULT_KEY when set, else
 * a hidden prompt. `confirm` asks twice, for a NEW vault — as `vault encrypt` does,
 * because a typo there would lock that vault for good. Against an existing vault one
 * prompt is enough: decryption proves it right, and a wrong one writes nothing.
 */
async function vaultPassphraseOrExit(
  envKey: string | undefined,
  confirm: boolean,
  io: VaultCliIo,
): Promise<string> {
  if (envKey !== undefined) return envKey
  if (!io.isTTY()) {
    process.stderr.write(
      'no terminal for the passphrase prompt — set MANYPORTALS_VAULT_KEY or run interactively\n',
    )
    process.exit(1)
  }
  const passphrase = await io.prompt('vault passphrase (input hidden): ')
  // Refused HERE, before the token prompt: encryptVaultTokens would refuse it too, but
  // only after the operator had pasted a token for nothing.
  if (passphrase.trim() === '') {
    process.stderr.write('the passphrase must not be empty — nothing written\n')
    process.exit(1)
  }
  if (confirm) {
    const again = await io.prompt('confirm passphrase: ')
    if (passphrase !== again) {
      process.stderr.write('passphrases do not match — nothing written\n')
      process.exit(1)
    }
  }
  return passphrase
}

/**
 * The current vault envelope for `vault add`/`vault remove`, or undefined when there
 * is no vault file yet. ENOENT only, mirroring readVaultFile: reading an UNREADABLE
 * vault (EACCES, EISDIR) as absent would let `add` replace it with a one-token vault.
 */
function readVaultEnvelope(vaultPath: string): string | undefined {
  try {
    return readFileSync(vaultPath, 'utf8')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return undefined
    throw new VaultError(`vault file exists but could not be read (${code ?? 'read error'})`)
  }
}

/**
 * The file a vault write must replace. A rename replaces the NAME it is given, so
 * renaming over a symlink would swap the link for a regular file and leave the vault
 * it pointed to untouched: a "removed" token still on disk, reported as removed.
 * `vault encrypt` writes through a link, so follow it here too. A file with more than
 * one hard link is refused, because a rename would leave its other names holding the
 * old tokens; so is a symlink to a file that does not exist.
 */
function vaultWriteTarget(vaultPath: string): string {
  let target: string
  try {
    target = realpathSync(vaultPath)
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw new VaultError(`could not resolve the vault path ${vaultPath}`)
    }
    let isLink = false
    try {
      isLink = lstatSync(vaultPath).isSymbolicLink()
    } catch (e) {
      // ENOENT is the ordinary case: nothing at the path, so a new vault is written
      // there. Any other error means we do not know WHAT is at that path, and writing
      // a vault over an unknown thing is not a safe default (#111).
      const code = (e as NodeJS.ErrnoException)?.code
      if (code !== 'ENOENT') {
        throw new VaultError(
          `cannot determine what is at the vault path ${vaultPath} (${code ?? 'lstat failed'}) — nothing written`,
        )
      }
    }
    if (isLink) {
      throw new VaultError(
        `the vault path ${vaultPath} is a link to a file that does not exist — nothing written`,
      )
    }
    return vaultPath
  }
  const links = statSync(target).nlink
  if (links > 1) {
    throw new VaultError(
      `the vault at ${vaultPath} has ${links} hard links — nothing written, because replacing it would leave the old tokens under the other names`,
    )
  }
  return target
}

/**
 * Replace the vault file in one step: write the envelope to a temp file beside it
 * (random name, exclusive create, owner-only), flush it, then rename it over the
 * vault. A half-written vault would lock out every token in it. The rename is atomic
 * on POSIX; on Windows it replaces the file but makes no such guarantee.
 *
 * `expected` is what the command read at the start. Just before the rename the vault is
 * read again, and a change seen there refuses the write: `vault add` waits at two prompts
 * between reading and writing, and a second run in another terminal would otherwise be
 * silently undone.
 *
 * This is NOT a lock, and not atomic. Two runs can both pass the comparison and then both
 * rename, and the later rename wins, so a simultaneous update can still be lost. It
 * narrows a window measured in prompts down to one measured in syscalls. Real exclusion
 * needs a lock file, which is tracked separately.
 * On failure the temp file is removed and the vault file is left as it was.
 */
function writeVaultAtomically(
  vaultPath: string,
  envelope: string,
  expected: string | undefined,
): void {
  const target = vaultWriteTarget(vaultPath)
  const dir = dirname(target)
  const tempPath = join(dir, `${basename(target)}.${randomBytes(8).toString('hex')}.tmp`)
  let created = false
  try {
    // Owner-only, because the folder holds credentials — as `vault encrypt` creates it.
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const fd = openSync(tempPath, 'wx', 0o600)
    created = true
    try {
      writeFileSync(fd, envelope)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    if (readVaultEnvelope(target) !== expected) {
      throw new VaultError(
        `the vault changed while this command was running (another vault command?) — nothing written; run it again`,
      )
    }
    renameSync(tempPath, target)
  } catch (e) {
    if (created) rmSync(tempPath, { force: true })
    if (e instanceof VaultError) throw e
    const code = (e as NodeJS.ErrnoException)?.code
    throw new VaultError(
      `could not write the vault at ${vaultPath} (${code ?? 'write error'}) — the vault file was not changed`,
    )
  }
}

/**
 * What ELSE would still serve this portal after the vault changed.
 *
 * `vault remove` printed "removed PORTAL_B" and exited 0 while the plaintext token
 * file or an environment variable still served that portal, so a revocation that had
 * not happened read exactly like one. The documented onboarding sequence leaves the
 * plaintext file in place on purpose ("delete it yourself once verified"), so this is
 * the normal state, not an exotic one. Environment variables outrank the vault
 * entirely, which gives `vault add` the mirror defect: it reports a rotation the
 * server will ignore (#76).
 *
 * The environment check needs the CONFIG, because the variable name is per-portal
 * (`portal.tokenEnv`), not a convention. Anything this cannot determine is reported
 * as unknown rather than treated as absent.
 *
 * WHICH sources matter depends on the intent, because resolution is ordered env,
 * then vault, then plaintext file:
 *   revoke — the vault entry is gone, so BOTH of the others would now serve it.
 *   rotate — the vault entry is the new token, and only a source that OUTRANKS the
 *            vault can shadow it. The plaintext file does not, and warning about it
 *            would fire on the documented happy path, where `vault encrypt` leaves
 *            tokens.json in place on purpose.
 */
function otherTokenSourcesFor(portalKey: string, intent: 'revoke' | 'rotate'): string[] {
  const found: string[] = []

  if (intent === 'revoke') {
    const tokenFilePath = optionalEnvPath('MANYPORTALS_TOKENS_FILE') ?? defaultTokenFilePath()
    try {
      if (Object.hasOwn(readTokenFile(tokenFilePath), portalKey)) {
        found.push(
          `the plaintext token file still has an entry for "${portalKey}": ${tokenFilePath}`,
        )
      }
    } catch (e) {
      found.push(
        `could not read the plaintext token file, so its entry for "${portalKey}" is UNKNOWN: ` +
          `${tokenFilePath} (${publicErrorMessage(e)})`,
      )
    }
  }

  let configPath: string
  try {
    configPath = resolveConfigPath()
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code ?? (e as Error)?.name ?? 'error'
    found.push(
      `UNKNOWN: the config path could not be resolved (${code}), so no environment variable ` +
        `was checked. env OUTRANKS the vault, so a token may still be served.`,
    )
    return found
  }
  // An ABSENT config is not an unknown: no portal is configured, so nothing can serve
  // this key through an environment variable. Only a config that exists and cannot be
  // read leaves the question genuinely open, and only that is worth a warning.
  // Was `existsSync`, which is false both when the config is absent and when its
  // directory cannot be traversed. The second skipped the tokenEnv check below, so
  // `vault remove` printed "the token is revoked" and exited 0 while the environment
  // variable that OUTRANKS the vault still served the portal — the #76 defect this
  // function was written to fix (#111).
  try {
    statSync(configPath)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return found // no config → no portal → no env var can serve it
    found.push(
      `UNKNOWN: the config at ${configPath} could not be read (${code ?? 'stat failed'}), so no ` +
        `environment variable was checked. env OUTRANKS the vault, so a token may still be served.`,
    )
    return found
  }
  try {
    const portal = loadConfig(new FileConfigProvider(configPath)).portals[portalKey]
    if (portal === undefined) {
      // Not a warning: a portal absent from the config cannot be served at all.
      return found
    }
    if (portal.tokenEnv !== undefined) {
      const value = process.env[portal.tokenEnv]
      if (typeof value === 'string' && value.trim() !== '') {
        found.push(
          `the environment variable ${portal.tokenEnv} is set, and env OUTRANKS the vault ` +
            `for "${portalKey}"`,
        )
      }
    }
  } catch (e) {
    found.push(
      `could not read the config, so an environment variable for "${portalKey}" is UNKNOWN: ` +
        `${configPath} (${publicErrorMessage(e)})`,
    )
  }
  return found
}

/**
 * Write a changed vault and report it: portal KEYS only, never a token or passphrase.
 * The new envelope is opened BEFORE it is written — that yields the keys to report,
 * and proves the passphrase just used opens what is about to replace the vault.
 *
 * The report states what the VAULT now holds and, separately, whether the change the
 * operator was actually after took effect. When another source still serves the
 * portal it exits NON-ZERO: the vault write succeeded, but a revocation that did not
 * revoke, or a rotation the server will ignore, must not report success (#76).
 */
function writeVaultAndReport(
  vaultPath: string,
  expected: string | undefined,
  envelope: string,
  passphrase: string,
  change: string,
  portalKey: string,
  intent: 'revoke' | 'rotate',
): never {
  const keys = Object.keys(decryptVaultTokens(envelope, passphrase))
  writeVaultAtomically(vaultPath, envelope, expected)
  process.stdout.write(
    [
      `${change} — vault: ${vaultPath}`,
      `vault now holds ${keys.length} token(s): ${keys.map(redactKey).join(', ')}`,
      `a running server reads the vault only at startup — restart it to use this change`,
    ].join('\n') + '\n',
  )
  const others = otherTokenSourcesFor(portalKey, intent)
  if (others.length === 0) {
    process.stdout.write(
      intent === 'revoke'
        ? `no other token source provides "${portalKey}" — the token is revoked\n`
        : `no other token source outranks the vault for "${portalKey}"\n`,
    )
    process.exit(0)
  }
  process.stderr.write(
    [
      '',
      intent === 'revoke'
        ? `!! THE TOKEN IS NOT REVOKED. The vault was updated, but "${portalKey}" is still served:`
        : `!! THE NEW TOKEN WILL NOT BE USED. The vault was updated, but for "${portalKey}":`,
      ...others.map((o) => `   - ${o}`),
      intent === 'revoke'
        ? `   Remove it there too, then restart the server. Revoke the key in HubSpot if it leaked.`
        : `   Clear or update that source, then restart the server.`,
      '',
    ].join('\n'),
  )
  process.exit(1)
}

/**
 * `vault` subcommand — operator-side encrypted token custody (AES-256-GCM,
 * scrypt-derived key; see src/config/vault.ts).
 *
 *   vault encrypt  — encrypt the existing plaintext token file into
 *                    tokens.vault. The passphrase comes from
 *                    MANYPORTALS_VAULT_KEY or a hidden interactive prompt; the
 *                    plaintext file is left untouched for the operator to
 *                    delete once the vault is verified.
 *   vault status   — report vault presence and (when the passphrase is set)
 *                    whether it decrypts, naming portal KEYS only.
 *   vault add <portalKey>
 *                  — add or replace ONE portal's token, creating the vault when
 *                    there is none (#23). The token is read ONLY at a hidden
 *                    prompt, so this needs a terminal. The passphrase comes as
 *                    for encrypt, asked twice only when this creates the vault.
 *   vault remove <portalKey>
 *                  — remove ONE portal's token from the existing vault (#23).
 *
 * add and remove replace the vault in one rename (atomic on POSIX), follow a symlinked
 * vault path to the real file, refuse if the vault changed meanwhile, and write
 * nothing on a wrong passphrase. A running server reads the vault only at startup.
 * Token values and passphrases are never printed, echoed, or passed as argv.
 *
 * `io` exists for tests: `add` needs a terminal, and without a way to answer its
 * prompts its success path could only be exercised by hand.
 */
export async function runVaultCli(
  action: string | undefined,
  args: readonly string[] = [],
  io: VaultCliIo = { prompt: promptHidden, isTTY: () => process.stdin.isTTY === true },
): Promise<never> {
  // The SAME question the server asks, asked the same way. This line used to resolve
  // the vault on its own, so `vault add` could write to the default path while the
  // server read the config's `vaultFile`: a token added to a vault nothing reads, with
  // a success message (#145).
  //
  // Best effort on the config, because `vault encrypt` legitimately runs during setup
  // when no usable config exists yet. When it cannot be read the resolution falls back
  // to the environment and the default, and SAYS so rather than leaving the operator to
  // infer which file was touched.
  let vaultConfigFile: string | undefined
  let vaultConfigDir: string | undefined
  try {
    const cfgPath = resolveConfigPath()
    vaultConfigFile = loadConfig(new FileConfigProvider(cfgPath)).vaultFile
    vaultConfigDir = dirname(cfgPath)
  } catch (e) {
    // BOUND, so absent, malformed and unreadable are not one answer. "There is no
    // config" and "your config is broken" send the operator to different places, and
    // collapsing them is the defect #111 is about.
    process.stderr.write(
      `note: the config could not be read (${publicErrorMessage(e)}), so the vault path ` +
        `comes from the environment or the default. If your config names a vaultFile, this ` +
        `command is not using it.\n`,
    )
  }
  const vaultPath = resolveVaultPath(vaultConfigFile, vaultConfigDir)
  // Via envSecret, so a blank passphrase field arriving as `${user_config.vault_key}`
  // cannot become the key a vault is ENCRYPTED with — that vault could never be
  // reopened by anyone who did not know to type the template string (#40).
  const envKey = envSecret('MANYPORTALS_VAULT_KEY')

  if (action === 'encrypt') {
    const tokensPath = optionalEnvPath('MANYPORTALS_TOKENS_FILE') ?? defaultTokenFilePath()
    const tokens = readTokenFile(tokensPath)
    const keys = Object.keys(tokens)
    if (keys.length === 0) {
      process.stderr.write(
        `nothing to encrypt: no plaintext token file at ${tokensPath} (or it is empty)\n`,
      )
      process.exit(1)
    }
    // `encrypt` builds a vault FROM the plaintext token file, and it used to replace
    // an existing vault with no check and no confirmation. Because it is also the only
    // way to change the passphrase (#55), operators do run it over an existing vault:
    // a portal added later with `vault add` was then unrecoverable, and an older
    // plaintext token that had been rotated away was put back into service (#78).
    if (readVaultEnvelope(vaultPath) !== undefined) {
      process.stderr.write(
        [
          `a vault already exists at ${vaultPath} — refusing to replace it.`,
          `'vault encrypt' rebuilds the whole vault from ${tokensPath}, so any portal added`,
          `later with 'vault add' would be lost, and a token rotated away could come back.`,
          `  to add or rotate ONE portal:  vault add <portalKey>`,
          `  to remove one:                vault remove <portalKey>`,
          `  to rebuild from scratch:      move ${vaultPath} aside first, then run this again`,
        ].join('\n') + '\n',
      )
      process.exit(1)
    }
    let passphrase: string
    if (envKey !== undefined && envKey.trim() !== '') {
      passphrase = envKey
    } else {
      if (!process.stdin.isTTY) {
        process.stderr.write(
          'no terminal for the passphrase prompt — set MANYPORTALS_VAULT_KEY or run interactively\n',
        )
        process.exit(1)
      }
      passphrase = await promptHidden('vault passphrase (input hidden): ')
      const again = await promptHidden('confirm passphrase: ')
      if (passphrase !== again) {
        process.stderr.write('passphrases do not match — nothing written\n')
        process.exit(1)
      }
    }
    // Create the vault's folder first: on a fresh machine ~/.manyportals does not
    // exist yet, and the bare write failed with an unhelpful ENOENT. Owner-only,
    // because the folder holds credentials — mirrors src/store/jsonl-dir.ts.
    mkdirSync(dirname(vaultPath), { recursive: true, mode: 0o700 })
    // Write it the way `add` and `remove` do: temp file at 0600, fsync, compare, then
    // rename. The bare writeFileSync skipped all three. `mode` applies only on CREATE,
    // so re-encrypting over an existing 0666 vault left it 0666, and an in-place
    // truncate means a failure part-way leaves a vault with every token in it
    // unrecoverable. The expected-contents argument is `undefined` because a vault
    // must not exist here at all, which also catches one created concurrently (#78).
    writeVaultAtomically(vaultPath, encryptVaultTokens(tokens, passphrase), undefined)
    process.stdout.write(
      [
        `wrote encrypted vault: ${vaultPath} (${keys.length} token(s): ${keys.map(redactKey).join(', ')})`,
        // Hidden prompt, not an inline assignment: typing the passphrase on the
        // command line writes it into the shell history file. `read -rs` without
        // `-p` because -p is a bash-ism that fails in zsh ("no coprocess").
        `verify (hidden prompt — typing it inline would land in your shell history):`,
        `  printf 'passphrase: '; read -rs MP_KEY; echo`,
        `  MANYPORTALS_VAULT_KEY="$MP_KEY" manyportals-mcp vault status; unset MP_KEY`,
        `the plaintext file was NOT modified — delete ${tokensPath} yourself once verified`,
        `precedence at runtime: env vars, then the vault, then the plaintext file`,
      ].join('\n') + '\n',
    )
    process.exit(0)
  }

  if (action === 'status') {
    // Only a missing file is "no vault": an unreadable one (EACCES, EISDIR) fails loud,
    // as it does for add and remove, instead of being reported as absent.
    const text = readVaultEnvelope(vaultPath)
    if (text === undefined) {
      process.stdout.write(`no vault file at ${vaultPath}\n`)
      process.exit(1)
    }
    if (envKey === undefined || envKey.trim() === '') {
      process.stdout.write(
        `vault present at ${vaultPath}, but MANYPORTALS_VAULT_KEY is not set — vault INACTIVE\n`,
      )
      process.exit(1)
    }
    const tokens = decryptVaultTokens(text, envKey) // throws sanitized VaultError on wrong key
    const keys = Object.keys(tokens)
    process.stdout.write(`vault OK — ${keys.length} token(s): ${keys.map(redactKey).join(', ')}\n`)
    process.exit(0)
  }

  if (action === 'add') {
    const key = vaultPortalKeyOrExit(action, args)
    // The token is read ONLY at a hidden prompt — an argv or env value lands in shell
    // history and process listings. No terminal means no token, so refuse up front.
    if (!io.isTTY()) {
      process.stderr.write(
        'no terminal for the token prompt — vault add reads the token only from a hidden prompt; run it interactively\n',
      )
      process.exit(1)
    }
    const existing = readVaultEnvelope(vaultPath)
    const passphrase = await vaultPassphraseOrExit(envKey, existing === undefined, io)
    // Prove the passphrase BEFORE asking for the token, so a typo costs one prompt, not two.
    if (existing !== undefined) decryptVaultTokens(existing, passphrase)
    const token = await io.prompt(`token for ${key} (input hidden): `)
    const { envelope, replaced } = vaultWithToken(existing, passphrase, key, token)
    const change =
      existing === undefined
        ? `added ${key} to a new vault`
        : replaced
          ? `replaced ${key}`
          : `added ${key}`
    writeVaultAndReport(vaultPath, existing, envelope, passphrase, change, key, 'rotate')
  }

  if (action === 'remove') {
    const key = vaultPortalKeyOrExit(action, args)
    const existing = readVaultEnvelope(vaultPath)
    if (existing === undefined) {
      process.stderr.write(`no vault file at ${vaultPath} — nothing to remove\n`)
      process.exit(1)
    }
    const passphrase = await vaultPassphraseOrExit(envKey, false, io)
    const envelope = vaultWithoutToken(existing, passphrase, key) // throws before any write
    writeVaultAndReport(
      vaultPath,
      existing,
      envelope,
      passphrase,
      `removed ${key} from the vault`,
      key,
      'revoke',
    )
  }

  // The action is NOT echoed when it looks like a credential: `vault pat-na1-…` puts a
  // token in the action position, and interpolating it here would print it (review
  // 2026-09-27). Anything else is quoted, because seeing the typo is what helps.
  const shown =
    action === undefined ? '' : looksLikeCredential(action) ? '(value not shown)' : `"${action}"`
  process.stderr.write(
    `unknown vault action ${shown} — use: vault encrypt | vault status | vault add <portalKey> | vault remove <portalKey>\n`,
  )
  process.exit(1)
}

/**
 * Run only when this file is executed directly (e.g. `node dist/index.js [doctor]`
 * or the `manyportals-mcp` bin). Importing the module (tests, future tooling)
 * does NOT start the server. Failures exit non-zero with a sanitized message —
 * never silently (red-team P0).
 */
const invokedDirectly =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  if (process.argv[2] === 'doctor') {
    runDoctorCli()
  } else if (process.argv[2] === 'check-portals') {
    runPreflightCli().catch((e: unknown) => {
      // Sanitize too (P2.3): config/token-load failures surface as a safe message.
      process.stderr.write(`manyportals-mcp check-portals failed: ${publicErrorMessage(e)}\n`)
      process.exit(1)
    })
  } else if (process.argv[2] === 'vault') {
    runVaultCli(process.argv[3], process.argv.slice(4)).catch((e: unknown) => {
      // Sanitized: a wrong passphrase / malformed vault never leaks contents.
      process.stderr.write(`manyportals-mcp vault failed: ${publicErrorMessage(e)}\n`)
      process.exit(1)
    })
  } else {
    main().catch((e: unknown) => {
      // Sanitize the startup-failure message too (P2.3): only branded errors surface verbatim.
      process.stderr.write(`manyportals-mcp failed to start: ${publicErrorMessage(e)}\n`)
      process.exit(1)
    })
  }
}
