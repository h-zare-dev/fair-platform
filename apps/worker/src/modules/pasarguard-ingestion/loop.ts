import { setTimeout } from 'node:timers/promises';

export interface PendingBatchProcessor {
  processNext(): Promise<boolean>;
}
export class IngestionLoop {
  private readonly abort = new AbortController();
  private running: Promise<void> | undefined;
  constructor(
    private readonly processor: PendingBatchProcessor,
    private readonly intervalMs: number,
    private readonly reportFailure: () => void = () => {},
  ) {}
  start(): void {
    this.running ??= this.run();
  }
  async stop(): Promise<void> {
    this.abort.abort();
    await this.running;
  }
  private async run(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        await this.processor.processNext();
      } catch {
        this.reportFailure();
      }
      if (this.abort.signal.aborted) break;
      try {
        await setTimeout(this.intervalMs, undefined, {
          signal: this.abort.signal,
        });
      } catch {
        /* Shutdown interrupts polling only; active transactions are awaited. */
      }
    }
  }
}
