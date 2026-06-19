// --- Board Views ---
const VIEWS = {
  sales: {
    label: 'Sales & Estimating',
    columns: [
      { name: 'Unqueued', wip: null },
      { name: 'Lead', wip: 50 },
      { name: 'Lead Called', wip: null },
      { name: 'Quote Request', wip: null },
      { name: 'Quote to Send', wip: null },
      { name: 'Pending Quote Outcome', wip: null },
      { name: 'Quote Outcome Follow-Up', wip: null },
      { name: 'Expired Quote', wip: null },
      { name: 'Awaiting 50% Deposit', wip: null },
    ],
  },
  production: {
    label: 'Production & Workshop',
    columns: [
      { name: 'Awaiting 50% Deposit', wip: null },
      { name: 'Send Order Form', wip: null },
      { name: 'Order Parts', wip: null },
      { name: 'Ready for Manufacture', wip: null },
      { name: 'Schedule Works', wip: 15 },
      { name: 'Ready for Installation', wip: null },
      { name: 'Unqueued', wip: null },
    ],
  },
  installation: {
    label: 'Installation & Logistics',
    columns: [
      { name: 'Booking / Scheduling Installation', wip: null },
      { name: 'Outbound / Out for Installation Today', wip: null },
      { name: 'Awaiting Final Payment', wip: null },
      { name: 'On Hold', wip: null },
    ],
  },
};

// Map old SM8 queue names to consolidated names
const QUEUE_REMAP = {
  'Workshop': 'In Production',
  'Waiting on Client': 'On Hold',
};

// HR queues excluded entirely
const EXCLUDED_QUEUES = new Set(['Employment', 'Resume Recieved', 'Resume Received']);

const STALE_DAYS = 7;

let allJobs = [];
let queues = [];
let currentView = 'production';
let statusFilter = 'Work Order';
let toastTimer = null;

// --- Init ---
async function init() {
  try {
    const [q, j] = await Promise.all([
      fetch('/api/queues').then(r => r.json()),
      fetch('/api/jobs').then(r => r.json()),
    ]);
    queues = q;
    allJobs = j;
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('board').classList.remove('hidden');
    renderBoard();
    connectSSE();
  } catch (err) {
    console.error('Init error:', err);
    showToast('Failed to load data', 'error');
  }
}

// --- View switching ---
function setView(view) {
  currentView = view;
  document.querySelectorAll('.view-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.view === view);
  });
  renderBoard();
}

// --- Filters ---
document.getElementById('search').addEventListener('input', renderBoard);

function setFilter(f) {
  statusFilter = f;
  document.querySelectorAll('.filter-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === f);
  });
  renderBoard();
}

function getFilteredJobs() {
  let jobs = allJobs.filter(j => !EXCLUDED_QUEUES.has(j.queue_name));
  if (statusFilter !== 'all') {
    jobs = jobs.filter(j => j.status === statusFilter);
  }
  const term = document.getElementById('search').value.toLowerCase();
  if (term) {
    jobs = jobs.filter(j =>
      (j.generated_job_id || '').toLowerCase().includes(term) ||
      (j.company_name || '').toLowerCase().includes(term) ||
      (j.job_description || '').toLowerCase().includes(term)
    );
  }
  return jobs;
}

// --- Job helpers ---
function getJobSize(job) {
  const amt = parseFloat(job.total_invoice_amount || 0);
  if (amt >= 5000) return { label: 'LRG', cls: 'badge-size-l' };
  if (amt >= 1000) return { label: 'MED', cls: 'badge-size-m' };
  if (amt > 0) return { label: 'SML', cls: 'badge-size-s' };
  return null;
}

function getStaleDays(job) {
  const edit = job.edit_date;
  if (!edit || edit.startsWith('0000')) return 0;
  const d = new Date(edit);
  if (isNaN(d.getTime())) return 0;
  return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
}

function getStaleInfo(job) {
  const days = getStaleDays(job);
  if (days >= 30) return { text: `⚠ ${days}d inactive`, cls: 'stale-critical' };
  if (days >= STALE_DAYS) return { text: `${days}d inactive`, cls: 'stale-warning' };
  return null;
}

function getDueInfo(job) {
  const dateStr = job.job_is_scheduled_until_stamp || job.work_order_date;
  if (!dateStr || dateStr.startsWith('0000')) return null;
  const due = new Date(dateStr);
  if (isNaN(due.getTime())) return null;
  const now = new Date();
  const diffDays = Math.ceil((due - now) / (1000 * 60 * 60 * 24));
  const formatted = due.toLocaleDateString('en-AU', { day: '2-digit', month: 'short' });
  if (diffDays < 0) return { text: formatted, cls: 'overdue', card: 'overdue' };
  if (diffDays <= 7) return { text: formatted, cls: 'due-soon', card: 'due-soon' };
  return { text: formatted, cls: '', card: '' };
}

function isScheduled(job) {
  const s = job.job_is_scheduled_until_stamp;
  return s && !s.startsWith('0000');
}

function getScheduleInfo(job) {
  if (!isScheduled(job)) return null;
  const d = new Date(job.job_is_scheduled_until_stamp);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const diffDays = Math.ceil((d - now) / (1000 * 60 * 60 * 24));
  if (diffDays < -3) return null;
  const text = d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short' });
  if (diffDays >= 0) return { text, cls: 'booked-green' };
  return { text, cls: 'booked-orange' };
}

function effectiveQueue(job) {
  const q = job.queue_name || '';
  if (!q) return 'Unqueued';
  if (EXCLUDED_QUEUES.has(q)) return q;
  return QUEUE_REMAP[q] || q;
}

// --- Render ---
function renderBoard() {
  const board = document.getElementById('board');
  const jobs = getFilteredJobs();
  const total = allJobs.filter(j => !EXCLUDED_QUEUES.has(j.queue_name)).length;
  const showing = jobs.length;
  document.getElementById('job-count').textContent = showing === total
    ? `${total} jobs` : `${showing} / ${total} jobs`;

  const view = VIEWS[currentView];
  const viewColumnNames = new Set(view.columns.map(c => c.name));

  // Bucket jobs into this view's columns
  const jobsByQueue = new Map();
  for (const col of view.columns) jobsByQueue.set(col.name, []);
  for (const j of jobs) {
    const q = effectiveQueue(j);
    if (viewColumnNames.has(q)) {
      jobsByQueue.get(q).push(j);
    }
  }

  // Sort: most recently edited first
  for (const [, arr] of jobsByQueue) {
    arr.sort((a, b) => new Date(b.edit_date || 0) - new Date(a.edit_date || 0));
  }

  // Count jobs visible in this view
  let viewTotal = 0;
  for (const [, arr] of jobsByQueue) viewTotal += arr.length;
  document.getElementById('view-count').textContent = `${viewTotal} in view`;

  let html = '<div class="board-inner">';
  for (const col of view.columns) {
    const colJobs = jobsByQueue.get(col.name) || [];
    const wipClass = col.wip
      ? colJobs.length > col.wip ? 'over-limit' : colJobs.length === col.wip ? 'at-limit' : ''
      : '';
    const wipLabel = col.wip ? `<span class="wip-limit">/ ${col.wip}</span>` : '';

    html += `
      <div class="column" data-queue="${esc(col.name)}"
           ondragover="onDragOver(event)" ondragleave="onDragLeave(event)" ondrop="onDrop(event)">
        <div class="column-header">
          <span class="column-title">${esc(col.name)}</span>
          <div class="column-counts">
            <span class="column-count ${wipClass}">${colJobs.length}</span>
            ${wipLabel}
          </div>
        </div>
        <div class="column-body">
          ${colJobs.length === 0 ? '<div class="column-empty">No jobs</div>' : colJobs.map(cardHTML).join('')}
        </div>
      </div>`;
  }
  html += '</div>';
  board.innerHTML = html;
}

function cardHTML(job) {
  const isQuote = job.status === 'Quote';
  const amount = parseFloat(job.total_invoice_amount || 0);
  const size = getJobSize(job);
  const stale = getStaleInfo(job);
  const queue = effectiveQueue(job);
  const schedInfo = getScheduleInfo(job);

  const amountStr = amount > 0
    ? `<span class="card-amount">$${amount.toLocaleString('en-AU', { minimumFractionDigits: 2 })}</span>`
    : '';

  let dateStr = '';
  if (!schedInfo && stale) {
    dateStr = `<span class="card-date ${stale.cls}">${stale.text}</span>`;
  }

  let borderClass = isQuote ? 'status-quote' : 'status-wo';

  const holdTag = queue === 'On Hold' ? getHoldReason(job) : '';

  return `
    <div class="card ${borderClass}" draggable="true" data-uuid="${job.uuid}"
         ondragstart="onDragStart(event)" ondragend="onDragEnd(event)"
         onclick='openModal(${JSON.stringify(job.uuid)})'>
      ${schedInfo ? `<div class="card-booked-bar ${schedInfo.cls}">📅 Booked: ${schedInfo.text}</div>` : ''}
      <div class="card-top">
        <span class="card-job-id">${esc(job.generated_job_id || '')}</span>
        <div class="badge-row">
          ${size ? `<span class="badge badge-size ${size.cls}">${size.label}</span>` : ''}
          ${isQuote ? '<span class="badge badge-q">Q</span>' : ''}
        </div>
      </div>
      <div class="card-client">${esc(job.company_name || 'No client')}</div>
      ${job.job_description ? `<div class="card-desc">${esc(job.job_description)}</div>` : ''}
      <div class="card-footer">${amountStr}${dateStr}</div>
      ${holdTag}
    </div>`;
}

function getHoldReason(job) {
  const desc = ((job.work_done_description || '') + ' ' + (job.job_description || '')).toLowerCase();
  if (desc.includes('waiting') || desc.includes('await')) return '<span class="hold-tag">Waiting on Customer</span>';
  if (desc.includes('backorder') || desc.includes('stock')) return '<span class="hold-tag">Material Backorder</span>';
  if (desc.includes('measure') || desc.includes('remeasure')) return '<span class="hold-tag">Measure Issue</span>';
  if (desc.includes('deposit')) return '<span class="hold-tag">Awaiting Payment</span>';
  return '<span class="hold-tag">Needs Review</span>';
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// --- Drag & Drop ---
let dragUuid = null;

function onDragStart(e) {
  dragUuid = e.currentTarget.dataset.uuid;
  e.dataTransfer.effectAllowed = 'move';
  e.currentTarget.classList.add('dragging');
}

function onDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  dragUuid = null;
}

function onDragOver(e) {
  e.preventDefault();
  e.currentTarget.classList.add('drag-over');
}

function onDragLeave(e) {
  e.currentTarget.classList.remove('drag-over');
}

async function onDrop(e) {
  e.preventDefault();
  const col = e.currentTarget;
  col.classList.remove('drag-over');
  const targetQueue = col.dataset.queue;
  if (!dragUuid || !targetQueue) return;

  const job = allJobs.find(j => j.uuid === dragUuid);
  if (!job) return;
  if (effectiveQueue(job) === targetQueue) return;

  const sm8Queue = getSmQueueName(targetQueue);
  const prevQueue = job.queue_name;
  job.queue_name = sm8Queue;
  renderBoard();

  try {
    await fetch(`/api/jobs/${dragUuid}/queue`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queue_name: sm8Queue }),
    });
  } catch {
    job.queue_name = prevQueue;
    renderBoard();
    showToast('Failed to move job', 'error');
  }
}

function getSmQueueName(displayName) {
  for (const [original, mapped] of Object.entries(QUEUE_REMAP)) {
    if (mapped === displayName) return original;
  }
  if (displayName === 'Unqueued') return '';
  return displayName;
}

// --- Modal ---
function openModal(uuid) {
  const job = allJobs.find(j => j.uuid === uuid);
  if (!job) return;

  document.getElementById('modal-job-id').textContent = job.generated_job_id || '';
  document.getElementById('modal-client').textContent = job.company_name || 'No client';

  const amount = parseFloat(job.total_invoice_amount || 0);
  const staleDays = getStaleDays(job);
  const rows = [
    ['Queue', effectiveQueue(job)],
    ['SM8 Queue', job.queue_name || 'None'],
    ['Status', job.status],
    ['Description', job.job_description],
    ['Address', job.job_address],
    ['Created', formatDate(job.date)],
    ['Last Updated', formatDate(job.edit_date)],
    ['Days Since Activity', staleDays > 0 ? `${staleDays} days` : null],
    ['Quote Sent', formatDate(job.quote_sent_stamp)],
    ['Work Order Date', formatDate(job.work_order_date)],
    ['Amount', amount > 0 ? `$${amount.toLocaleString('en-AU', { minimumFractionDigits: 2 })}` : null],
    ['Notes', job.work_done_description],
  ].filter(([, v]) => v);

  document.getElementById('modal-body').innerHTML = rows.map(([label, value]) =>
    `<div class="modal-row"><div class="modal-label">${esc(label)}</div><div class="modal-value">${esc(String(value))}</div></div>`
  ).join('');

  document.getElementById('modal-backdrop').style.display = 'flex';
}

function formatDate(d) {
  if (!d || d.startsWith('0000')) return null;
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? null : dt.toLocaleDateString('en-AU');
}

function closeModal(e) {
  if (e && e.target && e.target !== document.getElementById('modal-backdrop')) return;
  document.getElementById('modal-backdrop').style.display = 'none';
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
});

// --- Sync ---
async function handleSync() {
  const btn = document.getElementById('sync-btn');
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  try {
    await fetch('/api/sync', { method: 'POST' });
  } catch {
    showToast('Sync failed', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sync';
  }
}

// --- SSE ---
function connectSSE() {
  const es = new EventSource('/api/events');

  es.addEventListener('job_updated', e => {
    const data = JSON.parse(e.data);
    const idx = allJobs.findIndex(j => j.uuid === data.uuid);
    if (idx >= 0) allJobs[idx] = data;
    else allJobs.push(data);
    renderBoard();
  });

  es.addEventListener('job_removed', e => {
    const { uuid } = JSON.parse(e.data);
    allJobs = allJobs.filter(j => j.uuid !== uuid);
    renderBoard();
  });

  es.addEventListener('sync_complete', async e => {
    const { jobCount } = JSON.parse(e.data);
    const j = await fetch('/api/jobs').then(r => r.json());
    allJobs = j;
    renderBoard();
    showToast(`Synced ${jobCount} jobs`);
  });
}

// --- Toast ---
function showToast(message, type = 'info') {
  clearTimeout(toastTimer);
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `toast toast-${type}`;
  el.style.display = 'block';
  toastTimer = setTimeout(() => { el.style.display = 'none'; }, 3000);
}

// --- Start ---
init();
