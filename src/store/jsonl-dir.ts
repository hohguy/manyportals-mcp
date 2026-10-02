import {
  closeSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  writeSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, join } from 'node:path'
import { SafeError } from '../errors/index.js'

/**
 * A data folder shared by several server copies (#24). Each copy appends ONLY to
 * its own file and NEVER rewrites any file, so copies can run side by side without
 * the torn-tail-repair-vs-append race that the old single-instance lock existed to
 * prevent. Readers pick up the other copies' lines incrementally.
 *
 * Holds no secrets: callers persist only non-secret audit events and per-portal
 * record ids, never tokens.
 */

/** A writer file is `<UTC compact start time>-<8 hex>.jsonl` and nothing else. */
const WRITER_FILE = /^\d{8}T\d{6}Z-[0-9a-f]{8}\.jsonl$/
const NEWLINE = 0x0a

/**
 * Is this directory entry one of the per-copy trail files? Everything else in the
 * folder — a cloud-sync "conflicted copy", an editor backup, `.DS_Store` — belongs
 * to someone else and must not be read, counted or reported on.
 */
export function isWriterFile(name: string): boolean {
  return WRITER_FILE.test(name)
}

/** `writeSync`, narrowed to the shape this module uses (injectable in tests). */
type WriteFn = (fd: number, buffer: Buffer, offset: number, length: number) => number

/**
 * Id for THIS process's file: sorts by start time and is unique in practice. The
 * clock and the random suffix are injectable so tests can pin both. A live process
 * must never reuse another's id — its own file is the one file it does not read
 * back — so the first append creates the file exclusively and fails loud if the id
 * is already taken.
 */
export function newWriterId(now: Date = new Date(), suffix?: string): string {
  const [date, time] = now.toISOString().split('T') as [string, string]
  const stamp = `${date.replace(/-/g, '')}T${time.slice(0, 8).replace(/:/g, '')}Z`
  return `${stamp}-${suffix ?? randomBytes(4).toString('hex')}`
}

/**
 * Write the WHOLE buffer, looping over short writes: `writeSync` may report fewer
 * bytes than asked for, and stopping there would leave a truncated line. It cannot
 * prevent a write that fails PART-WAY (a short write, then `ENOSPC`) — that leaves
 * a prefix on disk, which is why the caller marks the file broken and refuses to
 * append again.
 */
export function writeAllSync(fd: number, buffer: Buffer, write: WriteFn = writeSync): void {
  let written = 0
  while (written < buffer.length) {
    const n = write(fd, buffer, written, buffer.length - written)
    if (n <= 0) throw new SafeError('JSONL store: the file system accepted no bytes on write')
    written += n
  }
}

/** One complete line, tagged with the file it came from so an error can name it. */
export interface StoredLine {
  file: string
  text: string
}

/**
 * Parse lines that are known to be COMPLETE (the store withholds a partial line
 * until its newline arrives), so ANY unparseable line is real corruption rather
 * than a torn write: fail loud instead of silently dropping history. The error
 * names the FILE — something an operator can open — never the content.
 */
export function parseJsonlStrict(lines: readonly StoredLine[]): unknown[] {
  const records: unknown[] = []
  for (const line of lines) {
    try {
      records.push(JSON.parse(line.text))
    } catch {
      throw new SafeError(`corrupt JSONL store: unparseable line in ${line.file}`)
    }
  }
  return records
}

export interface MergedLines {
  /** Complete lines not returned before: the legacy file first, then writer files by name. */
  lines: StoredLine[]
  /** Files that currently end mid-line — a crash mid-append, or a live write in progress. */
  tornTails: string[]
  /** Names ignored because they are not writer files (sync conflicts, backups, `.DS_Store`). */
  ignored: string[]
}

/** The append/read surface the audit log and the id-index need (injectable for tests). */
export interface MergedStore {
  /** This copy's writer id — stamped on the records it appends. */
  readonly writer: string
  readNew(): MergedLines
  appendLine(line: string): void
}

/** A directory of per-writer JSONL files, plus the legacy single-writer file. */
export class JsonlDir implements MergedStore {
  private readonly consumed = new Map<string, number>()
  private readonly ownFile: string
  private created = false
  private broken = false

  constructor(
    private readonly dir: string,
    readonly writer: string,
    private readonly legacyPath?: string,
    /** Injectable so a test can make a write fail part-way through a line. */
    private readonly write: WriteFn = writeSync,
  ) {
    this.ownFile = `${writer}.jsonl`
  }

  /**
   * Every COMPLETE line not returned before. The first call returns the whole
   * history (the legacy file first), later calls only what other copies appended
   * since. A line another copy is still writing is withheld until its newline
   * arrives, so a reader never parses half a record. This copy's OWN file is never
   * read back — the caller already holds those lines in memory.
   */
  readNew(): MergedLines {
    const out: MergedLines = { lines: [], tornTails: [], ignored: [] }
    // Offsets are held PENDING and committed only once every file has been read.
    // readInto used to advance `consumed` per file, so a throw out of a LATER file
    // discarded the whole batch while the earlier files' offsets stayed advanced:
    // those lines were never delivered and could never be re-read by this process.
    // The cross-portal guard then reported an id as unknown and recovered SILENTLY,
    // and peer audit events vanished from the log while still being on disk (#82).
    const pending = new Map<string, number>()
    if (this.legacyPath !== undefined) {
      this.readInto(this.legacyPath, basename(this.legacyPath), out, pending)
    }
    for (const name of this.writerFiles(out)) {
      this.readInto(join(this.dir, name), name, out, pending)
    }
    for (const [key, offset] of pending) this.consumed.set(key, offset)
    return out
  }

  /** Append one line to THIS copy's file, created (owner-only) on first append. */
  appendLine(line: string): void {
    // An earlier append failed part-way, so this file may end mid-line. Appending
    // again would land this record on that prefix and turn it into a COMPLETE,
    // unparseable line — corruption every other copy then fails on, and which
    // survives every restart. Refuse instead: a restart starts a fresh file, and
    // readers drop an unfinished last line on their own.
    if (this.broken) {
      throw new SafeError(
        "JSONL store: an earlier append to this copy's trail file failed part-way, so it may end mid-line; restart the server to start a fresh file",
      )
    }
    // `mode` applies only at creation and is masked by umask; POSIX-only in
    // effect (Windows uses ACLs).
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const fd = this.openOwnFile()
    this.created = true
    try {
      // Durably persist BEFORE returning (RT-03/04): the write-ahead audit
      // `attempt` and the id-index must survive a crash right after the call.
      writeAllSync(fd, Buffer.from(`${line}\n`), this.write)
      fsyncSync(fd)
    } catch (e) {
      this.broken = true
      throw e
    } finally {
      closeSync(fd)
    }
  }

  /**
   * The first append creates the file exclusively: two live copies must never
   * share a writer id, because each skips its own file when reading, so they would
   * both append to one file and neither would ever see the other's lines.
   */
  private openOwnFile(): number {
    const path = join(this.dir, this.ownFile)
    try {
      return openSync(path, this.created ? 'a' : 'ax', 0o600)
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'EEXIST') {
        throw new SafeError(
          `JSONL store: ${this.ownFile} already exists — another copy is using this writer id; restart to get a new one`,
        )
      }
      throw e
    }
  }

  /**
   * Writer files, oldest first. Anything else in the folder is IGNORED, never
   * parsed: a cloud-sync "conflicted copy", an editor backup or `.DS_Store` would
   * otherwise read as corruption and, because corruption fails closed, deny every
   * write.
   */
  private writerFiles(out: MergedLines): string[] {
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') return [] // no copy has appended yet
      throw new SafeError(`cannot read JSONL store dir ${this.dir} (${code ?? 'read error'})`)
    }
    const files: string[] = []
    for (const name of names.sort()) {
      if (name === this.ownFile) continue
      if (isWriterFile(name)) files.push(name)
      else out.ignored.push(name)
    }
    return files
  }

  private readInto(
    path: string,
    key: string,
    out: MergedLines,
    pending: Map<string, number>,
  ): void {
    const from = this.consumed.get(key) ?? 0
    let fd: number
    try {
      fd = openSync(path, 'r')
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code
      // An absent legacy file is the normal "no history yet" case, and a writer file
      // can vanish between readdir and open. Any OTHER failure must fail LOUD.
      if (code === 'ENOENT') return
      throw new SafeError(`cannot read JSONL store at ${path} (${code ?? 'read error'})`)
    }
    try {
      const stat = fstatSync(fd)
      // A directory where a trail file is expected must fail loud, not read as
      // empty. POSIX reports a non-zero size for one and Windows reports 0, so
      // without this the same mistake throws on one system and passes silently on
      // the other (caught by the Windows CI runner).
      if (stat.isDirectory()) throw new SafeError(`cannot read JSONL store at ${path} (EISDIR)`)
      // Trail files are append-only, so a file that SHRANK was truncated or
      // replaced behind us. Skipping it would silently drop the rest of that trail.
      if (stat.size < from) {
        throw new SafeError(`JSONL store at ${path} shrank — it was truncated or replaced`)
      }
      if (stat.size === from) return
      const buf = Buffer.allocUnsafe(stat.size - from)
      let read = 0
      while (read < buf.length) {
        const n = readSync(fd, buf, read, buf.length - read, from + read)
        if (n === 0) break
        read += n
      }
      const chunk = buf.subarray(0, read)
      // Consume only up to the last newline: the bytes after it are a line still
      // being written (or a crash's torn tail). A newline byte can never be part of
      // a multi-byte UTF-8 character, so cutting there is safe.
      const end = chunk.lastIndexOf(NEWLINE) + 1
      if (end < chunk.length) out.tornTails.push(key)
      if (end === 0) return
      pending.set(key, from + end)
      for (const text of chunk.subarray(0, end).toString('utf8').split('\n')) {
        if (text !== '') out.lines.push({ file: key, text })
      }
    } catch (e) {
      if (e instanceof SafeError) throw e
      const code = (e as NodeJS.ErrnoException)?.code
      throw new SafeError(`cannot read JSONL store at ${path} (${code ?? 'read error'})`)
    } finally {
      closeSync(fd)
    }
  }
}
