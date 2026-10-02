import type { MergedLines, MergedStore } from './jsonl-dir.js'

/**
 * A data folder shared by several server copies, in memory (#24). Each copy gets
 * its own view: appends land in the shared list, and a copy never reads its own
 * lines back — the same contract as `JsonlDir`, which is what makes a test with
 * two of these a fair model of two processes.
 *
 * Shared by the audit-log and id-index tests, which otherwise each carried a copy.
 */
export class FakeFolder {
  readonly lines: { writer: string; text: string }[] = []
  tornTails: string[] = []
  ignored: string[] = []
  /** Set to make every later `readNew()` throw, as an unreadable file would. */
  readError?: Error

  storeFor(writer: string): MergedStore {
    let consumed = 0
    return {
      writer,
      readNew: (): MergedLines => {
        if (this.readError) throw this.readError
        const lines = this.lines
          .slice(consumed)
          .filter((l) => l.writer !== writer)
          .map((l) => ({ file: `${l.writer}.jsonl`, text: l.text }))
        consumed = this.lines.length
        return { lines, tornTails: [...this.tornTails], ignored: [...this.ignored] }
      },
      appendLine: (text: string): void => {
        this.lines.push({ writer, text })
      },
    }
  }

  /** A record another copy already wrote. */
  add(writer: string, record: unknown): void {
    this.lines.push({ writer, text: JSON.stringify(record) })
  }

  /** A raw line another copy left behind — for corruption cases. */
  addRaw(writer: string, text: string): void {
    this.lines.push({ writer, text })
  }
}
