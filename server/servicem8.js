const BASE = 'https://api.servicem8.com/api_1.0';

export function createServiceM8Client(apiKey) {
  async function request(path, options = {}) {
    const res = await fetch(`${BASE}${path}`, {
      ...options,
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`SM8 ${res.status}: ${path} — ${body}`);
    }
    return res.json();
  }

  return {
    fetchAllJobs() {
      return request('/job.json');
    },
    fetchJob(uuid) {
      return request(`/job/${uuid}.json`);
    },
    fetchAllQueues() {
      return request('/jobqueue.json');
    },
    fetchAllCompanies() {
      return request('/company.json');
    },
    fetchCompanyName(uuid) {
      return request(`/company/${uuid}.json`).then((c) => c.name || '');
    },
    fetchAllJobMaterials() {
      return request('/jobmaterial.json');
    },
    updateJob(uuid, data) {
      return request(`/job/${uuid}.json`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
  };
}
