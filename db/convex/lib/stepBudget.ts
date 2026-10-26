// StepBudget — the accounting behind every chained cleanup step.
//
// Convex runs a mutation as ONE transaction with two hard ceilings:
//
//   * operations: every document read, every write (insert/patch/delete) and
//     every ctx.scheduler / ctx.storage call is one operation. A transaction
//     that goes past the ceiling is aborted with "too many system operations",
//     and — because the cascade re-schedules itself — it is then retried
//     forever, which is exactly the failure this module exists to prevent.
//   * bytes read: a `.take(n)` pulls whole documents, and DFTStream's rows are
//     not small (an artifactChunk is ~512 KiB, a run inlines its whole ORCA
//     input, a geometry inlines an xyz block). A slice can therefore blow the
//     byte ceiling long before it blows the operation ceiling.
//
// A cleanup step opens a budget, asks it how many rows of a given table it can
// still afford before every `.take()`, and stops when the answer is 0 — leaving
// the rest for the next scheduled step. Sizes are therefore never guessed per
// table: one budget bounds the whole transaction no matter which mix of tables
// a step happens to touch.

/** Convex's per-transaction operation ceiling. */
export const TRANSACTION_OP_LIMIT = 4096;

/** Convex's per-transaction read ceiling. */
export const TRANSACTION_READ_BYTE_LIMIT = 8 * 1024 * 1024;

/**
 * Operations a single cleanup step may spend: 1536 of the 4096 available.
 *
 * The 2.6x headroom is deliberate. The estimates below are per-row upper
 * bounds, but a step also pays for things this class cannot see (the index
 * probe behind each `.take`, the scheduler call that continues the chain, the
 * read of the parent row). Sizing at the ceiling would mean a step that is
 * merely mis-estimated becomes a step that aborts.
 */
export const STEP_OP_BUDGET = 1536;

/** Bytes a single cleanup step may read: 4 MiB of the 8 MiB available, for the
 *  same reason — ROW_BYTES below are estimates, not measurements. */
export const STEP_BYTE_BUDGET = 4 * 1024 * 1024;

/** Deleting one row costs two operations: the read that found it and the
 *  delete itself. */
export const OPS_PER_ROW = 2;

/** ctx.storage.delete is a system operation against the file store rather than
 *  a document write; charged generously because it is not free and we cannot
 *  measure it from here. */
export const OPS_PER_STORAGE_DELETE = 8;

/**
 * Upper-bound size of one row of each table the cleanup touches. These bound
 * BYTES READ, so what matters is the largest a row can plausibly get, not its
 * average: an events payload or an artifact preview is usually tiny and
 * occasionally enormous.
 */
export const ROW_BYTES = {
  /** Chunked artifact bodies, split at ~512 KiB. The heaviest row we own. */
  artifactChunks: 512 * 1024,
  /** Artifact metadata + the inline head preview of the body. */
  artifacts: 256 * 1024,
  /** A run inlines its full ORCA input text. */
  runs: 64 * 1024,
  /** One optimization cycle's xyz block; scales with atom count. */
  geometries: 64 * 1024,
  /** Free-form payload / message. */
  events: 4 * 1024,
  logs: 4 * 1024,
  /** Fixed-width numeric rows. */
  metrics: 512,
  sysSamples: 512,
  frequencies: 512,
  excitedStates: 1024,
  nmrShields: 512,
  /** Rollup + index rows. */
  batchProgress: 2 * 1024,
  experimentProgress: 4 * 1024,
  batches: 2 * 1024,
  /** A pathway inlines its point array. */
  pathways: 16 * 1024,
} as const;

export type BudgetedTable = keyof typeof ROW_BYTES;

/**
 * StepBudget tracks what one transaction has spent.
 *
 * It is deliberately conservative in both directions: `rowsAffordable` never
 * returns more rows than the remaining budget can pay for, and every caller
 * charges for what it actually touched via `spendRows` / `spendOps`.
 */
export class StepBudget {
  private opsUsed = 0;
  private bytesUsed = 0;
  /** Rows deleted so far. A step that reschedules itself having deleted zero
   *  rows is not making progress — callers assert on this. */
  rowsDeleted = 0;

  constructor(
    private readonly opLimit: number = STEP_OP_BUDGET,
    private readonly byteLimit: number = STEP_BYTE_BUDGET,
  ) {}

  get opsLeft(): number {
    return Math.max(0, this.opLimit - this.opsUsed);
  }

  get bytesLeft(): number {
    return Math.max(0, this.byteLimit - this.bytesUsed);
  }

  /**
   * How many rows of `table` this step may still read-and-delete, capped at
   * `maxRows` (a per-table slice ceiling that keeps a single `.take` sane).
   * Zero means "stop and let the next scheduled step continue".
   */
  rowsAffordable(table: BudgetedTable, maxRows: number): number {
    const byOps = Math.floor(this.opsLeft / OPS_PER_ROW);
    const byBytes = Math.floor(this.bytesLeft / ROW_BYTES[table]);
    return Math.max(0, Math.min(maxRows, byOps, byBytes));
  }

  /** Charge for `count` rows that were read and deleted. */
  spendRows(table: BudgetedTable, count: number): void {
    this.opsUsed += count * OPS_PER_ROW;
    this.bytesUsed += count * ROW_BYTES[table];
    this.rowsDeleted += count;
  }

  /** Charge for rows that were only read (no delete), e.g. a parent lookup. */
  spendReads(table: BudgetedTable, count: number): void {
    this.opsUsed += count;
    this.bytesUsed += count * ROW_BYTES[table];
  }

  /** Charge for a non-document operation: an index probe, a scheduler call, a
   *  storage delete. */
  spendOps(count: number): void {
    this.opsUsed += count;
  }
}
