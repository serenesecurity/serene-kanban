import { readFileSync, writeFileSync } from 'fs';

export function createCache(filePath) {
  let data = { jobs: [], queues: [] };

  try {
    data = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    // No cache yet
  }

  function persist() {
    writeFileSync(filePath, JSON.stringify(data), 'utf-8');
  }

  return {
    save(newData) {
      data = newData;
      persist();
    },
    getJobs() {
      return data.jobs;
    },
    getJob(uuid) {
      return data.jobs.find((j) => j.uuid === uuid);
    },
    getQueues() {
      return data.queues;
    },
    moveJob(uuid, queueName, queueUuid) {
      const job = data.jobs.find((j) => j.uuid === uuid);
      if (job) {
        job.queue_name = queueName;
        job.queue_uuid = queueUuid;
        persist();
      }
      return job;
    },
    upsertJob(job) {
      const idx = data.jobs.findIndex((j) => j.uuid === job.uuid);
      if (idx >= 0) data.jobs[idx] = job;
      else data.jobs.push(job);
      persist();
    },
    removeJob(uuid) {
      data.jobs = data.jobs.filter((j) => j.uuid !== uuid);
      persist();
    },
  };
}
