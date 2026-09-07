import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
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

const dataDir = process.env.DATA_DIR || join(__dirname, '..');
const overridesPath = join(dataDir, 'schedule-overrides.json');
let scheduleOverrides = {};
try { scheduleOverrides = JSON.parse(readF(overridesPath, 'utf-8')); } catch {}
function saveOverrides() { writeF(overridesPath, JSON.stringify(scheduleOverrides), 'utf-8'); }

const ordersPath = join(dataDir, 'orders.json');
let ordersData = { items: [] };
try { ordersData = JSON.parse(readF(ordersPath, 'utf-8')); } catch {}
function saveOrders() { writeF(ordersPath, JSON.stringify(ordersData), 'utf-8'); }
const app = express();
const PORT = process.env.PORT || 3001;

app.use(compression());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());

const sse = createSSEManager();
const sm8 = createServiceM8Client(process.env.SERVICEM8_API_KEY);
const cache = createCache(join(dataDir, 'kanban-cache.json'));
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

app.get('/api/scheduler', (_req, res) => {
  const jobs = cache.getJobs();
  // Use Brisbane date (UTC+10) so morning orders don't show negative days
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Brisbane' }); // "YYYY-MM-DD"

  // All WO jobs
  const items = jobs
    .filter(j => {
      if (j.status !== 'Work Order') return false;
      if (!j.generated_job_id || j.generated_job_id === 'SAMPLE') return false;
      return true;
    })
    .map(j => {
      const hasOrderForm = !!j.order_form_sent_date;
      // SM8 timestamps are Brisbane local time — compare date strings to avoid UTC offset errors
      const sentDateStr = hasOrderForm ? j.order_form_sent_date.slice(0, 10) : null;
      const daysSinceSent = sentDateStr
        ? Math.round((new Date(todayStr) - new Date(sentDateStr)) / (1000 * 60 * 60 * 24))
        : null;
      // Ready window: 18-25 days (2.5-3.5 weeks)
      const readyWindowStart = 18;
      const readyWindowEnd = 25;
      const hasBooking = j.job_is_scheduled_until_stamp && !j.job_is_scheduled_until_stamp.startsWith('0000');
      const bookedDate = hasBooking ? j.job_is_scheduled_until_stamp.slice(0, 10) : null;
      const isBooked = hasBooking && bookedDate >= todayStr && sentDateStr && bookedDate >= sentDateStr;
      const hasPartialInvoice = (j.materials || []).some(
        m => /^partial\s*invoice\s*#.*[A-Za-z]$/i.test(m.name)
      );
      const hasPayment = j.payment_date && !j.payment_date.startsWith('0000');

      return {
        uuid: j.uuid,
        jobId: j.generated_job_id,
        client: j.company_name || 'Unknown',
        address: j.job_address || '',
        suburb: j.geo_city || '',
        queue: j.queue_name || '',
        hasOrderForm,
        orderFormSentDate: sentDateStr,
        daysSinceSent,
        readyWindowStart,
        readyWindowEnd,
        hasDeposit: hasPartialInvoice || hasPayment,
        isBooked,
        bookedDate,
        amount: parseFloat(j.total_invoice_amount_combined ?? j.total_invoice_amount ?? 0),
      };
    })
    .sort((a, b) => (b.daysSinceSent ?? -1) - (a.daysSinceSent ?? -1));

  res.json({ items });
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

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(today);
  target.setDate(target.getDate() + approxDays);

  const jobHours = result.scheduled.find(s => s.uuid === uuid)?.hours || 4;

  // Build a map of hours used per day from the schedule
  const dayLoad = new Map();
  for (const week of result.weeks) {
    for (const day of week.days) {
      if (day.isWorkday) dayLoad.set(day.date, day.hoursUsed);
    }
  }

  // Search ±7 days around target, then expand to any future workday up to 90 days out
  const windowStart = new Date(target);
  windowStart.setDate(windowStart.getDate() - 7);
  const windowEnd = new Date(target);
  windowEnd.setDate(windowEnd.getDate() + 7);

  let bestDay = null;
  let bestScore = Infinity;

  // Generate candidate workdays: today+1 through today+90
  const scanEnd = new Date(today);
  scanEnd.setDate(scanEnd.getDate() + 90);
  const allWorkdays = [];
  const cursor = new Date(today);
  cursor.setDate(cursor.getDate() + 1);
  while (cursor <= scanEnd) {
    const dow = cursor.getDay();
    if (dow >= 2 && dow <= 5) {
      allWorkdays.push(cursor.toISOString().slice(0, 10));
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  // First pass: within ±7 day window
  for (const dayStr of allWorkdays) {
    const dayDate = new Date(dayStr + 'T00:00:00');
    if (dayDate < windowStart || dayDate > windowEnd) continue;
    const used = dayLoad.get(dayStr) || 0;
    if (used + jobHours > 8) continue;
    const daysFromTarget = Math.abs(Math.round((dayDate - target) / (1000 * 60 * 60 * 24)));
    const score = daysFromTarget + used * 0.5;
    if (score < bestScore) { bestScore = score; bestDay = dayStr; }
  }

  // Fallback: any future workday with capacity
  if (!bestDay) {
    for (const dayStr of allWorkdays) {
      const used = dayLoad.get(dayStr) || 0;
      if (used + jobHours <= 8) { bestDay = dayStr; break; }
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

// --- Orders routes ---
app.get('/api/orders', (_req, res) => {
  res.json(ordersData);
});

app.post('/api/orders', (req, res) => {
  const { jobId, clientName, description } = req.body;
  if (!jobId || !description) return res.status(400).json({ error: 'jobId and description required' });
  const item = {
    id: randomUUID(),
    jobId: String(jobId).trim(),
    clientName: (clientName || '').trim(),
    description: String(description).trim(),
    supplier: (req.body.supplier || '').trim(),
    orderedDate: null,
    createdAt: new Date().toISOString(),
  };
  ordersData.items.push(item);
  saveOrders();
  res.json(item);
});

app.patch('/api/orders/:id', (req, res) => {
  const item = ordersData.items.find(i => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  if ('orderedDate' in req.body) item.orderedDate = req.body.orderedDate;
  if ('supplier' in req.body) item.supplier = (req.body.supplier || '').trim();
  saveOrders();
  res.json(item);
});

app.post('/api/orders/batch-order', (_req, res) => {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Brisbane' });
  let count = 0;
  for (const item of ordersData.items) {
    if (!item.orderedDate) { item.orderedDate = today; count++; }
  }
  saveOrders();
  res.json({ ok: true, count });
});

app.delete('/api/orders/:id', (req, res) => {
  const idx = ordersData.items.findIndex(i => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  ordersData.items.splice(idx, 1);
  saveOrders();
  res.json({ ok: true });
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
