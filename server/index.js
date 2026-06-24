import { readFileSync } from 'fs';
import express from 'express';
import compression from 'compression';
import helmet from 'helmet';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Load .env
const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
try {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim();
  }
} catch {}

import { createSSEManager } from './sse.js';
import { createServiceM8Client } from './servicem8.js';
import { createSyncManager } from './sync.js';
import { createCache } from './cache.js';
import { buildSchedule } from './scheduler.js';
import { readFileSync as readF, writeFileSync as writeF } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const overridesPath = join(__dirname, '..', 'schedule-overrides.json');
let scheduleOverrides = {};
try { scheduleOverrides = JSON.parse(readF(overridesPath, 'utf-8')); } catch {}
function saveOverrides() { writeF(overridesPath, JSON.stringify(scheduleOverrides), 'utf-8'); }
const app = express();
const PORT = process.env.PORT || 3001;

app.use(compression());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());

const sse = createSSEManager();
const sm8 = createServiceM8Client(process.env.SERVICEM8_API_KEY);
const cache = createCache(join(__dirname, '..', 'kanban-cache.json'));
const sync = createSyncManager(sm8, cache, sse);

// --- SSE endpoint ---
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(':ok\n\n');

  const clientId = sse.addClient(res);
  req.on('close', () => sse.removeClient(clientId));
});

// --- API routes ---
app.get('/api/queues', (_req, res) => {
  res.json(cache.getQueues());
});

app.get('/api/jobs', (_req, res) => {
  res.json(cache.getJobs());
});

app.get('/api/jobs/:uuid', (req, res) => {
  const job = cache.getJob(req.params.uuid);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

app.patch('/api/jobs/:uuid/queue', async (req, res) => {
  const { queue_name } = req.body;
  if (!queue_name) return res.status(400).json({ error: 'queue_name required' });

  const queues = cache.getQueues();
  const queue = queues.find((q) => q.name === queue_name);
  if (!queue) return res.status(400).json({ error: 'Unknown queue' });

  try {
    await sm8.updateJob(req.params.uuid, {
      queue_uuid: queue.uuid,
      queue_expiry_date: '0000-00-00 00:00:00',
    });
    const updated = cache.moveJob(req.params.uuid, queue_name, queue.uuid);
    sse.broadcast('job_updated', updated);
    res.json(updated);
  } catch (err) {
    console.error('Failed to move job:', err.message);
    res.status(502).json({ error: 'ServiceM8 update failed' });
  }
});

app.post('/api/sync', async (_req, res) => {
  try {
    await sync.fullSync();
    res.json({ ok: true });
  } catch (err) {
    console.error('Sync failed:', err.message);
    res.status(502).json({ error: 'Sync failed' });
  }
});

app.get('/api/schedule', (_req, res) => {
  const jobs = cache.getJobs();
  res.json(buildSchedule(jobs, scheduleOverrides));
});

app.get('/api/schedule/overrides', (_req, res) => {
  res.json(scheduleOverrides);
});

app.patch('/api/schedule/:uuid', (req, res) => {
  const { uuid } = req.params;
  const { installDate } = req.body;
  if (!installDate) return res.status(400).json({ error: 'installDate required' });
  scheduleOverrides[uuid] = { installDate };
  saveOverrides();
  res.json({ ok: true });
});

app.delete('/api/schedule/:uuid', (req, res) => {
  const { uuid } = req.params;
  scheduleOverrides[uuid] = { removed: true };
  saveOverrides();
  res.json({ ok: true });
});

app.post('/api/schedule/:uuid/reschedule', (req, res) => {
  const { uuid } = req.params;
  const { approxDays } = req.body;
  if (!approxDays) return res.status(400).json({ error: 'approxDays required' });

  const jobs = cache.getJobs();
  const result = buildSchedule(jobs, scheduleOverrides);

  // Find the best day near the target
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(today);
  target.setDate(target.getDate() + approxDays);

  // Collect workdays in a ±4 day window around target
  const windowStart = new Date(target);
  windowStart.setDate(windowStart.getDate() - 4);
  const windowEnd = new Date(target);
  windowEnd.setDate(windowEnd.getDate() + 4);

  const job = jobs.find(j => j.uuid === uuid);
  const jobHours = result.scheduled.find(s => s.uuid === uuid)?.hours || 4;

  // Score each day: prefer less loaded days closer to target
  let bestDay = null;
  let bestScore = Infinity;

  for (const week of result.weeks) {
    for (const day of week.days) {
      if (!day.isWorkday) continue;
      const dayDate = new Date(day.date + 'T00:00:00');
      if (dayDate < windowStart || dayDate > windowEnd) continue;
      if (dayDate <= today) continue;

      const remainingCapacity = day.capacity - day.hoursUsed;
      if (remainingCapacity < jobHours) continue;

      const daysFromTarget = Math.abs(Math.round((dayDate - target) / (1000 * 60 * 60 * 24)));
      const loadPenalty = day.hoursUsed * 0.5;
      const score = daysFromTarget + loadPenalty;

      if (score < bestScore) { bestScore = score; bestDay = day.date; }
    }
  }

  // If nothing in window, find any future workday with capacity
  if (!bestDay) {
    for (const week of result.weeks) {
      for (const day of week.days) {
        if (!day.isWorkday) continue;
        const dayDate = new Date(day.date + 'T00:00:00');
        if (dayDate <= today) continue;
        if (day.capacity - day.hoursUsed < jobHours) continue;
        bestDay = day.date;
        break;
      }
      if (bestDay) break;
    }
  }

  if (!bestDay) return res.status(400).json({ error: 'No available day found' });

  scheduleOverrides[uuid] = { installDate: bestDay };
  saveOverrides();
  res.json({ ok: true, installDate: bestDay });
});

app.post('/api/schedule/reset', (_req, res) => {
  scheduleOverrides = {};
  saveOverrides();
  res.json({ ok: true });
});

app.post('/api/webhook', async (req, res) => {
  res.status(200).send('ok');
  const { entry } = req.body || {};
  if (!entry?.length) return;

  for (const e of entry) {
    if (e.changed_field !== 'edit' || !e.uuid) continue;
    try {
      const job = await sm8.fetchJob(e.uuid);
      if (!job || !['Quote', 'Work Order'].includes(job.status)) {
        cache.removeJob(e.uuid);
        sse.broadcast('job_removed', { uuid: e.uuid });
        continue;
      }
      const companyName = job.company_uuid
        ? await sm8.fetchCompanyName(job.company_uuid)
        : '';
      const queues = cache.getQueues();
      const queueMatch = queues.find((q) => q.uuid === job.queue_uuid);
      const enriched = {
        ...job,
        company_name: companyName,
        queue_name: queueMatch?.name || '',
      };
      cache.upsertJob(enriched);
      sse.broadcast('job_updated', enriched);
    } catch (err) {
      console.error('Webhook processing error:', err.message);
    }
  }
});

// --- Static serving ---
const publicPath = join(__dirname, '..', 'public');
app.use(express.static(publicPath));
app.get('*', (_req, res) => {
  res.sendFile(join(publicPath, 'index.html'));
});

// --- Start ---
app.listen(PORT, async () => {
  console.log(`Kanban server on port ${PORT}`);
  try {
    await sync.fullSync();
    console.log('Initial sync complete');
  } catch (err) {
    console.error('Initial sync failed:', err.message);
  }

  // Auto-sync every 5 minutes
  setInterval(async () => {
    try {
      await sync.fullSync();
      console.log('Auto-sync complete');
    } catch (err) {
      console.error('Auto-sync failed:', err.message);
    }
  }, 5 * 60 * 1000);
});
