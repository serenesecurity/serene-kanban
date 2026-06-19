const VALID_STATUSES = new Set(['Quote', 'Work Order']);

export function createSyncManager(sm8, cache, sse) {
  let syncing = false;

  async function fullSync() {
    if (syncing) return;
    syncing = true;

    try {
      const [allJobs, queues, companies] = await Promise.all([
        sm8.fetchAllJobs(),
        sm8.fetchAllQueues(),
        sm8.fetchAllCompanies(),
      ]);

      const companyMap = new Map();
      for (const c of companies) {
        companyMap.set(c.uuid, c.name || '');
      }

      const queueMap = new Map();
      for (const q of queues) {
        queueMap.set(q.uuid, q.name);
      }

      const jobs = allJobs
        .filter((j) => VALID_STATUSES.has(j.status))
        .map((j) => ({
          ...j,
          company_name: companyMap.get(j.company_uuid) || '',
          queue_name: queueMap.get(j.queue_uuid) || '',
        }));

      const orderedQueues = queues
        .sort((a, b) => (a.sort_order ?? 999) - (b.sort_order ?? 999))
        .map((q) => ({ uuid: q.uuid, name: q.name }));

      cache.save({ jobs, queues: orderedQueues });
      sse.broadcast('sync_complete', { jobCount: jobs.length });
    } finally {
      syncing = false;
    }
  }

  return { fullSync };
}
