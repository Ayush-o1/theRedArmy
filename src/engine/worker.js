// The worker loop: poll for jobs, run up to `concurrency` at once, and
// periodically reclaim jobs abandoned by crashed workers.
//
// Polling every second is simple and good enough for a testing tool, where a
// one-second delay before a run starts is not noticeable. Postgres
// LISTEN/NOTIFY could remove the delay; see docs/decisions.md.
import os from 'node:os';
import crypto from 'node:crypto';
import { logger } from '../lib/logger.js';
import { claimJobs, reclaimExpiredLeases, tryFinalizeRun } from './queue.js';
import { processJob } from './processJob.js';

export class Worker {
  constructor({ concurrency = 4, leaseSeconds = 60, pollIntervalMs = 1000, reaperIntervalMs = 15_000 } = {}) {
    this.id = `${os.hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
    this.concurrency = concurrency;
    this.leaseSeconds = leaseSeconds;
    this.pollIntervalMs = pollIntervalMs;
    this.reaperIntervalMs = reaperIntervalMs;
    this.inFlight = new Set();
    this.running = false;
    this.log = logger.child({ workerId: this.id });
  }

  start() {
    this.running = true;
    this.log.info({ concurrency: this.concurrency }, 'worker started');
    this.pollTimer = this.#schedulePoll(0);
    this.reaperTimer = setInterval(
      () => this.reap().catch((err) => this.log.error({ err }, 'reaper failed')),
      this.reaperIntervalMs,
    );
  }

  // Stop claiming new jobs and wait for in-flight ones, so a deploy does not
  // leave jobs half-done. If we are killed before they finish, the lease
  // expires and the reaper on another worker recovers them.
  async stop() {
    this.running = false;
    clearTimeout(this.pollTimer);
    clearInterval(this.reaperTimer);
    await Promise.allSettled([...this.inFlight]);
    this.log.info('worker stopped');
  }

  #schedulePoll(delay) {
    return setTimeout(() => this.#poll(), delay);
  }

  async #poll() {
    if (!this.running) return;
    let claimedAny = false;
    try {
      claimedAny = (await this.tick()) > 0;
    } catch (err) {
      this.log.error({ err }, 'poll failed');
    }
    // If we found work there may be more, so poll again immediately.
    if (this.running) this.pollTimer = this.#schedulePoll(claimedAny ? 0 : this.pollIntervalMs);
  }

  /** Claims and starts as many jobs as there are free slots. Returns the count. */
  async tick() {
    const free = this.concurrency - this.inFlight.size;
    if (free <= 0) return 0;
    const jobs = await claimJobs(this.id, free, this.leaseSeconds);
    for (const job of jobs) {
      const task = processJob(job, { workerId: this.id, log: this.log })
        .catch((err) =>
          this.log.error({ err, jobId: job.id }, 'job crashed; lease will expire and it will be retried'),
        )
        .finally(() => this.inFlight.delete(task));
      this.inFlight.add(task);
    }
    return jobs.length;
  }

  /** Waits for every job started so far. Used by tests. */
  async drain() {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  async reap() {
    const { reclaimed, finishedRunIds } = await reclaimExpiredLeases();
    if (reclaimed > 0) this.log.warn({ reclaimed }, 'reclaimed jobs with expired leases');
    for (const runId of finishedRunIds) await tryFinalizeRun(runId);
  }
}
