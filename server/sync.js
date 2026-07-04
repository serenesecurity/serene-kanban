const VALID_STATUSES = new Set(['Quote', 'Work Order']);

export function createSyncManager(sm8, cache, sse) {
  let syncing = false;

  async function fullSync() {
    if (syncing) return;
    syncing = true;

    try {
      const [allJobs, queues, companies, allMaterials, allChecklists] = await Promise.all([
        sm8.fetchAllJobs(),
        sm8.fetchAllQueues(),
        sm8.fetchAllCompanies(),
        sm8.fetchAllJobMaterials(),
        sm8.fetchAllJobChecklists(),
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
        if (String(m.active) === '0') continue;
        if (!materialsMap.has(m.job_uuid)) materialsMap.set(m.job_uuid, []);
        materialsMap.get(m.job_uuid).push({
          name: m.name || '',
          quantity: parseFloat(m.quantity) || 0,
          edit_date: m.edit_date || '',
        });
      }

      // Extract "Order Form Sent" completion dates per job
      const orderFormMap = new Map();
      for (const cl of allChecklists) {
        if (!cl.job_uuid) continue;
        const name = (cl.name || '').toLowerCase();
        if (!name.startsWith('order form sent')) continue;
        const ts = cl.completed_timestamp;
        if (!ts || ts.startsWith('0000')) continue;
        const existing = orderFormMap.get(cl.job_uuid);
        if (!existing || ts > existing) orderFormMap.set(cl.job_uuid, ts);
      }

      // Build suffix amount map: base job number → sum of suffix job amounts (e.g. 1369A → added to 1369)
      const suffixAmountMap = new Map();
      for (const j of allJobs) {
        const id = j.generated_job_id || '';
        if (/^\d+[A-Za-z]+$/.test(id)) {
          const base = id.replace(/[A-Za-z]+$/, '');
          const amt = parseFloat(j.total_invoice_amount || 0);
          suffixAmountMap.set(base, (suffixAmountMap.get(base) || 0) + amt);
        }
      }

      const jobs = allJobs
        .filter((j) => VALID_STATUSES.has(j.status))
        .map((j) => {
          const suffixAmt = suffixAmountMap.get(j.generated_job_id || '') || 0;
          return {
            ...j,
            company_name: companyMap.get(j.company_uuid) || '',
            queue_name: queueMap.get(j.queue_uuid) || '',
            materials: materialsMap.get(j.uuid) || [],
            order_form_sent_date: orderFormMap.get(j.uuid) || null,
            total_invoice_amount_combined: parseFloat(j.total_invoice_amount || 0) + suffixAmt,
          };
        });

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
