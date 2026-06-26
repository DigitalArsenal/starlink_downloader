/**
 * Live terminal progress UI for `refresh`.
 *
 * On a TTY it renders one cli-progress bar per source plus an aggregate TOTAL
 * bar (files done/remaining/total, %, throughput, ETA, and ✓/⤳/✗ tallies). When
 * stdout is not a TTY (CI, pipes) or `--no-progress`/`--json` is set, it falls
 * back to periodic structured log lines driven by the same event stream.
 */
import cliProgress from 'cli-progress';
import type { ProgressEmitter } from '../events.js';
import { logger } from '../logger.js';

interface SourceState {
  total: number;
  done: number;
  stored: number;
  skipped: number;
  failed: number;
  bytes: number;
}

const fmtMB = (bytes: number): string => (bytes / 1_048_576).toFixed(1);

export class ProgressUI {
  private readonly states = new Map<string, SourceState>();
  private multibar: cliProgress.MultiBar | null = null;
  private readonly bars = new Map<string, cliProgress.SingleBar>();
  private totalBar: cliProgress.SingleBar | null = null;
  private readonly unsubscribers: Array<() => void> = [];

  constructor(
    private readonly events: ProgressEmitter,
    private readonly useBars: boolean,
  ) {}

  private barFormat(label: string): string {
    return `${label.padEnd(18)} |{bar}| {percentage}% | {value}/{total} | ✓{stored} ⤳{skipped} ✗{failed} | {mb} MB`;
  }

  private aggregate(): SourceState {
    const agg: SourceState = { total: 0, done: 0, stored: 0, skipped: 0, failed: 0, bytes: 0 };
    for (const s of this.states.values()) {
      agg.total += s.total;
      agg.done += s.done;
      agg.stored += s.stored;
      agg.skipped += s.skipped;
      agg.failed += s.failed;
      agg.bytes += s.bytes;
    }
    return agg;
  }

  private refreshTotal(): void {
    if (!this.totalBar) return;
    const agg = this.aggregate();
    this.totalBar.setTotal(agg.total);
    this.totalBar.update(agg.done, {
      stored: agg.stored,
      skipped: agg.skipped,
      failed: agg.failed,
      mb: fmtMB(agg.bytes),
    });
  }

  attach(): void {
    if (this.useBars) {
      this.multibar = new cliProgress.MultiBar(
        { clearOnComplete: false, hideCursor: true, autopadding: true, etaBuffer: 64 },
        cliProgress.Presets.shades_classic,
      );
      this.totalBar = this.multibar.create(
        0,
        0,
        { stored: 0, skipped: 0, failed: 0, mb: '0.0' },
        { format: this.barFormat('TOTAL') },
      );
    }

    this.unsubscribers.push(
      this.events.on('source:start', ({ source, total }) => {
        this.states.set(source, { total, done: 0, stored: 0, skipped: 0, failed: 0, bytes: 0 });
        if (this.multibar) {
          const bar = this.multibar.create(
            total,
            0,
            { stored: 0, skipped: 0, failed: 0, mb: '0.0' },
            { format: this.barFormat(source) },
          );
          this.bars.set(source, bar);
          this.refreshTotal();
        } else {
          logger.info({ source, total }, 'source discovered');
        }
      }),
    );

    this.unsubscribers.push(
      this.events.on('source:progress', (p) => {
        this.states.set(p.source, {
          total: p.total,
          done: p.done,
          stored: p.stored,
          skipped: p.skipped,
          failed: p.failed,
          bytes: p.bytes,
        });
        const bar = this.bars.get(p.source);
        if (bar) {
          bar.setTotal(p.total);
          bar.update(p.done, {
            stored: p.stored,
            skipped: p.skipped,
            failed: p.failed,
            mb: fmtMB(p.bytes),
          });
          this.refreshTotal();
        } else if (p.done % 50 === 0 || p.done === p.total) {
          logger.info(
            { source: p.source, done: p.done, total: p.total, stored: p.stored, skipped: p.skipped, failed: p.failed },
            'progress',
          );
        }
      }),
    );

    this.unsubscribers.push(
      this.events.on('source:finish', ({ result }) => {
        if (!this.multibar) {
          logger.info({ ...result }, 'source finished');
        }
      }),
    );
  }

  stop(): void {
    for (const u of this.unsubscribers) u();
    this.unsubscribers.length = 0;
    if (this.multibar) {
      this.multibar.stop();
      this.multibar = null;
    }
  }
}
