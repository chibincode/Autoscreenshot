import { describe, expect, it } from "vitest";
import { JobQueue } from "../src/server/queue.js";

describe("JobQueue", () => {
  it("runs jobs in FIFO order and emits status events", async () => {
    const queue = new JobQueue();
    const executed: string[] = [];
    const statusEvents: string[] = [];

    queue.events.on("job-event", (event) => {
      if (event.type === "status") {
        statusEvents.push(`${event.jobId}:${event.status}`);
      }
    });

    let resolveFirst: () => void = () => {
      // no-op until promise initializer runs
    };
    const firstDone = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    queue.enqueue("job-1", async () => {
      executed.push("job-1");
      await firstDone;
    });

    queue.enqueue("job-2", async () => {
      executed.push("job-2");
    });

    expect(queue.getStats().runningJobId).toBe("job-1");
    expect(queue.getStats().queued).toBe(1);

    resolveFirst();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(executed).toEqual(["job-1", "job-2"]);
    expect(statusEvents).toContain("job-1:queued");
    expect(statusEvents).toContain("job-1:running");
    expect(statusEvents).toContain("job-2:queued");
    expect(statusEvents).toContain("job-2:running");
  });
});
