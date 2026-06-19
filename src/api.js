export async function fetchQueues() {
  const res = await fetch('/api/queues');
  if (!res.ok) throw new Error('Failed to fetch queues');
  return res.json();
}

export async function fetchJobs() {
  const res = await fetch('/api/jobs');
  if (!res.ok) throw new Error('Failed to fetch jobs');
  return res.json();
}

export async function moveJob(uuid, queueName) {
  const res = await fetch(`/api/jobs/${uuid}/queue`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ queue_name: queueName }),
  });
  if (!res.ok) throw new Error('Failed to move job');
  return res.json();
}

export async function triggerSync() {
  const res = await fetch('/api/sync', { method: 'POST' });
  if (!res.ok) throw new Error('Sync failed');
  return res.json();
}

export function subscribeSSE(onEvent) {
  const es = new EventSource('/api/events');

  es.addEventListener('job_updated', (e) => {
    onEvent('job_updated', JSON.parse(e.data));
  });
  es.addEventListener('job_removed', (e) => {
    onEvent('job_removed', JSON.parse(e.data));
  });
  es.addEventListener('sync_complete', (e) => {
    onEvent('sync_complete', JSON.parse(e.data));
  });

  return () => es.close();
}
