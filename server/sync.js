const VALID_STATUSES = new Set(['Quote', 'Work Order']);

export function createSyncManager(sm8, cache, sse) {
  let syncing = false;

  async function fullSync() {
    if (syncing) return;
    syncing = true;

    try {
      const [allJobs, queues, companies, allMaterials] = await Promise.all([
        sm8.fetchAllJobs(),
        sm8.fetchAllQueues(),
        sm8.fetchAllCompanies(),
        sm8.fetchAllJobMaterials(),
      ]);

      const companyMap = new Map();
      for (const c of companies) {
        companyMap.set(c.uuid, c.name || '');
      }

      const queueMap = new Map();
      for (const q of queues) {
        queueMap.set(q.uuid, q.name);
      }

      // Group materials by job_uuid
      const materialsMap = new Map();
      for (const m of allMaterials) {
        if (!m.job_uuid) continue;
        if (!materialsMap.has(m.job_uuid)) materialsMap.set(m.job_uuid, []);
        materialsMap.get(m.job_uuid).push({
          name: m.name || '',
          quantity: parseFloat(m.quantity) || 0,
          edit_date: m.edit_date || '',
        });
      }

      const jobs = allJobs
        .filter((j) => VALID_STATUSES.has(j.status))
        .map((j) => ({
          ...j,
          company_name: companyMap.get(j.company_uuid) || '',
          queue_name: queueMap.get(j.queue_uuid) || '',
          materials: materialsMap.get(j.uuid) || [],
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
