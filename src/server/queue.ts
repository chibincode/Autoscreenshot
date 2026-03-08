import { EventEmitter } from "node:events";
import type { JobEvent, QueueStats } from "../types.js";

type QueueTask = {
  jobId: string;
  run: () => Promise<void>;
};

export type CancelJobResult = "queued_cancelled" | "running_cancel_requested" | "not_found";

export class JobQueue {
  private readonly queue: QueueTask[] = [];
  private runningJobId: string | null = null;
  private readonly cancellationRequests = new Set<string>();
  readonly events = new EventEmitter();

  enqueue(jobId: string, run: () => Promise<void>): void {
    this.queue.push({ jobId, run });
    this.emit({
      type: "status",
      jobId,
      status: "queued",
      at: new Date().toISOString(),
      message: "Job queued",
    });
    void this.process();
  }

  getStats(): QueueStats {
    return {
      queued: this.queue.length,
      runningJobId: this.runningJobId,
    };
  }

  emit(event: JobEvent): void {
    this.events.emit("job-event", event);
  }

  cancel(jobId: string): CancelJobResult {
    if (this.runningJobId === jobId) {
      this.cancellationRequests.add(jobId);
      return "running_cancel_requested";
    }

    const queuedIndex = this.queue.findIndex((task) => task.jobId === jobId);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      return "queued_cancelled";
    }

    return "not_found";
  }

  isCancellationRequested(jobId: string): boolean {
    return this.cancellationRequests.has(jobId);
  }

  private async process(): Promise<void> {
    if (this.runningJobId !== null) {
      return;
    }
    const next = this.queue.shift();
    if (!next) {
      return;
    }

    this.runningJobId = next.jobId;
    this.emit({
      type: "status",
      jobId: next.jobId,
      status: "running",
      at: new Date().toISOString(),
      message: "Job started",
    });
    try {
      await next.run();
    } finally {
      this.cancellationRequests.delete(next.jobId);
      this.runningJobId = null;
      void this.process();
    }
  }
}
