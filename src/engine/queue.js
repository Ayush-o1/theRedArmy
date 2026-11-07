// A job queue built on the run_cases table.
//
// Why not BullMQ or another Redis queue? A run and its jobs must appear
// together. With a separate queue we would write the run to Postgres and then
// push jobs to Redis. If the process crashed between the two writes, we would
// get a run that never progresses (the "dual-write" problem). Because the jobs
// ARE rows in Postgres, createRun inserts both in one transaction.
//
// Every write below that finishes a job includes `locked_by = workerId AND
// status = 'RUNNING'`. That is a fencing check: if a slow worker's lease
// expired and another worker took the job, the slow worker's late result is
// discarded instead of overwriting the newer one.
import { prisma } from '../db.js';

/**
 * Claims up to `limit` jobs that are ready to run.
 *
 * FOR UPDATE SKIP LOCKED is what makes this safe with many workers: each
 * worker locks the rows it selects, and other workers skip locked rows instead
 * of waiting for them. No job is handed to two workers at the same time.
 */
export async function claimJobs(workerId, limit, leaseSeconds) {
  return prisma.$queryRaw`
    WITH next AS (
      SELECT rc.id
      FROM run_cases rc
      JOIN runs r ON r.id = rc.run_id
      WHERE rc.status = 'PENDING'
        AND rc.available_at <= now()
        AND r.status IN ('QUEUED', 'RUNNING')
      ORDER BY rc.available_at
      LIMIT ${limit}
      FOR UPDATE OF rc SKIP LOCKED
    )
    UPDATE run_cases rc
    SET status = 'RUNNING',
        locked_by = ${workerId},
        lease_expires_at = now() + ${leaseSeconds} * interval '1 second',
        attempts = rc.attempts + 1,
        started_at = COALESCE(rc.started_at, now())
    FROM next
    WHERE rc.id = next.id
    RETURNING rc.id, rc.run_id AS "runId", rc.attempts, rc.max_attempts AS "maxAttempts"`;
}

// QUEUED -> RUNNING the first time any of the run's jobs is claimed. The
// status condition makes this a no-op on every later call.
export async function markRunStarted(runId) {
  await prisma.$executeRaw`
    UPDATE runs SET status = 'RUNNING', started_at = now()
    WHERE id = ${runId}::uuid AND status = 'QUEUED'`;
}

/** Writes a terminal result. Returns false if this worker no longer owns the job. */
export async function completeJob(jobId, workerId, data) {
  const { count } = await prisma.runCase.updateMany({
    where: { id: jobId, lockedBy: workerId, status: 'RUNNING' },
    data: { ...data, lockedBy: null, leaseExpiresAt: null, finishedAt: new Date() },
  });
  return count === 1;
}

/**
 * Puts a job back in the queue to run after `delayMs`.
 * `countAttempt: false` is used when the job never reached the provider
 * (e.g. our own rate limiter said "wait"), so it does not use up a retry.
 */
export async function rescheduleJob(jobId, workerId, { delayMs, error = null, countAttempt = true }) {
  const { count } = await prisma.runCase.updateMany({
    where: { id: jobId, lockedBy: workerId, status: 'RUNNING' },
    data: {
      status: 'PENDING',
      lockedBy: null,
      leaseExpiresAt: null,
      availableAt: new Date(Date.now() + delayMs),
      ...(error ? { error } : {}),
      ...(countAttempt ? {} : { attempts: { decrement: 1 } }),
    },
  });
  return count === 1;
}

/**
 * Recovers jobs whose worker died (crash, kill -9, lost network) while holding
 * them. Each claim already counted an attempt, so a job that keeps crashing
 * its worker eventually gives up instead of looping forever.
 * Returns the ids of runs that had a job finish here, so they can be finalized.
 */
export async function reclaimExpiredLeases() {
  const rows = await prisma.$queryRaw`
    UPDATE run_cases
    SET status = CASE WHEN attempts >= max_attempts
                      THEN 'ERROR'::"RunCaseStatus" ELSE 'PENDING'::"RunCaseStatus" END,
        error = CASE WHEN attempts >= max_attempts
                     THEN 'Gave up: worker lease expired on the final attempt' ELSE error END,
        finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END,
        locked_by = NULL,
        lease_expires_at = NULL,
        available_at = now()
    WHERE status = 'RUNNING' AND lease_expires_at < now()
    RETURNING run_id AS "runId", status::text AS status`;
  return {
    reclaimed: rows.length,
    finishedRunIds: [...new Set(rows.filter((r) => r.status === 'ERROR').map((r) => r.runId))],
  };
}

/**
 * Writes the run's summary once every job is finished.
 *
 * Safe to call from many workers at once. The NOT EXISTS condition makes it a
 * no-op while any job is still pending or running. When two workers finish the
 * last two jobs together, the one that commits second always sees both results,
 * so the run never gets stuck. The UPDATE's row lock makes the first finalizer
 * win; for a late caller, the status condition no longer matches.
 * Cancelled runs keep their status, but their summary is refreshed as
 * in-flight jobs finish.
 */
export async function tryFinalizeRun(runId) {
  const updated = await prisma.$executeRaw`
    UPDATE runs r
    SET status = CASE WHEN r.status = 'CANCELLED' THEN r.status ELSE 'COMPLETED'::"RunStatus" END,
        finished_at = COALESCE(r.finished_at, now()),
        total_cases = s.total,
        passed_cases = s.passed,
        failed_cases = s.failed,
        errored_cases = s.errored,
        cached_cases = s.cached,
        input_tokens = s.input_tokens,
        output_tokens = s.output_tokens,
        cost_usd = s.cost_usd
    FROM (
      SELECT count(*)::int AS total,
             (count(*) FILTER (WHERE status = 'PASSED'))::int AS passed,
             (count(*) FILTER (WHERE status = 'FAILED'))::int AS failed,
             (count(*) FILTER (WHERE status = 'ERROR'))::int AS errored,
             (count(*) FILTER (WHERE cache_hit))::int AS cached,
             COALESCE(sum(input_tokens), 0)::int AS input_tokens,
             COALESCE(sum(output_tokens), 0)::int AS output_tokens,
             COALESCE(sum(cost_usd), 0)::float8 AS cost_usd
      FROM run_cases WHERE run_id = ${runId}::uuid
    ) s
    WHERE r.id = ${runId}::uuid
      AND r.status IN ('QUEUED', 'RUNNING', 'CANCELLED')
      AND NOT EXISTS (
        SELECT 1 FROM run_cases
        WHERE run_id = ${runId}::uuid AND status IN ('PENDING', 'RUNNING')
      )`;
  return updated === 1;
}
