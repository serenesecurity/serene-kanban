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
let currentView = 'schedule';
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
    setView('schedule');
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

  document.getElementById('board').classList.add('hidden');
  document.getElementById('schedule-view').classList.add('hidden');
  document.getElementById('orders-view').classList.add('hidden');
  document.getElementById('actions-view').classList.add('hidden');

  if (view === 'schedule') {
    document.getElementById('schedule-view').classList.remove('hidden');
    setScheduleTab(scheduleTab);
  } else if (view === 'orders') {
    document.getElementById('orders-view').classList.remove('hidden');
    loadOrders();
  } else if (view === 'actions') {
    document.getElementById('actions-view').classList.remove('hidden');
    loadActions();
  } else {
    document.getElementById('board').classList.remove('hidden');
    renderBoard();
  }
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
  let jobs = allJobs.filter(j => !EXCLUDED_QUEUES.has(j.queue_name) && j.generated_job_id !== 'SAMPLE');
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
  const stamp = job.job_is_scheduled_until_stamp;
  const d = new Date(stamp);
  if (isNaN(d.getTime())) return null;
  const todayStr = new Date().toLocaleDateString('en-CA');
  const bookStr = stamp.slice(0, 10);
  if (bookStr < todayStr) return null;
  const text = d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short' });
  return { text, cls: 'booked-green' };
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

  // Bucket jobs into this view's columns, overflow into "Other"
  const jobsByQueue = new Map();
  for (const col of view.columns) jobsByQueue.set(col.name, []);
  jobsByQueue.set('Other', []);
  for (const j of jobs) {
    const q = effectiveQueue(j);
    if (viewColumnNames.has(q)) {
      jobsByQueue.get(q).push(j);
    } else {
      jobsByQueue.get('Other').push(j);
    }
  }
  // Add "Other" column config if it has jobs
  const allColumns = [...view.columns];
  if (jobsByQueue.get('Other').length > 0) {
    allColumns.push({ name: 'Other', wip: null });
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
  for (const col of allColumns) {
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
    if (currentView === 'schedule') {
      if (scheduleTab === 'scheduler') loadScheduler();
      else loadSchedule();
    } else {
      renderBoard();
    }
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

// --- Schedule view ---
async function loadSchedule() {
  document.getElementById('schedule-body').innerHTML = '<p style="color:#64748b;text-align:center;padding:40px;">Loading schedule...</p>';

  try {
    const res = await fetch('/api/schedule');
    const data = await res.json();
    renderSchedule(data);
  } catch {
    document.getElementById('schedule-body').innerHTML = '<p style="color:#ef4444;text-align:center;padding:40px;">Failed to load schedule</p>';
  }
}

function renderSchedule(data) {
  const body = document.getElementById('schedule-body');

  if (!data.weeks || !data.weeks.length) {
    body.innerHTML = '<div class="schedule-empty">No Work Orders to schedule.<br><br><span style="font-size:12px;color:#64748b;">Work Orders with location data will appear here with recommended install dates.</span></div>';
    return;
  }

  // Collect unscheduled jobs for sidebar
  const unsched = data.unscheduled || [];

  let html = '<div class="cal-layout">';
  html += '<div class="cal-main">';

  for (const week of data.weeks) {
    const weekStart = new Date(week.days[0].date + 'T00:00:00');
    const weekLabel = weekStart.toLocaleDateString('en-AU', { day: 'numeric', month: 'long' });
    html += `<div class="cal-week">`;
    html += `<div class="cal-week-label">Week of ${esc(weekLabel)}</div>`;
    html += `<div class="cal-row">`;

    for (const day of week.days) {
      const isMonday = day.dayName === 'Mon';
      const hasJobs = day.jobs.length > 0;
      const dayDate = new Date(day.date + 'T00:00:00');
      const isToday = new Date().toISOString().slice(0, 10) === day.date;
      const isPast = dayDate < new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00');

      const canDrop = !isMonday && !isPast;
      html += `<div class="cal-day ${isMonday ? 'cal-day-off' : ''} ${isToday ? 'cal-day-today' : ''} ${isPast ? 'cal-day-past' : ''}" data-cal-date="${day.date}" ${canDrop ? 'ondragover="onCalDragOver(event)" ondragleave="onCalDragLeave(event)" ondrop="onCalDrop(event)"' : ''}>`;
      html += `<div class="cal-day-head"><span class="cal-day-name">${day.dayName}</span><span class="cal-day-num">${day.dayNum} ${day.month}</span></div>`;

      if (isMonday) {
        html += `<div class="cal-day-off-label">No installs</div>`;
      } else if (!hasJobs) {
        html += `<div class="cal-day-empty">Available</div>`;
      } else {
        // Capacity bar
        const pct = Math.min(100, Math.round((day.hoursUsed / day.capacity) * 100));
        const barColor = pct >= 90 ? '#ef4444' : pct >= 70 ? '#f59e0b' : '#22c55e';
        html += `<div class="cal-capacity"><div class="cal-capacity-bar" style="width:${pct}%;background:${barColor}"></div><span class="cal-capacity-label">${day.hoursUsed}/${day.capacity}h</span></div>`;

        for (const job of day.jobs) {
          const jobClass = job.booked ? 'cal-job cal-job-booked' : 'cal-job cal-job-recommended';
          const statusTag = job.booked
            ? '<span class="cal-status-tag cal-status-booked">Scheduled</span>'
            : '<span class="cal-status-tag cal-status-recommended">Not Yet Scheduled</span>';

          html += `<div class="${jobClass}" data-uuid="${job.uuid}" data-date="${job.installDate}" ${!job.booked ? 'draggable="true" ondragstart="onCalDragStart(event)" ondragend="onCalDragEnd(event)"' : ''}>`;

          if (job.travelMins > 0) html += `<div class="cal-job-travel">🚐 ${job.travelKm}km · ${job.travelMins}min</div>`;
          if (job.multiDay) html += `<div class="cal-job-multiday">${esc(job.dayPart)}</div>`;
          html += statusTag;
          html += `<div class="cal-job-id">${esc(job.jobId)}</div>`;
          html += `<div class="cal-job-client">${esc(job.client)}</div>`;
          html += `<div class="cal-job-desc">${summariseItems(job.items)}</div>`;
          html += `<div class="cal-job-meta"><span>${parseFloat(job.hours.toFixed(1))}h</span>${job.hasDeposit ? '<span class="cal-paid">Paid</span>' : ''}</div>`;
          if (!job.booked) {
            html += `<div class="cal-job-actions">`;
            html += `<button class="cal-act-btn" onclick="event.stopPropagation();moveScheduleJob('${job.uuid}','${job.installDate}')">Date</button>`;
            html += `<button class="cal-act-btn cal-act-reschedule" onclick="event.stopPropagation();rescheduleJob('${job.uuid}', 7)">+1w</button>`;
            html += `<button class="cal-act-btn cal-act-reschedule" onclick="event.stopPropagation();rescheduleJob('${job.uuid}', 14)">+2w</button>`;
            html += `<button class="cal-act-btn cal-act-reschedule" onclick="event.stopPropagation();rescheduleJob('${job.uuid}', 21)">+3w</button>`;
            html += `<button class="cal-act-btn cal-act-remove" onclick="event.stopPropagation();removeScheduleJob('${job.uuid}')">Remove</button>`;
            html += `</div>`;
          }
          html += `</div>`;
        }
      }

      html += `</div>`;
    }

    html += `</div></div>`;
  }

  // Close cal-main
  html += `</div>`;

  // Sidebar for unscheduled jobs
  html += `<div class="cal-sidebar" ondragover="onCalDragOver(event)" ondragleave="onCalDragLeave(event)" ondrop="onCalDropSidebar(event)">`;
  html += `<div class="cal-sidebar-header">Unscheduled <span class="cal-sidebar-count">${unsched.length}</span></div>`;
  if (!unsched.length) {
    html += `<div class="cal-sidebar-empty">All jobs scheduled</div>`;
  } else {
    for (const job of unsched) {
      const orderInfo = job.orderDaysAgo != null ? `<div class="cal-sidebar-order">Ordered ${job.orderDaysAgo}d ago</div>` : '<div class="cal-sidebar-order">No order form</div>';
      html += `<div class="cal-job cal-job-unscheduled" draggable="true" data-uuid="${job.uuid}" ondragstart="onCalDragStart(event)" ondragend="onCalDragEnd(event)">`;
      html += `<div class="cal-job-id">${esc(job.jobId)}</div>`;
      html += `<div class="cal-job-client">${esc(job.client)}</div>`;
      html += orderInfo;
      html += `<div class="cal-job-meta"><span>${parseFloat(job.hours.toFixed(1))}h</span>${job.hasDeposit ? '<span class="cal-paid">Paid</span>' : ''}</div>`;
      html += `</div>`;
    }
  }
  html += `</div>`;

  // Close cal-layout
  html += `</div>`;

  // Summary
  const totalJobs = data.scheduled.length;
  const bookedCount = data.scheduled.filter(s => s.booked).length;
  const recommendedCount = totalJobs - bookedCount;
  html += `<div class="cal-summary"><span class="cal-legend-booked"></span> ${bookedCount} Scheduled &nbsp; <span class="cal-legend-recommended"></span> ${recommendedCount} Not Yet Scheduled &nbsp; <span class="cal-legend-unsched"></span> ${unsched.length} Unscheduled <button class="cal-reset-btn" onclick="resetSchedule()">Reset to recommended</button></div>`;

  body.innerHTML = html;
}

function summariseItems(items) {
  if (!items || !items.length) return 'No items';
  const grouped = new Map();
  for (const i of items) {
    const short = i.label
      .replace(/IntrudaGuard|Premium|Panther Protect|316 Stainless Steel Mesh|Perforated Mesh|with Triple Locks|with Single Locks|Security/gi, '')
      .replace(/\s*-\s*[\w/]+$/, '')
      .replace(/\s+/g, ' ').trim();
    const key = short || i.label;
    grouped.set(key, (grouped.get(key) || 0) + i.qty);
  }
  const parts = [];
  for (const [name, qty] of grouped) {
    parts.push(qty > 1 ? `${qty}x ${name}` : name);
  }
  return esc(parts.join(', '));
}

function formatSchedDate(str) {
  if (!str) return '';
  const d = new Date(str + 'T00:00:00');
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

// --- Schedule editing ---
async function moveScheduleJob(uuid, currentDate) {
  const newDate = prompt('Move to date (YYYY-MM-DD):', currentDate);
  if (!newDate || newDate === currentDate) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate)) { showToast('Invalid date format', 'error'); return; }

  try {
    await fetch(`/api/schedule/${uuid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installDate: newDate }),
    });
    loadSchedule();
    showToast('Job moved');
  } catch {
    showToast('Failed to move job', 'error');
  }
}

async function rescheduleJob(uuid, approxDays) {
  try {
    const res = await fetch(`/api/schedule/${uuid}/reschedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approxDays }),
    });
    const data = await res.json();
    if (data.error) { showToast(data.error, 'error'); return; }
    loadSchedule();
    const d = new Date(data.installDate + 'T00:00:00');
    showToast(`Rescheduled to ${d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })}`);
  } catch {
    showToast('Failed to reschedule', 'error');
  }
}

async function removeScheduleJob(uuid) {
  if (!confirm('Remove this job from the schedule?')) return;
  try {
    await fetch(`/api/schedule/${uuid}`, { method: 'DELETE' });
    loadSchedule();
    showToast('Job removed from schedule');
  } catch {
    showToast('Failed to remove job', 'error');
  }
}

async function resetSchedule() {
  if (!confirm('Reset all schedule changes back to recommended?')) return;
  try {
    await fetch('/api/schedule/reset', { method: 'POST' });
    loadSchedule();
    showToast('Schedule reset');
  } catch {
    showToast('Failed to reset', 'error');
  }
}

// --- Schedule tab switching ---
let scheduleTab = 'scheduler';

function setScheduleTab(tab) {
  scheduleTab = tab;
  document.querySelectorAll('.sched-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.stab === tab);
  });
  if (tab === 'calendar') loadSchedule();
  else loadScheduler();
}

// --- Scheduler view (Order Form Lead Times) ---
async function loadScheduler() {
  const body = document.getElementById('schedule-body');
  body.innerHTML = '<p style="color:#64748b;text-align:center;padding:40px;">Loading scheduler...</p>';

  try {
    const [schedRes, ordersRes] = await Promise.all([fetch('/api/scheduler'), fetch('/api/orders')]);
    const data = await schedRes.json();
    const ordersData = await ordersRes.json();
    allOrders = ordersData.items || [];
    renderScheduler(data);
  } catch {
    body.innerHTML = '<p style="color:#ef4444;text-align:center;padding:40px;">Failed to load scheduler</p>';
  }
}

function renderScheduler(data) {
  const body = document.getElementById('schedule-body');
  if (!data.items || !data.items.length) {
    body.innerHTML = '<div class="schedule-empty">No eligible Work Orders found.</div>';
    return;
  }

  // Split into deposit-confirmed and no-deposit
  const depositItems = data.items.filter(j => j.hasDeposit);
  const noDepositItems = data.items.filter(j => !j.hasDeposit);

  // Assign status to each deposit-confirmed job
  const rows = depositItems.map(job => {
    const winStart = job.readyWindowStart || 18;
    const winEnd = job.readyWindowEnd || 25;
    let status, statusCls;
    if (job.isBooked) { status = 'Booked'; statusCls = 'st-booked'; }
    else if (job.hasOrderForm && job.daysSinceSent >= winStart) { status = 'Ready'; statusCls = 'st-ready'; }
    else if (job.hasOrderForm && job.daysSinceSent >= winStart - 4) { status = 'Coming Soon'; statusCls = 'st-soon'; }
    else if (job.hasOrderForm) { status = 'Ordered'; statusCls = 'st-ordered'; }
    else { status = 'Not Sent'; statusCls = 'st-nosend'; }
    return { ...job, status, statusCls };
  });

  // Sort: Ready first, then Coming Soon, Ordered, Not Sent, Booked
  const statusOrder = { 'Ready': 0, 'Coming Soon': 1, 'Ordered': 2, 'Not Sent': 3, 'Booked': 4 };
  rows.sort((a, b) => statusOrder[a.status] - statusOrder[b.status] || (b.daysSinceSent ?? -1) - (a.daysSinceSent ?? -1));

  // Count by status
  const counts = {};
  rows.forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1; });

  let html = '<div class="sched-summary">';
  const badges = [
    { label: 'Ready', cls: 'st-ready', count: counts['Ready'] || 0 },
    { label: 'Coming Soon', cls: 'st-soon', count: counts['Coming Soon'] || 0 },
    { label: 'Ordered', cls: 'st-ordered', count: counts['Ordered'] || 0 },
    { label: 'Not Sent', cls: 'st-nosend', count: counts['Not Sent'] || 0 },
    { label: 'Booked', cls: 'st-booked', count: counts['Booked'] || 0 },
    { label: 'No Deposit', cls: 'st-nodeposit', count: noDepositItems.length },
  ];
  for (const b of badges) {
    html += `<span class="sched-sum-badge ${b.cls}">${b.count} ${b.label}</span>`;
  }
  html += `<span class="sched-window-info">Ready window: 18-25 days (2.5-3.5 weeks) from order</span>`;
  html += `</div>`;

  html += `<div class="sched-table-wrap"><table class="sched-table">`;
  html += `<thead><tr>
    <th>Status</th>
    <th>Job</th>
    <th>Client</th>
    <th>Suburb</th>
    <th>Ordered</th>
    <th>Days</th>
    <th>Ready Window</th>
    <th>Deposit</th>
    <th>Parts</th>
  </tr></thead><tbody>`;

  let lastStatus = '';
  for (const r of rows) {
    // Section divider row
    if (r.status !== lastStatus) {
      lastStatus = r.status;
      html += `<tr class="sched-divider ${r.statusCls}-bg"><td colspan="10">${esc(r.status)}${r.status === 'Ready' ? ' — ready to book installation' : r.status === 'Coming Soon' ? ' — parts arriving soon' : r.status === 'Ordered' ? ' — recently placed' : r.status === 'Not Sent' ? ' — order form not yet sent' : ' — installation scheduled'}</td></tr>`;
    }

    const winStart = r.readyWindowStart || 18;
    const winEnd = r.readyWindowEnd || 25;
    const sentStr = r.orderFormSentDate ? new Date(r.orderFormSentDate + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) : '';
    let estReadyStr = '';
    if (r.orderFormSentDate) {
      const d1 = new Date(r.orderFormSentDate + 'T00:00:00');
      const d2 = new Date(r.orderFormSentDate + 'T00:00:00');
      d1.setDate(d1.getDate() + winStart);
      d2.setDate(d2.getDate() + winEnd);
      const fmt = d => d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
      estReadyStr = `${fmt(d1)} - ${fmt(d2)}`;
    }
    if (r.isBooked) {
      estReadyStr = new Date(r.bookedDate + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) + ' ✓';
    }

    const daysStr = r.daysSinceSent != null ? `${r.daysSinceSent}d` : '';
    const depositStr = r.hasDeposit ? '<span class="cal-paid">Paid</span>' : '<span class="sched-no-deposit">No</span>';
    const amtStr = r.amount > 0 ? `$${r.amount.toLocaleString('en-AU', { minimumFractionDigits: 0 })}` : '';

    // Progress bar: fills to winStart (ready), then past winEnd turns fully green
    let progressBar = '';
    if (r.hasOrderForm) {
      const pct = Math.min(100, Math.round((r.daysSinceSent / winEnd) * 100));
      const barColor = r.daysSinceSent >= winStart ? '#22c55e' : r.daysSinceSent >= winStart - 4 ? '#f59e0b' : '#38bdf8';
      progressBar = `<div class="sched-mini-bar"><div style="width:${pct}%;background:${barColor}"></div></div>`;
    }

    // Parts order status from Orders page
    const jobOrders = allOrders.filter(o => o.jobId === r.jobId);
    let partsStr = '';
    if (jobOrders.length) {
      const hasPending = jobOrders.some(o => !o.orderedDate && !o.inStock);
      partsStr = hasPending
        ? '<span class="sched-parts-pending">Pending</span>'
        : '<span class="sched-parts-ordered">Ordered</span>';
    }

    html += `<tr class="sched-row">
      <td><span class="sched-status-badge ${r.statusCls}">${esc(r.status)}</span></td>
      <td class="sched-cell-id">${esc(r.jobId)}</td>
      <td>${esc(r.client)}</td>
      <td>${esc(r.suburb || '')}</td>
      <td>${sentStr}</td>
      <td>${daysStr}${progressBar}</td>
      <td>${estReadyStr}</td>
      <td>${depositStr}</td>
      <td>${partsStr}</td>
    </tr>`;
  }

  html += `</tbody></table></div>`;

  // No Deposit warning section
  if (noDepositItems.length) {
    html += `<div class="sched-nodeposit-section">`;
    html += `<div class="sched-nodeposit-header">No Deposit — ${noDepositItems.length} Work Order${noDepositItems.length > 1 ? 's' : ''} without deposit collected</div>`;
    html += `<div class="sched-table-wrap"><table class="sched-table"><thead><tr>
      <th>Job</th><th>Client</th><th>Suburb</th><th>Queue</th>
    </tr></thead><tbody>`;
    for (const j of noDepositItems) {
      html += `<tr class="sched-row sched-nodeposit-row">
        <td class="sched-cell-id">${esc(j.jobId)}</td>
        <td>${esc(j.client)}</td>
        <td>${esc(j.suburb || '')}</td>
        <td>${esc(j.queue || '')}</td>
      </tr>`;
    }
    html += `</tbody></table></div></div>`;
  }

  body.innerHTML = html;
}

// --- Schedule drag & drop ---
let calDragUuid = null;

function onCalDragStart(e) {
  const card = e.currentTarget;
  calDragUuid = card.dataset.uuid;
  e.dataTransfer.effectAllowed = 'move';
  card.classList.add('cal-dragging');
}

function onCalDragEnd(e) {
  e.currentTarget.classList.remove('cal-dragging');
  calDragUuid = null;
  document.querySelectorAll('.cal-day-drop-over').forEach(el => el.classList.remove('cal-day-drop-over'));
}

function onCalDragOver(e) {
  e.preventDefault();
  e.currentTarget.classList.add('cal-day-drop-over');
}

function onCalDragLeave(e) {
  e.currentTarget.classList.remove('cal-day-drop-over');
}

async function onCalDrop(e) {
  e.preventDefault();
  const dayEl = e.currentTarget;
  dayEl.classList.remove('cal-day-drop-over');
  const targetDate = dayEl.dataset.calDate;
  if (!calDragUuid || !targetDate) return;

  try {
    await fetch(`/api/schedule/${calDragUuid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installDate: targetDate }),
    });
    loadSchedule();
    const d = new Date(targetDate + 'T00:00:00');
    showToast(`Moved to ${d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })}`);
  } catch {
    showToast('Failed to move job', 'error');
  }
}

async function onCalDropSidebar(e) {
  e.preventDefault();
  e.currentTarget.classList.remove('cal-day-drop-over');
  if (!calDragUuid) return;
  try {
    await fetch(`/api/schedule/${calDragUuid}`, { method: 'DELETE' });
    loadSchedule();
    showToast('Job moved to unscheduled');
  } catch {
    showToast('Failed to unschedule job', 'error');
  }
}

// --- Darley Catalogue ---
const DARLEY_CATALOGUE = [
  ['AU01001','ScreenGuard Security Door Frame'],
  ['AU01002','ScreenGuard 11mm Window Frame'],
  ['AU01003','ScreenGuard 8mm Window Frame'],
  ['AU01004','ScreenGuard 41mm Mid Rail'],
  ['AU01006','ScreenGuard 11mm Window Frame With Leg'],
  ['AU01012','ScreenGuard Extreme Door Frame'],
  ['AU01013','ScreenGuard Door Frame With Panel Insert'],
  ['AU01014','ScreenGuard 70mm Mid Rail With Screw Flutes'],
  ['AU01015','ScreenGuard Extreme Window Frame'],
  ['AU01016','ScreenGuard Extreme Build Out Frame'],
  ['AU03001','ScreenGuard ACCESS Window Frame'],
  ['AU03004','ScreenGuard ACCESS Catch'],
  ['AU03005','ScreenGuard ACCESS Outer Frame'],
  ['AU01-1050-20','316 Stainless Steel Mesh 1050 x 2000mm'],
  ['AU01-1050-24','316 Stainless Steel Mesh 1050 x 2400mm'],
  ['AU01-1212','316 Stainless Steel Mesh 1200 x 1200mm'],
  ['AU01-1215','316 Stainless Steel Mesh 1200 x 1500mm'],
  ['AU01-1220','316 Stainless Steel Mesh 1200 x 2000mm'],
  ['AU01-1224','316 Stainless Steel Mesh 1200 x 2400mm'],
  ['AU01-1230','316 Stainless Steel Mesh 1200 x 3000mm'],
  ['AU01-1520','316 Stainless Steel Mesh 1500 x 2000mm'],
  ['AU01-1524','316 Stainless Steel Mesh 1500 x 2400mm'],
  ['AU01-1530','316 Stainless Steel Mesh 1500 x 3000mm'],
  ['AU01-7512','316 Stainless Steel Mesh 750 x 1200mm'],
  ['AU01-7515','316 Stainless Steel Mesh 750 x 1500mm'],
  ['AU01-7520','316 Stainless Steel Mesh 750 x 2000mm'],
  ['AU01-7524','316 Stainless Steel Mesh 750 x 2400mm'],
  ['AU01-7530','316 Stainless Steel Mesh 750 x 3000mm'],
  ['AU01-9012','316 Stainless Steel Mesh 900 x 1200mm'],
  ['AU01-9015','316 Stainless Steel Mesh 900 x 1500mm'],
  ['AU01-9020','316 Stainless Steel Mesh 900 x 2000mm'],
  ['AU01-9024','316 Stainless Steel Mesh 900 x 2400mm'],
  ['AU01-9030','316 Stainless Steel Mesh 900 x 3000mm'],
  ['AU2-1224','304 Stainless Steel Mesh 1200 x 2400 x 1.2mm'],
  ['AU2-1524','304 Stainless Steel Mesh 1500 x 2400 x 1.2mm'],
  ['AU2-7524','304 Stainless Steel Mesh 750 x 2400 x 1.2mm'],
  ['AU2-9024','304 Stainless Steel Mesh 900 x 2400 x 1.2mm'],
  ['AU02-105','ShutterView Multi-Fold Head Track'],
  ['AU02-106','ShutterView Multi-Fold / Sliding Top Track'],
  ['AU02-107','ShutterView Shutter Sill Track'],
  ['DB3222','16mm Bug Strip'],
  ['DB3223','Under Door Bug Strip Retainer'],
  ['DB3227','25mm Bug Strip Retainer'],
  ['DF001','Security Door Frame'],
  ['DF006','Fly Door Frame'],
  ['DF007','Frame Cover'],
  ['DF012','PerfGuard Aluminium Perforated Mesh 1.6mm Fixing Bead'],
  ['DF013','Heavy DVA 3.0mm Fixing Bead'],
  ['DI3224','7mm Offset Interlock'],
  ['DI3225','13mm Frame Interlock'],
  ['DI3228','28mm Interlock'],
  ['DI3229','3mm Offset Interlock'],
  ['DJ3250','40mm Small Enclosed Jamb Adaptor'],
  ['DJ3260','60mm Large Enclosed Jamb Adaptor'],
  ['DT3020','Servery Window Track'],
  ['DT3192','Channel 25 x 19 x 1.2mm'],
  ['DT3202','36mm Large H Section'],
  ['DT3203','Top Track Adaptor'],
  ['DT3204','Light H Receiver'],
  ['DT3205','Heavy H Receiver'],
  ['DT3206','7mm Offset Interlock Extended'],
  ['DT3207','Corner Receiver'],
  ['DT3210','T Section Double Door with Seal'],
  ['DT3221','Sliding Track'],
  ['DT3223','Channel 24 x 24 x 1.2mm'],
  ['DT3226','Light T Section'],
  ['DT3231','J Track'],
  ['DT3232','Pip Screen Track'],
  ['DT3333','H Track'],
  ['DT3344','Jamb Offset H Receiver'],
  ['DT3353','Double Bottom Track'],
  ['DT3354','Double Top Track'],
  ['DT3355','16 x 16 x 1.6mm Screen Top Track'],
  ['DT3356','Chainwinder Adaptor'],
  ['DT3553','Single Screen Channel'],
  ['DT3557','Single Face Fix Top Track'],
  ['DT3558','Single Face Fix Bottom Track'],
  ['DVA1222','DVA One Way Mesh 1200 x 2200mm'],
  ['ESY004','ScreenSmart 50mm Picket Jamb'],
  ['ESY010','ScreenSmart 50 x 50mm Double Sided Post'],
  ['ESY011','ScreenSmart 50 x 50mm Corner Post'],
  ['ESY012','ScreenSmart Single Sided Gate Post'],
  ['HFF180','25 x 11mm Extruded Fly Frame'],
  ['HFF181','21 x 9mm Extruded Fly Frame'],
  ['HFF184','Extruded Spreader Bar'],
  ['HIS101','Patio Post'],
  ['HIS102','ScreenView 75mm Gate Track'],
  ['PIC003','ScreenSmart 65 x 16 x 1.4mm Picket'],
  ['PIC009','ScreenSmart 50 x 50mm Single Sided Picket Post'],
  ['PIC010','ScreenSmart 50 x 50mm Double Sided Picket Post'],
  ['PIC012','ScreenSmart 100 x 16 x 1.4mm Picket'],
  ['PIC013','ScreenSmart 38 x 16 x 1.4mm Picket'],
  ['PIC014','ScreenSmart 65 x 16 x 1.2mm Picket'],
  ['PIC040','ScreenSmart 70 x 8mm Blade'],
  ['PIC041','ScreenSmart 38 x 8mm Blade'],
  ['PIC042','ScreenSmart 70mm Frame Slotted'],
  ['PIC043','ScreenSmart 39mm Frame Slotted'],
  ['PIC044','ScreenSmart 38 x 21mm Mullion Slotted'],
  ['PIC045','ScreenSmart 51 x 35mm Fixing Channel'],
  ['PM16-1220','PerfGuard Aluminium Perforated Mesh 1200 x 2000mm x 1.6mm'],
  ['PM16-1224','PerfGuard Aluminium Perforated Mesh 1200 x 2400mm x 1.6mm'],
  ['PM16-7520','PerfGuard Aluminium Perforated Mesh 750 x 2000mm x 1.6mm'],
  ['PM16-9020','PerfGuard Aluminium Perforated Mesh 900 x 2000mm x 1.6mm'],
  ['PM16-9024','PerfGuard Aluminium Perforated Mesh 900 x 2400mm x 1.6mm'],
  ['PSH-001','PerfGuard 5.4mm Fixing Bead'],
  ['SDG1160-20','7mm Small Diamond Grille 1160 x 2000mm'],
  ['SDG1160-24','7mm Small Diamond Grille 1160 x 2400mm'],
  ['SDG942-20','7mm Small Diamond Grille 942 x 2000mm'],
  ['SDG942-24','7mm Small Diamond Grille 942 x 2400mm'],
  ['SE001','Patio Rail'],
  ['SE002','Patio Post'],
  ['SE003','Patio Channel'],
  ['SE004','Screen Adaptor'],
  ['SE9-001','Ridged Spline 3m/Ln'],
  ['SG1120','7mm Diamond Grille 1100 x 2000mm'],
  ['SG1220','7mm Diamond Grille 1250 x 2050mm'],
  ['SG1224','7mm Diamond Grille 1250 x 2450mm'],
  ['SG1230','7mm Diamond Grille 1250 x 3000mm'],
  ['SG1260','7mm Diamond Grille 1250 x 6250mm'],
  ['SG7020','7mm Diamond Grille 705 x 2000mm'],
  ['SG7520','7mm Diamond Grille 750 x 2050mm'],
  ['SG7524','7mm Diamond Grille 750 x 2450mm'],
  ['SG7530','7mm Diamond Grille 750 x 3000mm'],
  ['SG7560','7mm Diamond Grille 750 x 6250mm'],
  ['SG8220','7mm Diamond Grille 830 x 2000mm'],
  ['SG8224','7mm Diamond Grille 830 x 2450mm'],
  ['SG9220','7mm Diamond Grille 920 x 2050mm'],
  ['SG9224','7mm Diamond Grille 920 x 2450mm'],
  ['SG9230','7mm Diamond Grille 920 x 3000mm'],
  ['SG9260','7mm Diamond Grille 920 x 6250mm'],
  ['SH003','7mm Joining Mould Channel'],
  ['SH004','Joiner Without Spline'],
  ['SH005','33mm Fly Door Mid Rail'],
  ['SQF9090T20','Post/Fluted 90 x 90 x 2mm'],
  ['VT004','4 Way Tilt Rod'],
  ['VT009','Vertical Blinds'],
  ['VT010','Plain Blind Track'],
  ['VT024','Bottom Bar 10Um Clear B40'],
  ['VT039','38mm Keyway Tube'],
  ['WF001','11mm Security Window Frame'],
  ['WF002','9mm Security Window Frame'],
  ['WF004','11mm Security Window Frame With Fixing Leg'],
  ['1050','Austral Double Flushbolt For Security Doors'],
  ['1850','Fly Screen Springs 100/Bag'],
  ['1853','Panic Break Out Handle Spring 20/Bag'],
  ['1902-M','Frame Packers 5mm x 90mm 100/Bag'],
  ['1903-M','Frame Packers 10mm x 90mm 100/Bag'],
  ['1907','Aluminium Frame Packers 2mm 100/Bag'],
  ['1910','Setting Blocks 3mm Thick 1000/Bag'],
  ['1911','Setting Blocks 5mm Thick 1000/Bag'],
  ['1912','Setting Blocks 10mm Thick 500/Bag'],
  ['1930','End Cap To Suit Subsills 50 Pairs/Bag'],
  ['1950-AMN','Touch Up Paint 150g Anodic Matt Natural'],
  ['1950-BL','Touch Up Paint 150g Satin Black'],
  ['1950-DO','Touch Up Paint 150g Deep Ocean'],
  ['1950-HB','Touch Up Paint 150g Hamersley Brown'],
  ['1950-MB','Touch Up Paint 150g Matt Black'],
  ['1950-MM','Touch Up Paint 150g Monument'],
  ['1950-NPBK','Touch Up Paint 150g Paper Bark'],
  ['1950-PR','Touch Up Paint 150g Primrose'],
  ['1950-SB','Touch Up Paint 150g Stone Beige'],
  ['1950-SM','Touch Up Paint 150g Surfmist'],
  ['1950-USG','Touch Up Paint 150g Ultra Silver Gloss'],
  ['1950-WG','Touch Up Paint 150g Woodland Grey'],
  ['1950-WH','Touch Up Paint 150g White'],
  ['1960','Lanotec General Purpose Liquid Lanolin 300gm'],
  ['1961','Lanotec Cleaner/Degreaser 300gm Citra Force'],
  ['1966-BX','ScreenGuard PowaWash Concentrate 100ml Box of 24'],
  ['1966-SGL','ScreenGuard PowaWash Concentrate 100ml Single'],
  ['2000','Cyclone 610mm x 30m Gauze Stainless Steel Blk'],
  ['2001','Cyclone 760mm x 30m Gauze Stainless Steel Blk'],
  ['2002','Cyclone 810mm x 30m Gauze Stainless Steel Blk'],
  ['2003','Cyclone 910mm x 30m Gauze Stainless Steel Blk'],
  ['2005','Cyclone 1220mm x 30m Gauze Stainless Steel Blk'],
  ['2005-C','Cyclone 1220mm x 30m Gauze Stainless Steel Blk'],
  ['2006-C','Cyclone 1520mm x 30m Gauze Stainless Steel Blk'],
  ['2030','Fibreglass Mesh 610mm x 50m Charcoal'],
  ['2031','Fibreglass Mesh 760mm x 50m Charcoal'],
  ['2032','Fibreglass Mesh 810mm x 50m Charcoal'],
  ['2033','Fibreglass Mesh 910mm x 50m Charcoal'],
  ['2034','Fibreglass Mesh 1070mm x 50m Charcoal'],
  ['2035','Fibreglass Mesh 1220mm x 50m Charcoal'],
  ['2036','Fibreglass Mesh 1520mm x 50m Charcoal'],
  ['2037','Fibreglass Mesh 1830mm x 50m Charcoal'],
  ['2054-C','Cyclone Midge Fibreglass Miniweave 910mm x 30m'],
  ['2056-C','Cyclone Midge Fibreglass Miniweave 1220mm x 30m'],
  ['2060-C','Cyclone Aluminium Mesh 610mm x 30m'],
  ['2061','Aluminium Mesh 760mm x 30m'],
  ['2062','Aluminium Mesh 810mm x 30m'],
  ['2063','Aluminium Mesh 910mm x 30m'],
  ['2065','Aluminium Mesh 1220mm x 30m'],
  ['2073-C','Cyclone Duraview Pet Petscreen 910mm x 30m'],
  ['2075-C','Cyclone Duraview Pet Petscreen 1220mm x 30m'],
  ['2076-C','Cyclone Duraview Pet Petscreen 1520mm x 30m'],
  ['2077','Paw Proof Mesh 1830mm x 30m'],
  ['2093-C','Cyclone Duraview 910 x 30mm'],
  ['2100-3RV','Whitco Tasman MK2 Reverse 3 Point Kit'],
  ['2100-3ST','Whitco Tasman MK2 Standard 3 Point Kit'],
  ['2100-BL','Whitco Tasman MK2 - Black'],
  ['2100-EXT','Whitco Extended Strike To Suit Tasman MK2'],
  ['2103-3ST','Yale Quattro 3 Point Lock Kit'],
  ['2103-BL','Yale Quattro Hinged Security Door Lock No Cyl Black'],
  ['2105-3HS','Lockwood 8654 High-Sec 3 Point Lock Kit'],
  ['2105-3PK/PBT','Lockwood 8654 3 Point Lock Kit With Straight Bolts'],
  ['2105-3ST','Lockwood 8654 Std 3 Point Lock Kit'],
  ['2105-BL','Lockwood 8654 Hinged Sec Door Lock - Black'],
  ['2105-EXT','Lockwood 8654 Extra Wide Strike'],
  ['2106-27','Lockwood 1.5mm Thick Packer Centre Lock Pack Of 50'],
  ['2106-34','Lockwood 3mm Thick Narrow Plate Main Striker Packer Pack Of 50'],
  ['2106-35','Lockwood 3mm Thick Auxiliary Packer Pack Of 50'],
  ['2120-BL','Austral HD7 Hinged Door Lock No Cylinder Black'],
  ['2131-3CH','Austral Cable ULTIMATE 3 Point High Kit'],
  ['2131-BL','Austral Ultimate Hinged Door Lock Black'],
  ['2141-CA','Lockwood Flat Lock Guards All Purpose Clear'],
  ['2146-WH','Mini Push Lock White'],
  ['2150-3ST','Whitco Leichhardt Standard 3 Point Lock Kit'],
  ['2150-BL','Whitco Leichardt Black'],
  ['2150-SO-LH','Whitco Leichardt Lock Snib Only Left Hand Black'],
  ['2150-SO-RH','Whitco Leichardt Lock Snib Only Right Hand Black'],
  ['2151-3ADJ','Austral SD7 Adjustable 3 Point Rod Kit'],
  ['2151-3CH','Austral Cable SD7 3 Point High Kit'],
  ['2151-3RH','Austral SD7 Rod 3 Point High Kit'],
  ['2151-BL','Austral SD7 Sliding Door Lock Black'],
  ['2151-POOL','Austral Cable SD7 3 Point Pool Kit'],
  ['2151-SO-BL','Austral SD7 Sliding Door Lock Snib Only Black'],
  ['2154-3ST','Yale Quattro Sliding Door 3 Point Lock Kit'],
  ['2154-BL','Yale Quattro Sliding Security Door Lock Black'],
  ['2155-3PT','Lockwood 8653 Std 3 Point Lock Kit Sliding'],
  ['2155-BL','Lockwood 8653 Sliding Security Door Lock Black'],
  ['2156-3CH','Austral Cable Elegance 3 Point High Kit'],
  ['2156-3CL','Austral Elegance 3 Point Cable Low Kit'],
  ['2156-3RH','Austral Elegance Rod 3 Point High Kit'],
  ['2156-BL','Austral Elegance Hinged Door Lock No Cylinder Black'],
  ['2156-EXT','Austral Wide Striker Plate For Elegance'],
  ['2157-3ADJ','Austral Elegance Adjustable 3 Point Rod Kit'],
  ['2158-WB','Austral Elegance PUSH2GO Hinged Door Lock White Birch'],
  ['2200-P','Whitco 2 x 5 Pin Cylinder K/Alike 10/Bag'],
  ['2202','Austral Pin Cylinder Key Alike Suits Ultimate Lock'],
  ['2204','Austral Pin Cylinder Key Alike Suits SD7 Elegance Lock 60mm'],
  ['2218-K01','Whitco 10 Disc Cylinder KEY01'],
  ['2218-K02','Whitco 10 Disc Cylinder KEY02'],
  ['2218-K03','Whitco 10 Disc Cylinder KEY03'],
  ['2218-K04','Whitco 10 Disc Cylinder KEY04'],
  ['2218-K05','Whitco 10 Disc Cylinder KEY05'],
  ['2219','Austral Wafer Cylinder With 3 Keys & Cylinder Screw'],
  ['2220','Whitco 2 x 5 Disc Cylinder K/Alike'],
  ['2221','Austral Wafer Cylinder K/A Bright Chrome'],
  ['2230','Whitco Screen Door Latch Black'],
  ['2250-BL','Whitco Slimline Patio Bolt Black'],
  ['2250-SP','Whitco Patio Bolt Silver'],
  ['2251-BL','Whitco Patio Bolt Black CYL4 Cylinder'],
  ['2255-BL','Multi Bolt Black'],
  ['2260-BL','Whitco 2 Part Sec Door Flush Bolt Black'],
  ['2267-BL','Whitco Servery Lock Black'],
  ['2300-BL','Whitco Hinge Door Closer 18kg Max Black'],
  ['2301-BL','Austral Hinge Door Closer 18kg Max Black Satin'],
  ['2302-BL','Austral Hinge Door Closer Heavy Duty Up To 26kg Black Satin'],
  ['2303-BL','Lockwood 403 Pneumatic Screen Door Closer 21kg Max Black'],
  ['2372-BL','Lockwood 404 Hydraulic Screen Door Closer Up To 29kg Black'],
  ['2375','Anthony Innovations Kwikfit Soft Closer Pack'],
  ['2380-BL','Inventco Sliding Door Closer Black'],
  ['2389','Magnetic Fly Door Latch'],
  ['2390','Whitco Bass Handles Std Strike Black'],
  ['2391','Whitco Bass Handle Snib Finger Plate Outpull'],
  ['2392','Sliding Screen Door Flush Outer Pull Plastic Black'],
  ['2400-BL','Security Door Hinges Black'],
  ['2401','Lockwood 316 Stainless Steel Security Door Hinge'],
  ['2402','Lockwood 316 Stainless Steel Security Door Hinge With Safety Prong'],
  ['2420','Hinge Packer 1mm Aluminium'],
  ['2449','30kg Snap Set Standard Security Door Roller'],
  ['2450','Auzfit Security Door Roller 25kg'],
  ['2451','Anthony Innovations 40kg Kwikfit Switch Heavy Duty Roller'],
  ['2498','Foam Spline 4.5mm x 700m Roll'],
  ['2499','Foam Spline 4.0mm x 870m Roll'],
  ['2500','Foam Spline 5.0mm x 550m Roll'],
  ['2501','Foam Spline 5.7mm x 450m Roll'],
  ['2502','Foam Spline 6.0mm x 400m Roll'],
  ['2503','Foam Spline 5.3mm x 500m Roll'],
  ['2504','Spline PVC Hollow 5mm x 300m Roll'],
  ['2506','Spline PVC Hollow 6.0mm x 300m Roll'],
  ['2510-FIRE-R100','ScreenGuard L Seat Only 100m/Roll'],
  ['2510-FIRE-W100','ScreenGuard Wedge Only 33 x 3m Pack'],
  ['2520','Spline Roller Heavy Duty'],
  ['2532','ScreenGuard Attenuation Plate 140x25mm Black Anodised'],
  ['2541','ScreenGuard Extreme Co-Ex Wedge & Insulator'],
  ['2590','Fringe Pile 11mm 400m Roll Black'],
  ['2600','Fringe Pile 13mm 350m Roll Black'],
  ['2610','Fringe Pile 16mm 300m Roll Black'],
  ['2620','Fringe Pile 28mm x 150m Black'],
  ['2650','Light Duty Sec Door Corner Stake Aluminium'],
  ['2651','Heavy Duty Sec Door Corner Stake Aluminium'],
  ['2652','Security Door Corner Stake Nylon'],
  ['2653','ScreenGuard Access Corner Stake To Suit AU03005'],
  ['2655','ScreenGuard Aluminium Corner Stake To Suit AU01001'],
  ['2656','ScreenGuard Aluminium Corner Stake To Suit AU01002/1006/1007/3001'],
  ['2657','ScreenGuard Aluminium Corner Stake 9mm Suits AU01003'],
  ['2659','ScreenGuard Nylon Corner Stake To Suit AU01001'],
  ['2660','Window Corner Stake Suits WF001'],
  ['2662','Window Corner Stake Suits WF002'],
  ['2663','Nylon Corner Stake To Suit WF001'],
  ['2673','Flyframe Corner Stake Plastic Suits HFF181 9mm Flyscreen'],
  ['2673-U','Undersized Corner Stake To Suit AU01001'],
  ['2675','Corner Stake Suits DT3020'],
  ['2679','ScreenGuard Corner Stake To Suit SG Extreme Window Frame'],
  ['2680','Flyframe Corner Stake Plastic Suits HFF180 11mm Flyscreen'],
  ['2682','Screen Retainer Clip Black 50/Pack'],
  ['2685','Door Top Guide Nylon Suit DF001/003/006'],
  ['2686','100mm Guide Button For Servery Track Canoe Clip 100/Bag'],
  ['2691','Build Out Corner Stake Suits DJ3250/3260'],
  ['2694','Pelmet Bracket Suits VT007 Bag of 50'],
  ['2700-BL','J Bead 2.75m Black'],
  ['2711-BL','Stop Bead 16mm x 13mm x 2.1m Black'],
  ['2711-BR','Stop Bead 16mm x 13mm x 2.1m Brown'],
  ['2711-PR','Stop Bead 16mm x 13mm x 2.1m Primrose'],
  ['2711-WH','Stop Bead 16mm x 13mm x 2.1m White'],
  ['2713-BL','Stop Bead 16mm x 13mm x 5.1m Black'],
  ['2713-BR','Stop Bead 16mm x 13mm x 5.1m Brown'],
  ['2713-PR','Stop Bead 16mm x 13mm x 5.1m Primrose'],
  ['2713-SB','Stop Bead 16mm x 13mm x 5.1m Stone Beige'],
  ['2713-WH','Stop Bead 16mm x 13mm x 5.1m White'],
  ['2721-BL','Stop Bead 16mm x 13mm x 3.0m Black'],
  ['2721-PR','Stop Bead 16mm x 13mm x 3.0m Primrose'],
  ['2721-SB','Stop Bead 16mm x 13mm x 3.0m Stone Beige'],
  ['2721-WH','Stop Bead 16mm x 13mm x 3.0m White'],
  ['2800','D Pulls PVC 11mm Bag 100'],
  ['2800-R','Round D Pulls PVC 11mm Bag 100'],
  ['2801','D Pulls PVC 9mm Bag 100'],
  ['2810-BL','Swivel Clips Black 1.6mm Bag 200'],
  ['2810-CA','Swivel Clips Clear 1.6mm Bag 200'],
  ['2811-BL','Swivel Clips Black 11mm 200pc/Bag'],
  ['2811-CA','Swivel Clips Clear 11mm'],
  ['2820','Spreader Bar Clips Suits HFF184'],
  ['2831-BL','Premium Flyscreen Port-Phoenix Access Window Black'],
  ['2835-BL','Pet Door Small 240 x 190mm Black'],
  ['2835-BR','Pet Door Small 240 x 190mm Brown'],
  ['2835-GLASS','Pet Door Small Glass 240 x 190mm Clear'],
  ['2835-PR','Pet Door Small 240 x 190mm Primrose'],
  ['2835-WH','Pet Door Small 240 x 190mm White'],
  ['2836','Small Pet Door L Bracket Suit 2835'],
  ['2838-BL','Pet Door Medium 305 x 225mm Black'],
  ['2838-PR','Pet Door Medium 305 x 225mm Primrose'],
  ['2838-SB','Pet Door Medium 305 x 225mm Stone Beige'],
  ['2838-WH','Pet Door Medium 305 x 225mm White'],
  ['2840-BL','Pet Door Large 400 x 260mm Black'],
  ['2840-PR','Pet Door Large 400 x 260mm Primrose'],
  ['2840-SB','Pet Door Large 400 x 260mm Stone Beige'],
  ['2840-WH','Pet Door Large 400 x 260mm White'],
  ['2841-BL','Hopper Hatch Black'],
  ['2842','Large Pet Door L Bracket Suit 2840'],
  ['2843','Pet Door Flexible Flap Small'],
  ['2844','Pet Door Flexible Flap Medium'],
  ['2845','Pet Door Flexible Flap Large'],
  ['2846','Flyscreen D-Pull And Plunger Bag 100'],
  ['2847','Double Hung Tab Bag 100'],
  ['2853','Plunger Pin Plastic 100/Bag Black'],
  ['2862','Security Door Top Guide To Suit 23.5mm'],
  ['2863','Security Door Top Guide To Suit 21.2mm Grey'],
  ['2901','Bench Mat 1.2m Width Per Mtr'],
  ['3110','Corner Stake For Gates & Shutters'],
  ['3113','Easy Picket Top Cap'],
  ['3114','Easy Picket Spacer Block'],
  ['3218','End Cap Picket Suit PIC003/PIC014'],
  ['3219','Corner Stake To Suit PIC009'],
  ['3222','Square Top Cap Suits PIC009/PIC010/PIC011'],
  ['3225','End Cap To Suit 150x50x3mm Hollow Tube'],
  ['3259','HarbourView Foam Tape Single Sided Black'],
  ['3301','Screenfold Pivot Assembly Set'],
  ['3302','Screenfold Bottom Guide'],
  ['3303','Screenfold Hanger'],
  ['3304','Screenfold Bi-Fold Barrel Bolt'],
  ['3305','Screenfold Hinge'],
  ['3306','Screenfold Handle Hinge'],
  ['3307','Screenfold Hanger'],
  ['3308','Screenfold Pivot'],
  ['3310','Screenfold Guide'],
  ['3313','Screenfold Intermediate Hanger'],
  ['3314','Maya Door Bolt L.140MM Black'],
  ['3315','Maya Door Bolt L.450MM Black'],
  ['3316','Maya Door Bolt L.600MM Black'],
  ['4100-BL','Austral Forge Security Lock Hinged Projection Bolt Black'],
  ['4150-BL','Austral Forge Sliding Security Door Lock Black'],
  ['4300-BL','Forge Hinged 2 Point 30mm Lock With Snib Kit Black'],
  ['4320-BL','Forge Hinged 4 Point 30mm Lock With Snib Kit Black'],
  ['4320-WH','Forge Hinged 4 Point 30mm Lock With Snib Kit White'],
  ['4710-SS','HarbourView Verta Bifold Single Access Non-Locking Stainless Steel'],
  ['4730-SS','HarbourView Verta Bifold Single Access Locking Stainless Steel'],
  ['4F-DB-PF050','Driver Bit Pentaforce 50mm'],
  ['4F-DB-PF150','Driver Bit Pentaforce 150mm'],
  ['4F-DB-RESY25','Driver Bit 25mm Resytork'],
  ['4F-DB225P','Driver Bit #2 x 25mm Phillips'],
  ['4F-DB250P','Driver Bit #2 x 50mm Phillips'],
  ['4F-SRC706','Hand Riveter Up To 4.8mm PRO-706'],
  ['4R-C64AS-MF','Rivet AS6-4 Countersunk Head Mill Finish 500/Box'],
  ['4R-D42AS-BL','Rivet AS4-2 Dome Head Black 1000/Box'],
  ['4R-D42AS-MF','Rivet AS4-2 Dome Head Mill Finish 1000/Box'],
  ['4R-D42AS-WH','Rivet AS4-2 Dome Head White 1000/Box'],
  ['4R-D43AS-MF','Rivet AS4-3 Dome Head Mill Finish 1000/Box'],
  ['4R-D44AS-BL','Rivet AS4-4 Dome Head Black 1000/Box'],
  ['4R-D44AS-MF','Rivet AS4-4 Dome Head Mill Finish 1000/Box'],
  ['4R-D44AS-PR','Rivet AS4-4 Dome Head Primrose 1000/Box'],
  ['4R-D44AS-WH','Rivet AS4-4 Dome Head White 1000/Box'],
  ['4R-D54AS-BL','Rivet AS5-4 Dome Head Black 1000/Box'],
  ['4R-D54AS-MF','Rivet AS5-4 Dome Head Mill Finish 1000/Box'],
  ['4R-D54AS-WH','Rivet AS5-4 Dome Head White 1000/Box'],
  ['4R-D64AS-MF','Rivet AS6-4 Dome Head Mill Finish 500/Box'],
  ['4S-BH0834NP-BL','Screw Black Button Head 8GX3/4" 1000/Box'],
  ['4S-BH0834NP-GAL','Screw Gal Button Head 8GX3/4" 1000/Box'],
  ['4S-CH0634ST-SS','Screw S/S Countersunk Head 6GX3/4" 1000/Box'],
  ['4S-CH0638ST-SS','Screw S/S Countersunk Head 6GX3/8" 1000/Box'],
  ['4S-CH081ST-SS','Screw S/S Countersunk Head 8GX1" 1000/Box'],
  ['4S-CH0825TH-ZI','Screw Zinc Countersunk Head 8GX25mm 1000/Box'],
  ['4S-CH1012UST-SS','Screw S/S Countersunk Head 10GX1/2" Undercut 1000/Box'],
  ['4S-FH1022SD-GAL','Screw Gal Flat Head 10GX22mm Self Drill 1000/Box'],
  ['4S-PFPH1809SD-G','ScreenGuard Screw Pentaforce Self Drill 8-18 x 9.5 GAL 1000/Box'],
  ['4S-PFPH1812SD-G','ScreenGuard Screw Pentaforce Self Drill 8-18 x 12.5 GAL 1000/Box'],
  ['4S-PFPH1825SD-G','ScreenGuard Screw Pentaforce Pan Head 8-18 x 25 GAL 1000/Box'],
  ['4S-PH06112ST-SS','Screw S/S Pan Head 6GX1.5" 1000/Box'],
  ['4S-PH0612ST-YZ','Screw Yellow Zinc Pan Head 6GX1/2" Self Drill 1000/Box'],
  ['4S-PH061ST-SS','Screw S/S Pan Head 6GX1" Self Tap 1000/Box'],
  ['4S-PH081ST-SS','Screw S/S Pan Head 8GX1" 200/Box'],
  ['4S-PH082ST-SS','Screw S/S Pan Head 8GX2" 200/Box'],
  ['4S-PH101ST-SS','Screw S/S Pan Head 10GX1" 1000/Box'],
  ['4S-PH103ST-SS','Screw S/S Pan Head 10GX3" 250/Box'],
  ['4S-RTB10112-YZ','Screw Resytork Yellow Zinc Button Head 10GX1-1/2 Type 17 1000/Box'],
  ['9956S','Legge Passage Set Kit Stainless Steel No Cylinder 30mm Backset'],
  ['O-1472','Foam Seal Suits 101.6mm Center Glazed 1050pcs/Roll'],
  ['PC5050','Pre-Drilled Concealed Post Connector 20 Bag'],
  ['SE9-4025','Patio Enclosure Brackets 40 Bag Suit SE001/002'],
  ['AN1212','Angle 12 x 12 x 1.6mm'],
  ['AN1225','Angle 12 x 25 x 1.6mm'],
  ['AN1240','Angle 12 x 40 x 1.6mm'],
  ['AN2012','Angle 20 x 12 x 1.6mm'],
  ['AN2020','Angle 20 x 20 x 1.6mm'],
  ['AN2025','Angle 20 x 25 x 1.6mm'],
  ['AN2032','Angle 20 x 32 x 1.6mm'],
  ['AN2040','Angle 20 x 40 x 1.6mm'],
  ['AN2525','Angle 25 x 25 x 1.6mm'],
  ['AN2532','Angle 25 x 32 x 1.6mm'],
  ['AN2540','Angle 25 x 40 x 1.6mm'],
  ['AN2550','Angle 25 x 50 x 1.6mm'],
  ['AN2570','Angle 25 x 70 x 1.6mm'],
  ['AN4040','Angle 40 x 40 x 1.6mm'],
  ['AN4070','Angle 40 x 70 x 1.5mm'],
  ['AN5050','Angle 50 x 50 x 1.6mm'],
  ['HAN2025','Angle 20 x 25 x 3mm'],
  ['HAN2032','Angle 20 x 32 x 3mm'],
  ['HAN2525','Angle 25 x 25 x 3mm'],
  ['HAN2540','Angle 25 x 40 x 3mm'],
  ['HAN2550','Angle 25 x 50 x 3mm'],
  ['HAN2570','Angle 25 x 70 x 3mm'],
  ['HAN3232','Angle 32 x 32 x 3mm'],
  ['HAN4040','Angle 40 x 40 x 3mm'],
  ['HAN5006','Angle 50 x 50 x 6mm'],
  ['HAN50100','Angle 50 x 100 x 3mm'],
  ['HAN5050','Angle 50 x 50 x 3mm'],
  ['CH2020T16','Channel 20 x 20 x 1.6mm'],
  ['CH3218','Glazing Channel 25 x 25 x 3mm'],
  ['CH3232','Glazing Channel 32 x 32 x 3mm'],
  ['CH3245','Glazing Channel 32 x 45 x 3mm'],
  ['CH4025T30','Channel 40 x 25 x 3mm'],
  ['FB10016','Flat Bar 100 x 1.6mm'],
  ['FB10030','Flat Bar 100 x 3mm'],
  ['FB1225','Flat Bar 12 x 2.5mm'],
  ['FB2030','Flat Bar 20 x 3mm'],
  ['FB2516','Flat Bar 25 x 1.6mm'],
  ['FB2530','Flat Bar 25 x 3mm'],
  ['FB3230','Flat Bar 32 x 3mm'],
  ['FB4016','Flat Bar 40 x 1.6mm'],
  ['FB4030','Flat Bar 40 x 3mm'],
  ['FB4060','Flat Bar 40 x 6mm'],
  ['FB5030','Flat Bar 50 x 3mm'],
  ['FB5060','Flat Bar 50 x 6mm'],
  ['FB6030','Flat Bar 60 x 3mm'],
  ['FB8030','Flat Bar 80 x 3mm'],
  ['RD16R12','Round Tube 16 x 1.2mm'],
  ['RD50R16','Round Tube 50 x 1.6mm'],
  ['SQ1919T16','Square Tube 19 x 19 x 1.6mm'],
  ['SQ2525T12','Square Tube 25 x 25 x 1.2mm'],
  ['SQ2525T16','Square Tube 25 x 25 x 1.6mm'],
  ['SQ2540T25','Rectangular Tube 40 x 25 x 2.5mm'],
  ['SQ2550T30','Square Tube 25 x 50 x 3mm'],
  ['SQ4040T16','Square Tube 40 x 40 x 1.6mm'],
  ['SQ4040T30','Square Tube 40 x 40 x 3mm'],
  ['SQ4080T30','Rectangular Tube 40 x 80 x 3mm'],
  ['SQ5050T16','Square Tube 50 x 50 x 1.6mm'],
  ['SQ5050T25','Square Tube 50 x 50 x 2.5mm'],
  ['SQ5050T30','Square Tube 50 x 50 x 3mm'],
  ['SQ5080T30','Rectangular Tube 50 x 80 x 3mm'],
  ['SQ10050T16','Square Tube 100 x 50 x 1.6mm'],
  ['SQ10050T30','Rectangular Tube 100 x 50 x 3mm'],
  ['SQ15050T30','Rectangular Tube 150 x 50 x 3mm'],
  ['SQ20050T30','Rectangular Tube 200 x 50 x 3mm'],
  ['SQ762254T24','Rectangular Tube 76.2 x 25.4 x 2.4mm'],
  ['SR1919T12','Square Tube Radius Edge 19 x 1.2mm'],
  ['SR2538T15','Rectangular Tube Radius Edge 38 x 25 x 1.5mm'],
  ['SR5050T20','Square Tube Radius Edge 50 x 2mm'],
  ['SR5050T30','Square Tube Radius Edge 50 x 3mm'],
];

// --- CommandeX Catalogue ---
// Entries: [code, description, colour]
const CX_COLOUR = {
  WH:'Pearl White',CB:'Custom Black',MF:'Mill Finish',MON:'Monument',SM:'Surf Mist',
  BZ:'Bronze Anodised',CA:'Clear Anodised',HB:'Hamersley Brown',SB:'Stone Beige',
  PBK:'Paperbark',PR:'Primrose',WB:'White Birch',WG:'Woodland Grey',US:'Ultra Silver',
  CG:'Charcoal',DO:'Deep Ocean',DU:'Dune',ADG:'Anodic Dark Grey',ANM:'Anodic Natural Matt',
  APO:'APO Grey',ASG:'Anotec Silver Grey',BASM:'Basalt Matt',JAS:'Jasper',
  IRONM:'Ironstone Matt',IRONS:'Ironstone Satin',ND:'Notre Dame Gloss',
  PPS:'Palladium Silver',SG:'Shale Grey',TEXB:'Textura Black',TEXMON:'Textura Monument',
  TEXSM:'Textura Surf Mist',TEXWH:'Textura White',WE:'Wood Effect',
};
const COMMANDEX_CATALOGUE = [
  // 007 Door Frames 6500mm
  ['007159BZ6500','007 Door Frame 6500mm','Bronze Anodised'],
  ['007159CA6500','007 Door Frame 6500mm','Clear Anodised'],
  ['007159CB6500','007 Door Frame 6500mm','Custom Black'],
  ['007159HB6500','007 Door Frame 6500mm','Hamersley Brown'],
  ['007159MF6500','007 Door Frame 6500mm','Mill Finish'],
  ['007159MON6500','007 Door Frame 6500mm','Monument'],
  ['007159PBK6500','007 Door Frame 6500mm','Paperbark'],
  ['007159PR6500','007 Door Frame 6500mm','Primrose'],
  ['007159SB6500','007 Door Frame 6500mm','Stone Beige'],
  ['007159SM6500','007 Door Frame 6500mm','Surf Mist'],
  ['007159US6500','007 Door Frame 6500mm','Ultra Silver'],
  ['007159WB6500','007 Door Frame 6500mm','White Birch'],
  ['007159WG6500','007 Door Frame 6500mm','Woodland Grey'],
  ['007159WH6500','007 Door Frame 6500mm','Pearl White'],
  // 007 Window Frames 11mm 6000mm
  ['007160BZ6000','007 Window Frame 11mm 6000mm','Bronze Anodised'],
  ['007160CA6000','007 Window Frame 11mm 6000mm','Clear Anodised'],
  ['007160CB6000','007 Window Frame 11mm 6000mm','Custom Black'],
  ['007160HB6000','007 Window Frame 11mm 6000mm','Hamersley Brown'],
  ['007160MF6000','007 Window Frame 11mm 6000mm','Mill Finish'],
  ['007160MON6000','007 Window Frame 11mm 6000mm','Monument'],
  ['007160PR6000','007 Window Frame 11mm 6000mm','Primrose'],
  ['007160SM6000','007 Window Frame 11mm 6000mm','Surf Mist'],
  ['007160WH6000','007 Window Frame 11mm 6000mm','Pearl White'],
  // 007 Window Frames 9mm 6000mm
  ['007161BZ6000','007 Window Frame 9mm 6000mm','Bronze Anodised'],
  ['007161CA6000','007 Window Frame 9mm 6000mm','Clear Anodised'],
  ['007161CB6000','007 Window Frame 9mm 6000mm','Custom Black'],
  ['007161MF6000','007 Window Frame 9mm 6000mm','Mill Finish'],
  ['007161PBK6000','007 Window Frame 9mm 6000mm','Paperbark'],
  ['007161SB6000','007 Window Frame 9mm 6000mm','Stone Beige'],
  ['007161SM6000','007 Window Frame 9mm 6000mm','Surf Mist'],
  ['007161WB6000','007 Window Frame 9mm 6000mm','White Birch'],
  ['007161WH6000','007 Window Frame 9mm 6000mm','Pearl White'],
  // 007 Grilles
  ['007Grille1250x2050CA','007 Grille 1250x2050','Clear Anodised'],
  ['007Grille1250x2050CB','007 Grille 1250x2050','Custom Black'],
  ['007Grille1250x2050PR','007 Grille 1250x2050','Primrose'],
  ['007Grille1250x2160MF','007 Grille 1250x2160','Mill Finish'],
  ['007Grille1250x2160US','007 Grille 1250x2160','Ultra Silver'],
  ['007Grille1250x2450BZ','007 Grille 1250x2450','Bronze Anodised'],
  ['007Grille1250x2450CB','007 Grille 1250x2450','Custom Black'],
  ['007Grille1250x2500MF','007 Grille 1250x2500','Mill Finish'],
  ['007Grille750x2050BZ','007 Grille 750x2050','Bronze Anodised'],
  ['007Grille750x2050CA','007 Grille 750x2050','Clear Anodised'],
  ['007Grille750x2050CB','007 Grille 750x2050','Custom Black'],
  ['007Grille750x2050MF','007 Grille 750x2050','Mill Finish'],
  ['007Grille750x2050MON','007 Grille 750x2050','Monument'],
  ['007Grille750x2050PR','007 Grille 750x2050','Primrose'],
  ['007Grille750x2050WH','007 Grille 750x2050','Pearl White'],
  ['007Grille750x2450CB','007 Grille 750x2450','Custom Black'],
  ['007Grille778x2100SB','007 Grille 778x2100','Stone Beige'],
  ['007Grille778x2495MF','007 Grille 778x2495','Mill Finish'],
  ['007Grille778x2495US','007 Grille 778x2495','Ultra Silver'],
  ['007Grille920x2050BZ','007 Grille 920x2050','Bronze Anodised'],
  ['007Grille920x2050CA','007 Grille 920x2050','Clear Anodised'],
  ['007Grille920x2050CB','007 Grille 920x2050','Custom Black'],
  ['007Grille920x2050PR','007 Grille 920x2050','Primrose'],
  ['007Grille920x2050WH','007 Grille 920x2050','Pearl White'],
  ['007Grille920x2450CB','007 Grille 920x2450','Custom Black'],
  ['007Grille945x2100MF','007 Grille 945x2100','Mill Finish'],
  ['007Grille945x2500MF','007 Grille 945x2500','Mill Finish'],
  ['007Grille945x2500US','007 Grille 945x2500','Ultra Silver'],
  ['007Grille945x2500WH','007 Grille 945x2500','Pearl White'],
  ['007stake9mm','007 Corner Window Stake 9mm',''],
  // 310 Door Frames 6500mm
  ['310159ADG6500','310 Door Frame 6500mm','Anodic Dark Grey'],
  ['310159ANM6500','310 Door Frame 6500mm','Anodic Natural'],
  ['310159APO6500','310 Door Frame 6500mm','APO Grey'],
  ['310159ASG6500','310 Door Frame 6500mm','Anotec Silver Grey'],
  ['310159BASM6500','310 Door Frame 6500mm','Basalt Matt'],
  ['310159BZ6500','310 Door Frame 6500mm','Bronze Anodised'],
  ['310159CA6500','310 Door Frame 6500mm','Clear Anodised'],
  ['310159CB6500','310 Door Frame 6500mm','Custom Black'],
  ['310159CBZ6500','310 Door Frame Centre Mount 6500mm','Bronze Anodised'],
  ['310159CCA6500','310 Door Frame Centre Mount 6500mm','Clear Anodised'],
  ['310159CCB6500','310 Door Frame Centre Mount 6500mm','Custom Black'],
  ['310159CG6500','310 Door Frame 6500mm','Charcoal'],
  ['310159CMF6500','310 Door Frame Centre Mount 6500mm','Mill Finish'],
  ['310159CMON6500','310 Door Frame Centre Mount 6500mm','Monument'],
  ['310159CWH6500','310 Door Frame Centre Mount 6500mm','Pearl White'],
  ['310159DO6500','310 Door Frame 6500mm','Deep Ocean'],
  ['310159DU6500','310 Door Frame 6500mm','Dune'],
  ['310159HB6500','310 Door Frame 6500mm','Hamersley Brown'],
  ['310159IRONM6500','310 Door Frame 6500mm','Ironstone Matt'],
  ['310159IRONS6500','310 Door Frame 6500mm','Ironstone Satin'],
  ['310159JAS6500','310 Door Frame 6500mm','Jasper'],
  ['310159MF6500','310 Door Frame 6500mm','Mill Finish'],
  ['310159MON6500','310 Door Frame 6500mm','Monument'],
  ['310159ND6500','310 Door Frame 6500mm','Notre Dame Gloss'],
  ['310159PBK6500','310 Door Frame 6500mm','Paperbark'],
  ['310159PPS6500','310 Door Frame 6500mm','Palladium Silver'],
  ['310159PR6500','310 Door Frame 6500mm','Primrose'],
  ['310159SB6500','310 Door Frame 6500mm','Stone Beige'],
  ['310159SG6500','310 Door Frame 6500mm','Shale Grey'],
  ['310159SM6500','310 Door Frame 6500mm','Surf Mist'],
  ['310159TEXB6500','310 Door Frame 6500mm','Textura Black'],
  ['310159TEXMON6500','310 Door Frame 6500mm','Textura Monument'],
  ['310159TEXSM6500','310 Door Frame 6500mm','Textura Surf Mist'],
  ['310159TEXWH6500','310 Door Frame 6500mm','Textura White'],
  ['310159US6500','310 Door Frame 6500mm','Ultra Silver'],
  ['310159WB6500','310 Door Frame 6500mm','White Birch'],
  ['310159WE6500','310 Door Frame 6500mm','Wood Effect'],
  ['310159WG6500','310 Door Frame 6500mm','Woodland Grey'],
  ['310159WH6500','310 Door Frame 6500mm','Pearl White'],
  // 310 Window Frames 11mm 6000mm
  ['310160ANM6000','310 Window Frame 11mm 6000mm','Anodic Natural'],
  ['310160BZ6000','310 Window Frame 11mm 6000mm','Bronze Anodised'],
  ['310160CA6000','310 Window Frame 11mm 6000mm','Clear Anodised'],
  ['310160CB6000','310 Window Frame 11mm 6000mm','Custom Black'],
  ['310160CG6000','310 Window Frame 11mm 6000mm','Charcoal'],
  ['310160DO6000','310 Window Frame 11mm 6000mm','Deep Ocean'],
  ['310160DU6000','310 Window Frame 11mm 6000mm','Dune'],
  ['310160HB6000','310 Window Frame 11mm 6000mm','Hamersley Brown'],
  ['310160MF6000','310 Window Frame 11mm 6000mm','Mill Finish'],
  ['310160MON6000','310 Window Frame 11mm 6000mm','Monument'],
  ['310160PBK6000','310 Window Frame 11mm 6000mm','Paperbark'],
  ['310160PPS6000','310 Window Frame 11mm 6000mm','Palladium Silver'],
  ['310160PR6000','310 Window Frame 11mm 6000mm','Primrose'],
  ['310160SB6000','310 Window Frame 11mm 6000mm','Stone Beige'],
  ['310160SM6000','310 Window Frame 11mm 6000mm','Surf Mist'],
  ['310160TEXB6000','310 Window Frame 11mm 6000mm','Textura Black'],
  ['310160TEXMON600','310 Window Frame 11mm 6000mm','Textura Monument'],
  ['310160TEXSM600','310 Window Frame 11mm 6000mm','Textura Surf Mist'],
  ['310160TEXWH600','310 Window Frame 11mm 6000mm','Textura White'],
  ['310160US6000','310 Window Frame 11mm 6000mm','Ultra Silver'],
  ['310160WB6000','310 Window Frame 11mm 6000mm','White Birch'],
  ['310160WE6000','310 Window Frame 11mm 6000mm','Wood Effect'],
  ['310160WG6000','310 Window Frame 11mm 6000mm','Woodland Grey'],
  ['310160WH6000','310 Window Frame 11mm 6000mm','Pearl White'],
  // 310 Window Frames 9mm 6000mm
  ['310161BZ6000','310 Window Frame 9mm 6000mm','Bronze Anodised'],
  ['310161CA6000','310 Window Frame 9mm 6000mm','Clear Anodised'],
  ['310161CB6000','310 Window Frame 9mm 6000mm','Custom Black'],
  ['310161HB6000','310 Window Frame 9mm 6000mm','Hamersley Brown'],
  ['310161MF6000','310 Window Frame 9mm 6000mm','Mill Finish'],
  ['310161MON6000','310 Window Frame 9mm 6000mm','Monument'],
  ['310161PBK6000','310 Window Frame 9mm 6000mm','Paperbark'],
  ['310161PPS6000','310 Window Frame 9mm 6000mm','Palladium Silver'],
  ['310161PR6000','310 Window Frame 9mm 6000mm','Primrose'],
  ['310161SB6000','310 Window Frame 9mm 6000mm','Stone Beige'],
  ['310161SM6000','310 Window Frame 9mm 6000mm','Surf Mist'],
  ['310161TEXB6000','310 Window Frame 9mm 6000mm','Textura Black'],
  ['310161TEXMON6000','310 Window Frame 9mm 6000mm','Textura Monument'],
  ['310161TEXSM6000','310 Window Frame 9mm 6000mm','Textura Surf Mist'],
  ['310161TEXWH6000','310 Window Frame 9mm 6000mm','Textura White'],
  ['310161US6000','310 Window Frame 9mm 6000mm','Ultra Silver'],
  ['310161WB6000','310 Window Frame 9mm 6000mm','White Birch'],
  ['310161WG6000','310 Window Frame 9mm 6000mm','Woodland Grey'],
  ['310161WH6000','310 Window Frame 9mm 6000mm','Pearl White'],
  // Midrail
  ['310138CB4000','Midrail 4000mm','Custom Black'],
  ['310138MF4000','Midrail 4000mm','Mill Finish'],
  // Stainless Mesh
  ['SM07501200','Stainless Mesh 750x1200',''],
  ['SM07502000','Stainless Mesh 750x2000',''],
  ['SM07502400','Stainless Mesh 750x2400',''],
  ['SM07503000','Stainless Mesh 750x3000',''],
  ['SM09001200','Stainless Mesh 900x1200',''],
  ['SM09001500','Stainless Mesh 900x1500',''],
  ['SM09002000','Stainless Mesh 900x2000',''],
  ['SM09002400','Stainless Mesh 900x2400',''],
  ['SM10001200','Stainless Mesh 1000x1200',''],
  ['SM10002000','Stainless Mesh 1000x2000',''],
  ['SM10002400','Stainless Mesh 1000x2400',''],
  ['SM12001200','Stainless Mesh 1200x1200',''],
  ['SM12002000','Stainless Mesh 1200x2000',''],
  ['SM12002400','Stainless Mesh 1200x2400',''],
  ['SM15002000','Stainless Mesh 1500x2000',''],
  ['SM15002400','Stainless Mesh 1500x2400',''],
  // Xceed Mesh
  ['XC07502000','Xceed 2.0mm Mesh 750x2000',''],
  ['XC07502400','Xceed 2.0mm Mesh 750x2400',''],
  ['XC09002000','Xceed 2.0mm Mesh 900x2000',''],
  ['XC09002400','Xceed 2.0mm Mesh 900x2400',''],
  ['XC12002000','Xceed 2.0mm Mesh 1200x2000',''],
  ['XC12002400','Xceed 2.0mm Mesh 1200x2400',''],
  ['XCPLUG','Xceed Plug 4m',''],
  // Bug Seal 24mm
  ['BugSealADG4.4m','Bug Seal 24mm 4.4m','Anodic Dark Grey'],
  ['BugSealANM4.4m','Bug Seal 24mm 4.4m','Anodic Natural Matt'],
  ['BugSealAPO4.4m','Bug Seal 24mm 4.4m','APO Grey'],
  ['BugSealBZ4.4m','Bug Seal 24mm 4.4m','Bronze Anodised'],
  ['BugSealCA4.4m','Bug Seal 24mm 4.4m','Clear Anodised'],
  ['BugSealCB4.4m','Bug Seal 24mm 4.4m','Custom Black'],
  ['BugSealCG4.4m','Bug Seal 24mm 4.4m','Charcoal'],
  ['BugSealDO4.4m','Bug Seal 24mm 4.4m','Deep Ocean'],
  ['BugSealHB4.4m','Bug Seal 24mm 4.4m','Hamersley Brown'],
  ['BugSealMF4.4m','Bug Seal 24mm 4.4m','Mill Finish'],
  ['BugSealMON4.4m','Bug Seal 24mm 4.4m','Monument'],
  ['BugSealPBK4.4m','Bug Seal 24mm 4.4m','Paperbark'],
  ['BugSealPPS4.4m','Bug Seal 24mm 4.4m','Palladium Silver'],
  ['BugSealPR4.4m','Bug Seal 24mm 4.4m','Primrose'],
  ['BugSealSB4.4m','Bug Seal 24mm 4.4m','Stone Beige'],
  ['BugSealSM4.4m','Bug Seal 24mm 4.4m','Surf Mist'],
  ['BugSealTEXB4.4m','Bug Seal 24mm 4.4m','Textura Black'],
  ['BugSealUS4.4m','Bug Seal 24mm 4.4m','Ultra Silver'],
  ['BugSealWB4.4m','Bug Seal 24mm 4.4m','White Birch'],
  ['BugSealWE4.4m','Bug Seal 24mm 4.4m','Wood Effect'],
  ['BugSealWG4.4m','Bug Seal 24mm 4.4m','Woodland Grey'],
  ['BugSealWH4.4m','Bug Seal 24mm 4.4m','Pearl White'],
  // Bug Seal 16mm
  ['BugSeal16mmANM4.4m','Bug Seal 16mm 4.4m','Anodic Natural Matt'],
  ['BugSeal16mmBZ4.4m','Bug Seal 16mm 4.4m','Bronze Anodised'],
  ['BugSeal16mmCA4.4m','Bug Seal 16mm 4.4m','Clear Anodised'],
  ['BugSeal16mmCB4.4m','Bug Seal 16mm 4.4m','Custom Black'],
  ['BugSeal16mmCG4.4m','Bug Seal 16mm 4.4m','Charcoal'],
  ['BugSeal16mmHB4.4m','Bug Seal 16mm 4.4m','Hamersley Brown'],
  ['BugSeal16mmMF4.4m','Bug Seal 16mm 4.4m','Mill Finish'],
  ['BugSeal16mmMON4.4m','Bug Seal 16mm 4.4m','Monument'],
  ['BugSeal16mmSB4.4m','Bug Seal 16mm 4.4m','Stone Beige'],
  ['BugSeal16mmSM4.4m','Bug Seal 16mm 4.4m','Surf Mist'],
  ['BugSeal16mmUS4.4m','Bug Seal 16mm 4.4m','Ultra Silver'],
  ['BugSeal16mmWB4.4m','Bug Seal 16mm 4.4m','White Birch'],
  ['BugSeal16mmWE4.4m','Bug Seal 16mm 4.4m','Wood Effect'],
  ['BugSeal16mmWG4.4m','Bug Seal 16mm 4.4m','Woodland Grey'],
  ['BugSeal16mmWH4.4m','Bug Seal 16mm 4.4m','Pearl White'],
  // F Interlock
  ['FInterlockADG4.85m','F Interlock 4.85m','Anodic Dark Grey'],
  ['FInterlockANM4.85m','F Interlock 4.85m','Anodic Natural Matt'],
  ['FInterlockBZ4.85m','F Interlock 4.85m','Bronze Anodised'],
  ['FInterlockCA4.85m','F Interlock 4.85m','Clear Anodised'],
  ['FInterlockCB4.85m','F Interlock 4.85m','Custom Black'],
  ['FInterlockCG4.85m','F Interlock 4.85m','Charcoal'],
  ['FInterlockDO4.85m','F Interlock 4.85m','Deep Ocean'],
  ['FInterlockHB4.85m','F Interlock 4.85m','Hamersley Brown'],
  ['FInterlockMF4.85m','F Interlock 4.85m','Mill Finish'],
  ['FInterlockMON4.85m','F Interlock 4.85m','Monument'],
  ['FInterlockPBK4.85m','F Interlock 4.85m','Paperbark'],
  ['FInterlockPPS4.85m','F Interlock 4.85m','Palladium Silver'],
  ['FInterlockPR4.85m','F Interlock 4.85m','Primrose'],
  ['FInterlockSB4.85m','F Interlock 4.85m','Stone Beige'],
  ['FInterlockSM4.85m','F Interlock 4.85m','Surf Mist'],
  ['FInterlockTEXB4.85m','F Interlock 4.85m','Textura Black'],
  ['FInterlockUS4.85m','F Interlock 4.85m','Ultra Silver'],
  ['FInterlockWB4.85m','F Interlock 4.85m','White Birch'],
  ['FInterlockWE4.85m','F Interlock 4.85m','Wood Effect'],
  ['FInterlockWG4.85m','F Interlock 4.85m','Woodland Grey'],
  ['FInterlockWH4.85m','F Interlock 4.85m','Pearl White'],
  // Interlock Flat
  ['InterlockFlatBZ4.85m','Interlock Flat 4.85m','Bronze Anodised'],
  ['InterlockFlatCA4.85m','Interlock Flat 4.85m','Clear Anodised'],
  ['InterlockFlatCB4.85m','Interlock Flat 4.85m','Custom Black'],
  ['InterlockFlatHB4.85m','Interlock Flat 4.85m','Hamersley Brown'],
  ['InterlockFlatMF4.85m','Interlock Flat 4.85m','Mill Finish'],
  ['InterlockFlatMON4.85m','Interlock Flat 4.85m','Monument'],
  ['InterlockFlatPPS4.4m','Interlock Flat 4.4m','Palladium Silver'],
  ['InterlockFlatPR4.4m','Interlock Flat 4.4m','Primrose'],
  ['InterlockFlatSB4.4m','Interlock Flat 4.4m','Stone Beige'],
  ['InterlockFlatSM4.85m','Interlock Flat 4.85m','Surf Mist'],
  ['InterlockFlatWE4.4m','Interlock Flat 4.4m','Wood Effect'],
  ['InterlockFlatWG4.4m','Interlock Flat 4.4m','Woodland Grey'],
  ['InterlockFlatWH4.85m','Interlock Flat 4.85m','Pearl White'],
  // Deep Offset Interlock
  ['OffsetInterlockDPADG4.4m','Deep Offset Interlock 4.4m','Anodic Dark Grey'],
  ['OffsetInterlockDPANM4.4m','Deep Offset Interlock 4.4m','Anodic Natural Matt'],
  ['OffsetInterlockDPBZ4.85m','Deep Offset Interlock 4.85m','Bronze Anodised'],
  ['OffsetInterlockDPCA4.4m','Deep Offset Interlock 4.4m','Clear Anodised'],
  ['OffsetInterlockDPCB4.85m','Deep Offset Interlock 4.85m','Custom Black'],
  ['OffsetInterlockDPHB4.85mLC','Deep Offset Interlock 4.85m','Hamersley Brown'],
  ['OffsetInterlockDPJAS4.4mLC','Deep Offset Interlock 4.4m','Jasper'],
  ['OffsetInterlockDPMF4.85m','Deep Offset Interlock 4.85m','Mill Finish'],
  ['OffsetInterlockDPMON4.85m','Deep Offset Interlock 4.85m','Monument'],
  ['OffsetInterlockDPPBK4.4m','Deep Offset Interlock 4.4m','Paperbark'],
  ['OffsetInterlockDPPPS4.4mLC','Deep Offset Interlock 4.4m','Palladium Silver'],
  ['OffsetInterlockDPPR4.85m','Deep Offset Interlock 4.85m','Primrose'],
  ['OffsetInterlockDPSB4.4m','Deep Offset Interlock 4.4m','Stone Beige'],
  ['OffsetInterlockDPSM4.85m','Deep Offset Interlock 4.85m','Surf Mist'],
  ['OffsetInterlockDPTEXB4.85m','Deep Offset Interlock 4.85m','Textura Black'],
  ['OffsetInterlockDPUS4.4m','Deep Offset Interlock 4.4m','Ultra Silver'],
  ['OffsetInterlockDPWB4.4m','Deep Offset Interlock 4.4m','White Birch'],
  ['OffsetInterlockDPWE4.4m','Deep Offset Interlock 4.4m','Wood Effect'],
  ['OffsetInterlockDPWG4.85m','Deep Offset Interlock 4.85m','Woodland Grey'],
  ['OffsetInterlockDPWH4.85m','Deep Offset Interlock 4.85m','Pearl White'],
  // Shallow Offset Interlock
  ['OffsetInterlockSHBZ4.85m','Shallow Offset Interlock 4.85m','Bronze Anodised'],
  ['OffsetInterlockSHCA4.85m','Shallow Offset Interlock 4.85m','Clear Anodised'],
  ['OffsetInterlockSHCB4.85m','Shallow Offset Interlock 4.85m','Custom Black'],
  ['OffsetInterlockSHHB4.85m','Shallow Offset Interlock 4.85m','Hamersley Brown'],
  ['OffsetInterlockSHMF4.85m','Shallow Offset Interlock 4.85m','Mill Finish'],
  ['OffsetInterlockSHMON4.85m','Shallow Offset Interlock 4.85m','Monument'],
  ['OffsetInterlockSHPBK4.4m','Shallow Offset Interlock 4.4m','Paperbark'],
  ['OffsetInterlockSHPR4.85m','Shallow Offset Interlock 4.85m','Primrose'],
  ['OffsetInterlockSHSM4.85m','Shallow Offset Interlock 4.85m','Surf Mist'],
  ['OffsetInterlockSHUS4.85m','Shallow Offset Interlock 4.85m','Ultra Silver'],
  ['OffsetInterlockSHWE4.4m','Shallow Offset Interlock 4.4m','Wood Effect'],
  ['OffsetInterlockSHWG4.4m','Shallow Offset Interlock 4.4m','Woodland Grey'],
  ['OffsetInterlockSHWH4.85m','Shallow Offset Interlock 4.85m','Pearl White'],
  // Fly Frame 9mm
  ['FlyFme22x9mmADG500','Fly Frame 9mm 5000mm','Anodic Dark Grey'],
  ['FlyFme22x9mmANM500','Fly Frame 9mm 5000mm','Anodic Natural Matt'],
  ['FlyFme22x9mmBZ500','Fly Frame 9mm 5000mm','Bronze Anodised'],
  ['FlyFme22x9mmCA500','Fly Frame 9mm 5000mm','Clear Anodised'],
  ['FlyFme22x9mmCB500','Fly Frame 9mm 5000mm','Custom Black'],
  ['FlyFme22x9mmHB500','Fly Frame 9mm 5000mm','Hamersley Brown'],
  ['FlyFme22x9mmMF500','Fly Frame 9mm 5000mm','Mill Finish'],
  ['FlyFme22x9mmMON500','Fly Frame 9mm 5000mm','Monument'],
  ['FlyFme22x9mmPBK500','Fly Frame 9mm 5000mm','Paperbark'],
  ['FlyFme22x9mmPR500','Fly Frame 9mm 5000mm','Primrose'],
  ['FlyFme22x9mmSB500','Fly Frame 9mm 5000mm','Stone Beige'],
  ['FlyFme22x9mmSM500','Fly Frame 9mm 5000mm','Surf Mist'],
  ['FlyFme22x9mmTEXB500','Fly Frame 9mm 5000mm','Textura Black'],
  ['FlyFme22x9mmUS500','Fly Frame 9mm 5000mm','Ultra Silver'],
  ['FlyFme22x9mmWB500','Fly Frame 9mm 5000mm','White Birch'],
  ['FlyFme22x9mmWG500','Fly Frame 9mm 5000mm','Woodland Grey'],
  ['FlyFme22x9mmWH500','Fly Frame 9mm 5000mm','Pearl White'],
  // Fly Frame 11mm
  ['FlyFme25x11mmADG500','Fly Frame 11mm 5000mm','Anodic Dark Grey'],
  ['FlyFme25x11mmANM500','Fly Frame 11mm 5000mm','Anodic Natural Matt'],
  ['FlyFme25x11mmBZ500','Fly Frame 11mm 5000mm','Bronze Anodised'],
  ['FlyFme25x11mmCA500','Fly Frame 11mm 5000mm','Clear Anodised'],
  ['FlyFme25x11mmCB500','Fly Frame 11mm 5000mm','Custom Black'],
  ['FlyFme25x11mmCG500','Fly Frame 11mm 5000mm','Charcoal'],
  ['FlyFme25x11mmHB500','Fly Frame 11mm 5000mm','Hamersley Brown'],
  ['FlyFme25x11mmMF500','Fly Frame 11mm 5000mm','Mill Finish'],
  ['FlyFme25x11mmMON500','Fly Frame 11mm 5000mm','Monument'],
  ['FlyFme25x11mmPBK500','Fly Frame 11mm 5000mm','Paperbark'],
  ['FlyFme25x11mmPR500','Fly Frame 11mm 5000mm','Primrose'],
  ['FlyFme25x11mmSB500','Fly Frame 11mm 5000mm','Stone Beige'],
  ['FlyFme25x11mmSM500','Fly Frame 11mm 5000mm','Surf Mist'],
  ['FlyFme25x11mmTEXB500','Fly Frame 11mm 5000mm','Textura Black'],
  ['FlyFme25x11mmUS500','Fly Frame 11mm 5000mm','Ultra Silver'],
  ['FlyFme25x11mmWB500','Fly Frame 11mm 5000mm','White Birch'],
  ['FlyFme25x11mmWG500','Fly Frame 11mm 5000mm','Woodland Grey'],
  ['FlyFme25x11mmWH500','Fly Frame 11mm 5000mm','Pearl White'],
  // H Receiver Shallow
  ['HReceiverShallowBZ6.5m','H Receiver Shallow 6500mm','Bronze Anodised'],
  ['HReceiverShallowCA6.5m','H Receiver Shallow 6500mm','Clear Anodised'],
  ['HReceiverShallowCB6.5m','H Receiver Shallow 6500mm','Custom Black'],
  ['HReceiverShallowCG6.5m','H Receiver Shallow 6500mm','Charcoal'],
  ['HReceiverShallowMF6.5m','H Receiver Shallow 6500mm','Mill Finish'],
  ['HReceiverShallowMON6.5m','H Receiver Shallow 6500mm','Monument'],
  ['HReceiverShallowND6.5m','H Receiver Shallow 6500mm','Notre Dame Gloss'],
  ['HReceiverShallowPPS6.5m','H Receiver Shallow 6500mm','Palladium Silver'],
  ['HReceiverShallowPR6.5m','H Receiver Shallow 6500mm','Primrose'],
  ['HReceiverShallowSM6.5m','H Receiver Shallow 6500mm','Surf Mist'],
  ['HReceiverShallowUS6.5m','H Receiver Shallow 6500mm','Ultra Silver'],
  ['HReceiverShallowWE6.5m','H Receiver Shallow 6500mm','Wood Effect'],
  ['HReceiverShallowWG6.5m','H Receiver Shallow 6500mm','Woodland Grey'],
  ['HReceiverShallowWH6.5m','H Receiver Shallow 6500mm','Pearl White'],
  // Jamb Adaptor Long
  ['JambADPTLongBZ6.0m','Jamb Adaptor Long 6000mm','Bronze Anodised'],
  ['JambADPTLongCA6.0m','Jamb Adaptor Long 6000mm','Clear Anodised'],
  ['JambADPTLongCB6.0m','Jamb Adaptor Long 6000mm','Custom Black'],
  ['JambADPTLongHB5.4m','Jamb Adaptor Long 5400mm','Hamersley Brown'],
  ['JambADPTLongMF6.0m','Jamb Adaptor Long 6000mm','Mill Finish'],
  ['JambADPTLongMON6.0m','Jamb Adaptor Long 6000mm','Monument'],
  ['JambADPTLongPR6.0m','Jamb Adaptor Long 6000mm','Primrose'],
  ['JambADPTLongSM6.0m','Jamb Adaptor Long 6000mm','Surf Mist'],
  ['JambADPTLongUS5.4m','Jamb Adaptor Long 5400mm','Ultra Silver'],
  ['JambADPTLongWB6.0m','Jamb Adaptor Long 6000mm','White Birch'],
  ['JambADPTLongWE6.0m','Jamb Adaptor Long 6000mm','Wood Effect'],
  ['JambADPTLongWG6.0m','Jamb Adaptor Long 6000mm','Woodland Grey'],
  ['JambADPTLongWH6.0m','Jamb Adaptor Long 6000mm','Pearl White'],
  // Jamb Adaptor Short
  ['JambADPTShortADG5.4m','Jamb Adaptor Short 5400mm','Anodic Dark Grey'],
  ['JambADPTShortANM5.4m','Jamb Adaptor Short 5400mm','Anodic Natural Matt'],
  ['JambADPTShortCA5.4m','Jamb Adaptor Short 5400mm','Clear Anodised'],
  ['JambADPTShortCB5.4m','Jamb Adaptor Short 5400mm','Custom Black'],
  ['JambADPTShortDU5.4m','Jamb Adaptor Short 5400mm','Dune'],
  ['JambADPTShortHB5.4m','Jamb Adaptor Short 5400mm','Hamersley Brown'],
  ['JambADPTShortMF5.4m','Jamb Adaptor Short 5400mm','Mill Finish'],
  ['JambADPTShortMON5.4m','Jamb Adaptor Short 5400mm','Monument'],
  ['JambADPTShortPPS5.4m','Jamb Adaptor Short 5400mm','Palladium Silver'],
  ['JambADPTShortPR5.4m','Jamb Adaptor Short 5400mm','Primrose'],
  ['JambADPTShortSB5.4m','Jamb Adaptor Short 5400mm','Stone Beige'],
  ['JambADPTShortSM5.4m','Jamb Adaptor Short 5400mm','Surf Mist'],
  ['JambADPTShortTEXB5.4m','Jamb Adaptor Short 5400mm','Textura Black'],
  ['JambADPTShortUS5.4m','Jamb Adaptor Short 5400mm','Ultra Silver'],
  ['JambADPTShortWB5.4m','Jamb Adaptor Short 5400mm','White Birch'],
  ['JambADPTShortWH5.4m','Jamb Adaptor Short 5400mm','Pearl White'],
  // Sill Track
  ['SillTrackBZ4.2m','Sill Track 4200mm','Bronze Anodised'],
  ['SillTrackCA4.2m','Sill Track 4200mm','Clear Anodised'],
  ['SillTrackCB4.2m','Sill Track 4200mm','Custom Black'],
  ['SillTrackDO4.2m','Sill Track 4200mm','Deep Ocean'],
  ['SillTrackDU4.2m','Sill Track 4200mm','Dune'],
  ['SillTrackHB4.2m','Sill Track 4200mm','Hamersley Brown'],
  ['SillTrackJAS4.2m','Sill Track 4200mm','Jasper'],
  ['SillTrackMF4.2m','Sill Track 4200mm','Mill Finish'],
  ['SillTrackMON4.2m','Sill Track 4200mm','Monument'],
  ['SillTrackPBK4.2m','Sill Track 4200mm','Paperbark'],
  ['SillTrackPR4.2m','Sill Track 4200mm','Primrose'],
  ['SillTrackSB4.2m','Sill Track 4200mm','Stone Beige'],
  ['SillTrackSM4.2m','Sill Track 4200mm','Surf Mist'],
  ['SillTrackUS4.2m','Sill Track 4200mm','Ultra Silver'],
  ['SillTrackWB4.2m','Sill Track 4200mm','White Birch'],
  ['SillTrackWE4.2m','Sill Track 4200mm','Wood Effect'],
  ['SillTrackWH4.2m','Sill Track 4200mm','Pearl White'],
  // Slide Track Top/Bottom
  ['SlideTrackTopBtmBZ6.5m','Slide Track Top/Bottom 6500mm','Bronze Anodised'],
  ['SlideTrackTopBtmCA6.5m','Slide Track Top/Bottom 6500mm','Clear Anodised'],
  ['SlideTrackTopBtmCB6.5m','Slide Track Top/Bottom 6500mm','Custom Black'],
  ['SlideTrackTopBtmDO6.5m','Slide Track Top/Bottom 6500mm','Deep Ocean'],
  ['SlideTrackTopBtmDU6.5m','Slide Track Top/Bottom 6500mm','Dune'],
  ['SlideTrackTopBtmHB6.5m','Slide Track Top/Bottom 6500mm','Hamersley Brown'],
  ['SlideTrackTopBtmMF6.5m','Slide Track Top/Bottom 6500mm','Mill Finish'],
  ['SlideTrackTopBtmMON6.5m','Slide Track Top/Bottom 6500mm','Monument'],
  ['SlideTrackTopBtmPR6.5m','Slide Track Top/Bottom 6500mm','Primrose'],
  ['SlideTrackTopBtmSB6.5m','Slide Track Top/Bottom 6500mm','Stone Beige'],
  ['SlideTrackTopBtmSM6.5m','Slide Track Top/Bottom 6500mm','Surf Mist'],
  ['SlideTrackTopBtmTEXB6.5m','Slide Track Top/Bottom 6500mm','Textura Black'],
  ['SlideTrackTopBtmUS6.5m','Slide Track Top/Bottom 6500mm','Ultra Silver'],
  ['SlideTrackTopBtmWB6.5m','Slide Track Top/Bottom 6500mm','White Birch'],
  ['SlideTrackTopBtmWG6.5m','Slide Track Top/Bottom 6500mm','Woodland Grey'],
  ['SlideTrackTopBtmWH6.5m','Slide Track Top/Bottom 6500mm','Pearl White'],
  // U Channel
  ['UChannelADG25x20x6.3m','U Channel 25x20 6300mm','Anodic Dark Grey'],
  ['UChannelANM25x20x6.3m','U Channel 25x20 6300mm','Anodic Natural Matt'],
  ['UChannelBZ25x20x6.3m','U Channel 25x20 6300mm','Bronze Anodised'],
  ['UChannelCA25x20x6.3m','U Channel 25x20 6300mm','Clear Anodised'],
  ['UChannelCB25x20x6.3m','U Channel 25x20 6300mm','Custom Black'],
  ['UChannelDU25x20x6.3m','U Channel 25x20 6300mm','Dune'],
  ['UChannelHB25x20x6.3m','U Channel 25x20 6300mm','Hamersley Brown'],
  ['UChannelJAS25x20x6.3m','U Channel 25x20 6300mm','Jasper'],
  ['UChannelMF25x20x6.3m','U Channel 25x20 6300mm','Mill Finish'],
  ['UChannelMON25x20x6.3m','U Channel 25x20 6300mm','Monument'],
  ['UChannelND25x20x6.3m','U Channel 25x20 6300mm','Notre Dame Gloss'],
  ['UChannelPBK25x20x6.3m','U Channel 25x20 6300mm','Paperbark'],
  ['UChannelPPS25x20x6.3m','U Channel 25x20 6300mm','Palladium Silver'],
  ['UChannelPR25x20x6.3m','U Channel 25x20 6300mm','Primrose'],
  ['UChannelSM25x20x6.3m','U Channel 25x20 6300mm','Surf Mist'],
  ['UChannelUS25x20x6.3m','U Channel 25x20 6300mm','Ultra Silver'],
  ['UChannelWB25x20x6.3m','U Channel 25x20 6300mm','White Birch'],
  ['UChannelWE25x20x6.3m','U Channel 25x20 6300mm','Wood Effect'],
  ['UChannelWG25x20x6.3m','U Channel 25x20 6300mm','Woodland Grey'],
  ['UChannelWH25x20x6.3m','U Channel 25x20 6300mm','Pearl White'],
  // Xcell posts and hardware
  ['XPEndPostMF6500','Xcell End Post 6500mm','Mill Finish'],
  ['XPEndPostMON','Xcell End Post 6500mm','Monument'],
  ['XPEndPostSM','Xcell End Post 6500mm','Surf Mist'],
  ['XPEndPostTEXB','Xcell End Post 6500mm','Textura Black'],
  ['XPEndPostWE','Xcell End Post 6500mm','Wood Effect'],
  ['XPEndPostWG','Xcell End Post 6500mm','Woodland Grey'],
  ['XPEndPostWH','Xcell End Post 6500mm','Pearl White'],
  ['XPEndPostIRONM','Xcell End Post 6500mm','Ironstone Matt'],
  ['XPCornerPostMF','Xcell Corner Post 6500mm','Mill Finish'],
  ['XPCornerPostWE','Xcell Corner Post 6500mm','Wood Effect'],
  ['XPCornerPostWH','Xcell Corner Post 6500mm','Pearl White'],
  ['XPSQ44x1.5WEConCntrePost','Xcell SQ44 Centre Post 6500mm','Wood Effect'],
  ['XPSQ44x1.5WGConCntrePost','Xcell SQ44 Centre Post 6500mm','Woodland Grey'],
  ['XPSQ44x1.5WHConCntrePost','Xcell SQ44 Centre Post 6500mm','Pearl White'],
  ['XPSQ50x2MFGateFrame','Xcell SQ50 Gate Frame 6500mm','Mill Finish'],
  ['XPSQ50x2MONGateFrame','Xcell SQ50 Gate Frame 6500mm','Monument'],
  ['XPSQ50x2SMGateFrame','Xcell SQ50 Gate Frame 6500mm','Surf Mist'],
  ['XPSQ50x2TEXBGateFrame','Xcell SQ50 Gate Frame 6500mm','Textura Black'],
  ['XPSQ50x2WEGateFrame','Xcell SQ50 Gate Frame 6500mm','Wood Effect'],
  ['XPSQ50x2WGGateFrame','Xcell SQ50 Gate Frame 6500mm','Woodland Grey'],
  ['XPSQ50x2WHGateFrame','Xcell SQ50 Gate Frame 6500mm','Pearl White'],
  ['XPSQ50x5CGGatePost','Xcell SQ50x5mm Gate Post 6500mm','Charcoal'],
  ['XPSQ50x5MFGatePost','Xcell SQ50x5mm Gate Post 6500mm','Mill Finish'],
  ['XPSQ50x5MONGatePost','Xcell SQ50x5mm Gate Post 6500mm','Monument'],
  ['XPSQ50x5SMGatePost','Xcell SQ50x5mm Gate Post 6500mm','Surf Mist'],
  ['XPSQ50x5TEXBGatePost','Xcell SQ50x5mm Gate Post 6500mm','Textura Black'],
  ['XPSQ50x5WEGatePost','Xcell SQ50x5mm Gate Post 6500mm','Wood Effect'],
  ['XPSQ50x5WGGatePost','Xcell SQ50x5mm Gate Post 6500mm','Woodland Grey'],
  ['XPSQ50x5WHGatePost','Xcell SQ50x5mm Gate Post 6500mm','Pearl White'],
  // Xcell Slats
  ['XPRH65x16SlatCG1.2mm','Xcell RH65x16 Slat 6500mm','Charcoal'],
  ['XPRH65x16SlatIRONM1.2mm','Xcell RH65x16 Slat 6500mm','Ironstone Matt'],
  ['XPRH65x16SlatMF1.2mm','Xcell RH65x16 Slat 6500mm','Mill Finish'],
  ['XPRH65x16SlatMON1.2mm','Xcell RH65x16 Slat 6500mm','Monument'],
  ['XPRH65x16SlatPR1.2mm','Xcell RH65x16 Slat 6500mm','Primrose'],
  ['XPRH65x16SlatSM1.2mm','Xcell RH65x16 Slat 6500mm','Surf Mist'],
  ['XPRH65x16SlatTEXB1.2mm','Xcell RH65x16 Slat 6500mm','Textura Black'],
  ['XPRH65x16SlatWE1.2mm','Xcell RH65x16 Slat 6500mm','Wood Effect'],
  ['XPRH65x16SlatWG1.2mm','Xcell RH65x16 Slat 6500mm','Woodland Grey'],
  ['XPRH65x16SlatWH1.2mm','Xcell RH65x16 Slat 6500mm','Pearl White'],
  // Xcell Conceal Fix
  ['XPConFixChannelCG','Xcell Conceal Fix Channel 6500mm','Charcoal'],
  ['XPConFixChannelMF','Xcell Conceal Fix Channel 6500mm','Mill Finish'],
  ['XPConFixChannelMON','Xcell Conceal Fix Channel 6500mm','Monument'],
  ['XPConFixChannelSM','Xcell Conceal Fix Channel 6500mm','Surf Mist'],
  ['XPConFixChannelTEXB','Xcell Conceal Fix Channel 6500mm','Textura Black'],
  ['XPConFixChannelWE','Xcell Conceal Fix Channel 6500mm','Wood Effect'],
  ['XPConFixChannelWG','Xcell Conceal Fix Channel 6500mm','Woodland Grey'],
  ['XPConFixChannelWH','Xcell Conceal Fix Channel 6500mm','Pearl White'],
  ['XPConFixCoverCG','Xcell Conceal Fix Cover 6500mm','Charcoal'],
  ['XPConFixCoverMF','Xcell Conceal Fix Cover 6500mm','Mill Finish'],
  ['XPConFixCoverMON','Xcell Conceal Fix Cover 6500mm','Monument'],
  ['XPConFixCoverSM','Xcell Conceal Fix Cover 6500mm','Surf Mist'],
  ['XPConFixCoverTEXB','Xcell Conceal Fix Cover 6500mm','Textura Black'],
  ['XPConFixCoverWE','Xcell Conceal Fix Cover 6500mm','Wood Effect'],
  ['XPConFixCoverWG','Xcell Conceal Fix Cover 6500mm','Woodland Grey'],
  ['XPConFixCoverWH','Xcell Conceal Fix Cover 6500mm','Pearl White'],
  // Base Plates
  ['XPBasePlateCG100x100PreD','Xcell Base Plate 100x100 Pre-Drill','Charcoal'],
  ['XPBasePlateMF100x100PreD','Xcell Base Plate 100x100 Pre-Drill','Mill Finish'],
  ['XPBasePlateMON100x100PreD','Xcell Base Plate 100x100 Pre-Drill','Monument'],
  ['XPBasePlateTEXB100x100PreD','Xcell Base Plate 100x100 Pre-Drill','Textura Black'],
  ['XPBasePlateWE100x100PreD','Xcell Base Plate 100x100 Pre-Drill','Wood Effect'],
  ['XPBasePlateWG100x100PreD','Xcell Base Plate 100x100 Pre-Drill','Woodland Grey'],
  ['XPBasePlateWH100x100PreD','Xcell Base Plate 100x100 Pre-Drill','Pearl White'],
  ['XPBasePlateDynoBolt','Xcell Base Plate Dyno Bolt',''],
  ['XPBasePlateScrew','Xcell Base Plate Screw (box)',''],
  // Angles
  ['Angle12x12x1.6CB','Angle 12x12x1.6','Custom Black'],
  ['Angle12x12x1.6MF','Angle 12x12x1.6','Mill Finish'],
  ['Angle12x12x1.6MON','Angle 12x12x1.6','Monument'],
  ['Angle12x12x1.6SM','Angle 12x12x1.6','Surf Mist'],
  ['Angle12x12x1.6US','Angle 12x12x1.6','Ultra Silver'],
  ['Angle12x12x1.6WH','Angle 12x12x1.6','Pearl White'],
  ['Angle12x12x1.6WB','Angle 12x12x1.6','White Birch'],
  ['Angle12x12x1.6WE','Angle 12x12x1.6','Wood Effect'],
  ['Angle12x12x1.6PPS','Angle 12x12x1.6','Palladium Silver'],
  ['Angle12x20x1.6BZ6500','Angle 12x20x1.6 6500mm','Bronze Anodised'],
  ['Angle12x20x1.6CA6500','Angle 12x20x1.6 6500mm','Clear Anodised'],
  ['Angle12x20x1.6CB6500','Angle 12x20x1.6 6500mm','Custom Black'],
  ['Angle12x20x1.6CG','Angle 12x20x1.6','Charcoal'],
  ['Angle12x20x1.6DO','Angle 12x20x1.6','Deep Ocean'],
  ['Angle12x20x1.6DU','Angle 12x20x1.6','Dune'],
  ['Angle12x20x1.6MF6500','Angle 12x20x1.6 6500mm','Mill Finish'],
  ['Angle12x20x1.6MON6500','Angle 12x20x1.6 6500mm','Monument'],
  ['Angle12x20x1.6PBK','Angle 12x20x1.6','Paperbark'],
  ['Angle12x20x1.6SM','Angle 12x20x1.6','Surf Mist'],
  ['Angle12x20x1.6US','Angle 12x20x1.6','Ultra Silver'],
  ['Angle12x20x1.6WE','Angle 12x20x1.6','Wood Effect'],
  ['Angle12x20x1.6WG','Angle 12x20x1.6','Woodland Grey'],
  ['Angle12x20x1.6WH6500','Angle 12x20x1.6 6500mm','Pearl White'],
  ['Angle20x40x1.6BZ6500','Angle 20x40x1.6 6500mm','Bronze Anodised'],
  ['Angle20x40x1.6CA6500','Angle 20x40x1.6 6500mm','Clear Anodised'],
  ['Angle20x40x1.6CB6500','Angle 20x40x1.6 6500mm','Custom Black'],
  ['Angle20x40x1.6CG','Angle 20x40x1.6','Charcoal'],
  ['Angle20x40x1.6HB','Angle 20x40x1.6','Hamersley Brown'],
  ['Angle20x40x1.6MF6500','Angle 20x40x1.6 6500mm','Mill Finish'],
  ['Angle20x40x1.6MON6500','Angle 20x40x1.6 6500mm','Monument'],
  ['Angle20x40x1.6PBK','Angle 20x40x1.6','Paperbark'],
  ['Angle20x40x1.6PPS','Angle 20x40x1.6','Palladium Silver'],
  ['Angle20x40x1.6PR','Angle 20x40x1.6','Primrose'],
  ['Angle20x40x1.6SB','Angle 20x40x1.6','Stone Beige'],
  ['Angle20x40x1.6SM6500','Angle 20x40x1.6 6500mm','Surf Mist'],
  ['Angle20x40x1.6US','Angle 20x40x1.6','Ultra Silver'],
  ['Angle20x40x1.6WE','Angle 20x40x1.6','Wood Effect'],
  ['Angle20x40x1.6WG6500','Angle 20x40x1.6 6500mm','Woodland Grey'],
  ['Angle20x40x1.6WH6500','Angle 20x40x1.6 6500mm','Pearl White'],
  ['Angle20x40x1.6ANM','Angle 20x40x1.6','Anodic Natural Matt'],
  ['Angle20x40x1.6APO','Angle 20x40x1.6','APO Grey'],
  // RH sections
  ['RH25x38CB1.6x6500','RH25x38 1.6mm 6500mm','Custom Black'],
  ['RH25x38MF1.6x6500','RH25x38 1.6mm 6500mm','Mill Finish'],
  ['RH25x38TEXB1.2x6500','RH25x38 1.2mm 6500mm','Textura Black'],
  ['RH25x38WH1.6x6500','RH25x38 1.6mm 6500mm','Pearl White'],
  ['RH25x50CB1.6x6500','RH25x50 1.6mm 6500mm','Custom Black'],
  ['RH25x50MF1.6x6500','RH25x50 1.6mm 6500mm','Mill Finish'],
  ['RH25x50MON1.6x6500','RH25x50 1.6mm 6500mm','Monument'],
  ['RH25x50SM1.6x6500','RH25x50 1.6mm 6500mm','Surf Mist'],
  ['RH25x50WH1.6x6500','RH25x50 1.6mm 6500mm','Pearl White'],
  ['RH25x50BZ1.6x6500','RH25x50 1.6mm 6500mm','Bronze Anodised'],
  ['RH25x50CA1.6x6500','RH25x50 1.6mm 6500mm','Clear Anodised'],
  ['RH25x50HB1.6x6500','RH25x50 1.6mm 6500mm','Hamersley Brown'],
  ['RH25x50WB1.6x6500','RH25x50 1.6mm 6500mm','White Birch'],
  ['RH25x50WG1.6x6500','RH25x50 1.6mm 6500mm','Woodland Grey'],
  ['RH25x50WE1.6x6500','RH25x50 1.6mm 6500mm','Wood Effect'],
  ['RH25x76x2.0MF6500','RH25x76 2.0mm 6500mm','Mill Finish'],
  ['RH25x76x2.0WH6500','RH25x76 2.0mm 6500mm','Pearl White'],
  // SQH sections
  ['SQH19x19CB1.6x6500','SQH19x19 1.6mm 6500mm','Custom Black'],
  ['SQH19x19MF1.6x6500','SQH19x19 1.6mm 6500mm','Mill Finish'],
  ['SQH19x19MON1.6x6500','SQH19x19 1.6mm 6500mm','Monument'],
  ['SQH19x19WH1.6x6500','SQH19x19 1.6mm 6500mm','Pearl White'],
  ['SQH19x19WG1.6x6500','SQH19x19 1.6mm 6500mm','Woodland Grey'],
  ['SQH25x25BZ1.6x6500','SQH25x25 1.6mm 6500mm','Bronze Anodised'],
  ['SQH25x25CA1.6x6500','SQH25x25 1.6mm 6500mm','Clear Anodised'],
  ['SQH25x25CB1.6x6500','SQH25x25 1.6mm 6500mm','Custom Black'],
  ['SQH25x25MF1.6x6500','SQH25x25 1.6mm 6500mm','Mill Finish'],
  ['SQH25x25MON1.6x6500','SQH25x25 1.6mm 6500mm','Monument'],
  ['SQH25x25WH1.6x6500','SQH25x25 1.6mm 6500mm','Pearl White'],
  ['SQH25x25WG1.6x6500','SQH25x25 1.6mm 6500mm','Woodland Grey'],
  ['SQH50x50BZ1.6x6500','SQH50x50 1.6mm 6500mm','Bronze Anodised'],
  ['SQH50x50CA1.6x6500','SQH50x50 1.6mm 6500mm','Clear Anodised'],
  ['SQH50x50CB1.6x6500','SQH50x50 1.6mm 6500mm','Custom Black'],
  ['SQH50x50MF1.6x6500','SQH50x50 1.6mm 6500mm','Mill Finish'],
  ['SQH50x50MON1.6x6500','SQH50x50 1.6mm 6500mm','Monument'],
  ['SQH50x50SM1.6x6500','SQH50x50 1.6mm 6500mm','Surf Mist'],
  ['SQH50x50US1.6x6500','SQH50x50 1.6mm 6500mm','Ultra Silver'],
  ['SQH50x50WH1.6x6500','SQH50x50 1.6mm 6500mm','Pearl White'],
  // Stakes
  ['zstake9mm','Corner Window Stake 9mm',''],
  ['zstake11mm','Corner Window Stake 11mm',''],
  ['zstakedoor','Corner Door Stake (Heavy Duty)',''],
  ['310PLUG','310 Stainless Plug 4m (Gold)',''],
  ['310PLUG_LIP','310 Stainless Plug 4m With Lip',''],
];

const CX_CODE_SET = new Set(COMMANDEX_CATALOGUE.map(e => e[0]));

function searchCatalogue(term) {
  if (!term) return [];
  const t = term.toUpperCase();
  const exact = [], prefix = [], desc = [];
  for (const [code, description] of DARLEY_CATALOGUE) {
    const cu = code.toUpperCase();
    const du = description.toUpperCase();
    if (cu === t) exact.push([code, description, '', 'Darley']);
    else if (cu.startsWith(t)) prefix.push([code, description, '', 'Darley']);
    else if (cu.includes(t) || du.includes(t)) desc.push([code, description, '', 'Darley']);
  }
  for (const [code, description, colour] of COMMANDEX_CATALOGUE) {
    const cu = code.toUpperCase();
    const du = description.toUpperCase();
    const colU = colour.toUpperCase();
    if (cu === t) exact.push([code, description, colour, 'CommandeX']);
    else if (cu.startsWith(t)) prefix.push([code, description, colour, 'CommandeX']);
    else if (cu.includes(t) || du.includes(t) || colU.includes(t)) desc.push([code, description, colour, 'CommandeX']);
  }
  return [...exact, ...prefix, ...desc].slice(0, 16);
}

const SUPPLIERS = ['BJs','Bunnings','Canbrax','CommandeX','CWS Systems','Darley','Other','Starline','Sydney Tool','Total Tools'];

function supplierSelect(value = '') {
  const opts = SUPPLIERS.map(s => `<option value="${s}"${s === value ? ' selected' : ''}>${s}</option>`).join('');
  return `<select class="orders-form-input oi-supplier"><option value="">-- Supplier --</option>${opts}</select>`;
}

let _acDropdown = null;

function initCodeInput(input) {
  input.addEventListener('input', () => showCodeDropdown(input));
  input.addEventListener('keydown', e => {
    if (!_acDropdown) return;
    const items = _acDropdown.querySelectorAll('.oi-ac-item');
    const active = _acDropdown.querySelector('.oi-ac-item.active');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = active ? active.nextElementSibling : items[0];
      if (next) { active?.classList.remove('active'); next.classList.add('active'); }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = active ? active.previousElementSibling : items[items.length - 1];
      if (prev) { active?.classList.remove('active'); prev.classList.add('active'); }
    } else if (e.key === 'Enter' && active) {
      e.preventDefault();
      active.click();
    } else if (e.key === 'Escape') {
      closeCodeDropdown();
    }
  });
  input.addEventListener('blur', () => setTimeout(closeCodeDropdown, 150));
}

function showCodeDropdown(input) {
  closeCodeDropdown();
  const val = input.value.trim();
  if (!val) return;
  const matches = searchCatalogue(val);
  if (!matches.length) return;

  const drop = document.createElement('div');
  drop.className = 'oi-ac-dropdown';
  _acDropdown = drop;

  for (const [code, description, colour, supplier] of matches) {
    const item = document.createElement('div');
    item.className = 'oi-ac-item';
    const supplierTag = supplier === 'CommandeX' ? ` <span class="oi-ac-supplier">CX</span>` : '';
    item.innerHTML = `<span class="oi-ac-code">${esc(code)}</span><span class="oi-ac-desc">${esc(description)}</span>${supplierTag}`;
    item.addEventListener('mousedown', e => {
      e.preventDefault();
      const tr = input.closest('tr');
      input.value = code;
      const descInput = tr.querySelector('.oi-desc');
      if (descInput && !descInput.value) descInput.value = description;
      if (supplier === 'CommandeX') {
        const colourInput = tr.querySelector('.oi-colour');
        if (colourInput && !colourInput.value && colour) colourInput.value = colour;
        const supplierSel = tr.querySelector('.oi-supplier');
        if (supplierSel && !supplierSel.value) supplierSel.value = 'CommandeX';
      }
      closeCodeDropdown();
      descInput?.focus();
    });
    drop.appendChild(item);
  }

  const rect = input.getBoundingClientRect();
  drop.style.top = (rect.bottom + window.scrollY) + 'px';
  drop.style.left = rect.left + 'px';
  drop.style.width = Math.max(rect.width, 340) + 'px';
  document.body.appendChild(drop);
}

function closeCodeDropdown() {
  if (_acDropdown) { _acDropdown.remove(); _acDropdown = null; }
}

// --- Orders ---
let allOrders = [];
let ordersFilter = 'pending';
// Deposit status cache: jobId -> { hasDeposit: bool|null, loading: bool }
const depositStatusCache = {};
let ordersSearchQuery = '';

async function loadOrders() {
  const body = document.getElementById('orders-body');
  body.innerHTML = '<p style="color:#64748b;text-align:center;padding:40px;">Loading...</p>';
  try {
    const data = await fetch('/api/orders').then(r => r.json());
    allOrders = data.items || [];
    // Clear deposit cache on reload so fresh data is fetched
    Object.keys(depositStatusCache).forEach(k => delete depositStatusCache[k]);
    renderOrders();
  } catch {
    body.innerHTML = '<p style="color:#ef4444;text-align:center;padding:40px;">Failed to load orders</p>';
  }
}

function setOrdersFilter(f) {
  ordersFilter = f;
  ordersSearchQuery = '';
  const el = document.getElementById('orders-search');
  if (el) el.value = '';
  renderOrders();
}

function toggleOrdersGroup(jobId) {
  const el = document.getElementById('orders-group-' + jobId);
  if (!el) return;
  const isCollapsed = el.dataset.collapsed === '1';
  el.dataset.collapsed = isCollapsed ? '0' : '1';
  const body = el.querySelector('.orders-group-body');
  const chevron = el.querySelector('.orders-collapse-chevron');
  if (body) body.style.display = isCollapsed ? '' : 'none';
  if (chevron) chevron.textContent = isCollapsed ? '▾' : '▸';
}

async function fetchDepositStatus(jobId) {
  if (depositStatusCache[jobId] && depositStatusCache[jobId].loaded) return;
  depositStatusCache[jobId] = { hasDeposit: null, loaded: false };
  try {
    const r = await fetch(`/api/deposit-status/${encodeURIComponent(jobId)}`);
    const data = await r.json();
    depositStatusCache[jobId] = { hasDeposit: data.hasDeposit, loaded: true };
  } catch {
    depositStatusCache[jobId] = { hasDeposit: null, loaded: true };
  }
  if (ordersFilter === 'pending') renderOrders();
}

function renderOrders() {
  const body = document.getElementById('orders-body');

  const pending = allOrders.filter(i => !i.orderedDate && !i.inStock);
  const ordered = allOrders.filter(i => i.orderedDate || i.inStock);

  if (ordersFilter === 'inventory') {
    renderInventory(true);
    return;
  }

  const items = ordersFilter === 'pending' ? pending : ordered;

  // Group by jobId
  const byJob = new Map();
  for (const item of items) {
    if (!byJob.has(item.jobId)) {
      const clientName = item.clientName || (allJobs.find(j => String(j.generated_job_id) === String(item.jobId))?.company_name) || '';
      byJob.set(item.jobId, { jobId: item.jobId, clientName, items: [], latestOrderedDate: item.orderedDate || '' });
    }
    const g = byJob.get(item.jobId);
    g.items.push(item);
    if (item.orderedDate && item.orderedDate > g.latestOrderedDate) g.latestOrderedDate = item.orderedDate;
  }

  // Sort ordered tab: most recently ordered first, then by job number ascending within same date
  if (ordersFilter === 'ordered') {
    [...byJob.entries()].sort((a, b) => {
      const dateDiff = b[1].latestOrderedDate.localeCompare(a[1].latestOrderedDate);
      if (dateDiff !== 0) return dateDiff;
      return parseInt(a[1].jobId) - parseInt(b[1].jobId);
    }).forEach(([k, v]) => { byJob.delete(k); byJob.set(k, v); });
  }

  let html = '<div class="orders-topbar">';
  html += '<div class="orders-filter-group">';
  html += `<button class="orders-filter-btn ${ordersFilter === 'pending' ? 'active' : ''}" onclick="setOrdersFilter('pending')">Pending <span class="orders-filter-count">${pending.length}</span></button>`;
  html += `<button class="orders-filter-btn ${ordersFilter === 'ordered' ? 'active' : ''}" onclick="setOrdersFilter('ordered')">Ordered <span class="orders-filter-count">${ordered.length}</span></button>`;
  html += `<button class="orders-filter-btn ${ordersFilter === 'inventory' ? 'active' : ''}" onclick="setOrdersFilter('inventory')">Inventory</button>`;
  html += '</div>';
  html += `<input type="text" id="orders-search" class="orders-search-input" placeholder="Search job #, code or description…" autocomplete="off" value="${esc(ordersSearchQuery)}"
    oninput="ordersSearchQuery=this.value.toLowerCase().trim();renderOrders();">`;
  html += '<div class="orders-topbar-actions">';
  if (ordersFilter === 'pending' && pending.length > 0) {
    html += `<button class="orders-btn orders-btn-export" onclick="exportEmail()">Export Email</button>`;
    html += `<button class="orders-btn orders-btn-place" onclick="placeWeeklyOrder()">Place Weekly Order (${pending.length} item${pending.length > 1 ? 's' : ''})</button>`;
  }
  html += `<button class="orders-btn orders-btn-primary" onclick="showAddItemModal()">+ Add Item</button>`;
  html += '</div></div>';

  // Apply search filter across groups
  const q = ordersSearchQuery;
  let groups = [...byJob.values()];
  if (q) {
    groups = groups.filter(group =>
      group.jobId.includes(q) ||
      (group.clientName || '').toLowerCase().includes(q) ||
      group.items.some(i =>
        (i.code || '').toLowerCase().includes(q) ||
        (i.description || '').toLowerCase().includes(q)
      )
    );
  }

  if (!groups.length) {
    const msg = q ? 'No items match your search.'
      : ordersFilter === 'pending' ? 'No pending items. Add items using the button above.'
      : 'No ordered items yet.';
    html += `<div class="orders-empty">${msg}</div>`;
  } else {
    html += '<div class="orders-list">';
    groups.forEach((group, idx) => {
      const collapsed = ordersFilter === 'ordered' && !q && idx >= 5;
      const jobData = allJobs.find(j => (j.generated_job_id || '') === group.jobId);
      const installStamp = jobData?.job_is_scheduled_until_stamp;
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Brisbane' });
      const installDateStr = installStamp && !installStamp.startsWith('0000') ? installStamp.slice(0, 10) : null;
      const installLabel = installDateStr && installDateStr >= todayStr
        ? new Date(installDateStr + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })
        : null;

      const canCollapse = ordersFilter === 'ordered';

      // Deposit status for all pending items
      let depositPaid = true;
      const hasAutoItems = group.items.some(i => i.sourceTag === 'cutting-form');
      if (ordersFilter === 'pending') {
        const ds = depositStatusCache[group.jobId];
        if (!ds) {
          fetchDepositStatus(group.jobId);
          depositPaid = false;
        } else {
          depositPaid = ds.hasDeposit === true;
        }
      }

      html += `<div class="orders-job-group" id="orders-group-${esc(group.jobId)}" data-collapsed="${collapsed ? '1' : '0'}">`;
      html += `<div class="orders-job-header" ${canCollapse ? `onclick="toggleOrdersGroup('${esc(group.jobId)}')"` : ''} style="cursor:${canCollapse ? 'pointer' : 'default'};display:flex;align-items:center;gap:8px;">`;
      html += `<span class="orders-collapse-chevron" style="font-size:.75rem;color:#64748b;width:10px;flex-shrink:0;">${canCollapse ? (collapsed ? '▸' : '▾') : ''}</span>`;
      html += `<span class="orders-job-id">#${esc(group.jobId)}</span>`;
      if (group.clientName) html += `<span class="orders-job-client">${esc(group.clientName)}</span>`;
      if (installLabel) html += `<span class="orders-install-date">Install: ${esc(installLabel)}</span>`;
      if (ordersFilter === 'pending') {
        const ds = depositStatusCache[group.jobId];
        if (!ds || !ds.loaded) {
          html += `<span class="deposit-badge deposit-loading" style="margin-left:auto;">Checking deposit…</span>`;
          html += `<span style="font-size:.72rem;color:#64748b;">${group.items.length} item${group.items.length !== 1 ? 's' : ''}</span>`;
        } else if (!depositPaid) {
          html += `<span class="deposit-badge deposit-unpaid" style="margin-left:auto;">Awaiting Deposit</span>`;
          html += `<span style="font-size:.72rem;color:#64748b;">${group.items.length} item${group.items.length !== 1 ? 's' : ''}</span>`;
        } else {
          html += `<span class="deposit-badge deposit-paid" style="margin-left:auto;">Deposit Received</span>`;
          html += `<span style="font-size:.72rem;color:#64748b;">${group.items.length} item${group.items.length !== 1 ? 's' : ''}</span>`;
        }
      } else {
        html += `<span style="margin-left:auto;font-size:.72rem;color:#64748b;">${group.items.length} item${group.items.length !== 1 ? 's' : ''}</span>`;
      }
      html += '</div>';
      html += `<div class="orders-group-body" style="display:${collapsed ? 'none' : ''};">`;
      for (const item of group.items) {
        html += '<div class="orders-item">';
        html += '<div class="orders-item-main">';
        if (item.code) html += `<span class="orders-item-code">${esc(item.code)}</span>`;
        html += `<span class="orders-item-desc">${esc(item.description)}</span>`;
        if (item.colour) html += `<span class="orders-item-colour">${esc(item.colour)}</span>`;
        if (item.qty && item.qty > 1) html += `<span class="orders-item-qty">×${item.qty}</span>`;
        html += '</div>';
        html += '<div class="orders-item-actions">';
        if (item.supplier) {
          html += `<span class="orders-supplier-pill" onclick="editSupplier('${item.id}', this)" title="Click to edit">${esc(item.supplier)}</span>`;
        } else {
          html += `<button class="orders-act-btn orders-act-supplier" onclick="editSupplier('${item.id}', this)">+ Supplier</button>`;
        }
        if (item.inStock) {
          html += `<span class="orders-instock-badge">In Stock</span>`;
          html += `<button class="orders-act-btn orders-act-unorder" onclick="unmarkItemInStock('${item.id}')">Undo</button>`;
        } else if (!item.orderedDate) {
          if (depositPaid) {
            html += `<button class="orders-act-btn orders-act-order" onclick="markItemOrdered('${item.id}')">Mark Ordered</button>`;
            html += `<button class="orders-act-btn orders-act-instock" onclick="markItemInStock('${item.id}')">In Stock</button>`;
          } else {
            html += `<button class="orders-act-btn orders-act-order" disabled title="Awaiting deposit" style="opacity:.35;cursor:not-allowed;">Mark Ordered</button>`;
            html += `<button class="orders-act-btn orders-act-instock" disabled title="Awaiting deposit" style="opacity:.35;cursor:not-allowed;">In Stock</button>`;
          }
        } else {
          const d = new Date(item.orderedDate + 'T00:00:00');
          const dateStr = d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
          html += `<span class="orders-ordered-date">Ordered ${dateStr}</span>`;
          html += `<button class="orders-act-btn orders-act-unorder" onclick="unmarkItemOrdered('${item.id}')">Undo</button>`;
        }
        html += `<button class="orders-act-btn orders-act-delete" onclick="deleteOrderItem('${item.id}')">Delete</button>`;
        html += '</div></div>';
      }
      html += '</div></div>';
    });
    html += '</div>';
  }

  const prevActive = document.activeElement?.id;
  body.innerHTML = html;
  if (prevActive === 'orders-search') {
    const el = document.getElementById('orders-search');
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  }
}

function showAddItemModal() {
  document.getElementById('order-job-input').value = '';
  document.getElementById('order-job-hint').textContent = '';
  const tbody = document.getElementById('order-items-tbody');
  tbody.innerHTML = `
    <tr>
      <td><input type="text" class="orders-form-input oi-code" placeholder="AN2550" autocomplete="off"></td>
      <td><input type="text" class="orders-form-input oi-desc" placeholder="Description"></td>
      <td><input type="text" class="orders-form-input oi-colour" placeholder="Black"></td>
      <td>${supplierSelect()}</td>
      <td><input type="number" class="orders-form-input oi-qty" value="1" min="1"></td>
      <td><button class="orders-row-remove" onclick="removeOrderRow(this)">×</button></td>
    </tr>`;
  initCodeInput(tbody.querySelector('.oi-code'));
  document.getElementById('orders-modal-backdrop').style.display = 'flex';
  setTimeout(() => document.getElementById('order-job-input').focus(), 50);
}

function addOrderRow() {
  const tbody = document.getElementById('order-items-tbody');
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="orders-form-input oi-code" placeholder="AN2550" autocomplete="off"></td>
    <td><input type="text" class="orders-form-input oi-desc" placeholder="Description"></td>
    <td><input type="text" class="orders-form-input oi-colour" placeholder="Black"></td>
    <td>${supplierSelect()}</td>
    <td><input type="number" class="orders-form-input oi-qty" value="1" min="1"></td>
    <td><button class="orders-row-remove" onclick="removeOrderRow(this)">×</button></td>`;
  tbody.appendChild(tr);
  const codeInput = tr.querySelector('.oi-code');
  initCodeInput(codeInput);
  codeInput.focus();
}

function removeOrderRow(btn) {
  const tbody = document.getElementById('order-items-tbody');
  if (tbody.rows.length <= 1) return;
  btn.closest('tr').remove();
}

function closeOrdersModal(e) {
  if (e && e.target !== document.getElementById('orders-modal-backdrop')) return;
  document.getElementById('orders-modal-backdrop').style.display = 'none';
}

function onOrderJobInput(val) {
  const hint = document.getElementById('order-job-hint');
  const jobId = val.trim().replace(/^#/, '');
  if (!jobId) { hint.textContent = ''; return; }
  const job = allJobs.find(j => (j.generated_job_id || '').toLowerCase() === jobId.toLowerCase());
  if (job) {
    hint.textContent = `${job.company_name || 'Unknown client'} — ${job.status || ''}`;
    hint.style.color = '#22c55e';
  } else {
    hint.textContent = 'Not found in cache (can still add)';
    hint.style.color = '#94a3b8';
  }
}

async function submitAddItem() {
  const jobIdRaw = document.getElementById('order-job-input').value.trim().replace(/^#/, '');
  if (!jobIdRaw) { showToast('Enter a job number', 'error'); return; }

  const job = allJobs.find(j => (j.generated_job_id || '').toLowerCase() === jobIdRaw.toLowerCase());
  const clientName = job ? (job.company_name || '') : '';

  const rows = [];
  document.querySelectorAll('#order-items-tbody tr').forEach(tr => {
    const desc = tr.querySelector('.oi-desc')?.value.trim() || '';
    if (!desc) return;
    rows.push({
      code: tr.querySelector('.oi-code')?.value.trim() || '',
      description: desc,
      colour: tr.querySelector('.oi-colour')?.value.trim() || '',
      supplier: tr.querySelector('.oi-supplier')?.value || '',
      qty: parseInt(tr.querySelector('.oi-qty')?.value) || 1,
    });
  });
  if (!rows.length) { showToast('Add at least one item description', 'error'); return; }

  try {
    for (const row of rows) {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: jobIdRaw, clientName, ...row }),
      });
      const item = await res.json();
      allOrders.push(item);
    }
    document.getElementById('orders-modal-backdrop').style.display = 'none';
    ordersFilter = 'pending';
    renderOrders();
    showToast(`${rows.length} item${rows.length > 1 ? 's' : ''} added`);
  } catch {
    showToast('Failed to add items', 'error');
  }
}

async function editSupplier(id, el) {
  const item = allOrders.find(i => i.id === id);
  const current = item?.supplier || '';
  const val = prompt('Supplier name:', current);
  if (val === null) return;
  try {
    await fetch(`/api/orders/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ supplier: val.trim() }),
    });
    if (item) item.supplier = val.trim();
    renderOrders();
  } catch {
    showToast('Failed to update supplier', 'error');
  }
}

async function markItemOrdered(id) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Brisbane' });
  try {
    await fetch(`/api/orders/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedDate: today }),
    });
    const item = allOrders.find(i => i.id === id);
    if (item) item.orderedDate = today;
    renderOrders();
    showToast('Marked as ordered');
  } catch {
    showToast('Failed to update', 'error');
  }
}

async function unmarkItemOrdered(id) {
  try {
    await fetch(`/api/orders/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedDate: null }),
    });
    const item = allOrders.find(i => i.id === id);
    if (item) item.orderedDate = null;
    renderOrders();
    showToast('Order mark removed');
  } catch {
    showToast('Failed to update', 'error');
  }
}

async function markItemInStock(id) {
  try {
    await fetch(`/api/orders/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inStock: true }),
    });
    const item = allOrders.find(i => i.id === id);
    if (item) item.inStock = true;
    renderOrders();
    showToast('Marked as in stock');
  } catch {
    showToast('Failed to update', 'error');
  }
}

async function unmarkItemInStock(id) {
  try {
    await fetch(`/api/orders/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inStock: false }),
    });
    const item = allOrders.find(i => i.id === id);
    if (item) item.inStock = false;
    renderOrders();
    showToast('In stock mark removed');
  } catch {
    showToast('Failed to update', 'error');
  }
}

async function deleteOrderItem(id) {
  if (!confirm('Delete this item?')) return;
  try {
    await fetch(`/api/orders/${id}`, { method: 'DELETE' });
    allOrders = allOrders.filter(i => i.id !== id);
    renderOrders();
    showToast('Item deleted');
  } catch {
    showToast('Failed to delete', 'error');
  }
}

function exportEmail() {
  const pending = allOrders.filter(i => !i.orderedDate && !i.inStock);
  if (!pending.length) { showToast('No pending items to export', 'error'); return; }

  const [refYear, refMonth, refDay] = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Brisbane' }).split('-');
  const ref = `${refDay}${refMonth}${refYear}`;
  const DELIVERY = 'Unit 6/34-40 Robson St Clontarf QLD 4019';

  // Group by supplier
  const bySupplier = new Map();
  for (const item of pending) {
    const s = item.supplier || '';
    if (!bySupplier.has(s)) bySupplier.set(s, []);
    bySupplier.get(s).push(item);
  }

  let plainParts = [];
  let htmlParts = [];

  for (const [, items] of bySupplier) {
    const pad = (s, n) => String(s).padEnd(n);
    let plain = `Hi,\n\nCan we please order the following, to be delivered to: ${DELIVERY}.\n\nThere are automated gates for the complex and should opened at 6am. If no one is at the warehouse at time of delivery, please leave items in-front of roller door & entry door.\n\nPlease let us know if any items are on back order and an approx. lead time.\n`;
    plain += `\n${pad('Code',14)}${pad('Description',42)}${pad('Colour',22)}Quantity\n`;
    plain += `${'-'.repeat(14)}${'-'.repeat(42)}${'-'.repeat(22)}${'-'.repeat(8)}\n`;
    for (const item of items) {
      plain += `${pad(item.code||'',14)}${pad(item.description,42)}${pad(item.colour||'',22)}${item.qty||1}\n`;
    }
    plain += `\nThanks,\nSerene Security`;
    plainParts.push(plain);

    let html = `<p>Hi,</p><p>Can we please order the following, to be delivered to: ${DELIVERY}.</p><p>There are automated gates for the complex and should opened at 6am. If no one is at the warehouse at time of delivery, please leave items in-front of roller door &amp; entry door.</p><p>Please let us know if any items are on back order and an approx. lead time.</p>`;
    html += `<table border="0" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;">`;
    html += `<thead><tr style="border-bottom:2px solid #000;">`;
    html += `<th style="text-align:left;padding-right:24px;">Code</th><th style="text-align:left;padding-right:24px;">Description</th><th style="text-align:left;padding-right:24px;">Colour</th><th style="text-align:left;">Quantity</th>`;
    html += `</tr></thead><tbody>`;
    for (const item of items) {
      html += `<tr><td style="padding-right:24px;">${esc(item.code||'')}</td><td style="padding-right:24px;">${esc(item.description)}</td><td style="padding-right:24px;">${esc(item.colour||'')}</td><td>${item.qty||1}</td></tr>`;
    }
    html += `</tbody></table><p>Thanks,<br>Serene Security</p>`;
    htmlParts.push(html);
  }

  const fullPlain = plainParts.join('\n\n---\n\n');
  const fullHtml = htmlParts.join('<hr>');

  document.getElementById('export-subject').textContent = `Serene Security Ref #${ref}`;
  document.getElementById('export-body').value = fullPlain;
  document.getElementById('export-modal-backdrop').style.display = 'flex';
  // Store html for clipboard
  document.getElementById('export-body').dataset.html = fullHtml;
}

function closeExportModal(e) {
  if (e && e.target !== document.getElementById('export-modal-backdrop')) return;
  document.getElementById('export-modal-backdrop').style.display = 'none';
}

async function copyExportEmail() {
  const text = document.getElementById('export-body').value;
  const html = document.getElementById('export-body').dataset.html || '';
  try {
    if (html && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      })]);
    } else {
      await navigator.clipboard.writeText(text);
    }
    showToast('Copied to clipboard');
  } catch {
    document.getElementById('export-body').select();
    showToast('Select all and copy manually', 'error');
  }
}

async function placeWeeklyOrder() {
  const count = allOrders.filter(i => !i.orderedDate && !i.inStock).length;
  if (!count) return;
  if (!confirm(`Mark all ${count} pending items as ordered today?`)) return;
  try {
    const res = await fetch('/api/orders/batch-order', { method: 'POST' });
    const data = await res.json();
    await loadOrders();
    showToast(`${data.count} items marked as ordered`);
  } catch {
    showToast('Failed to place order', 'error');
  }
}

// --- Actions ---
let allActions = [];
let actionsFilter = 'pending';
let editingActionId = null;

async function loadActions() {
  const body = document.getElementById('actions-body');
  body.innerHTML = '<p style="color:#64748b;text-align:center;padding:40px;">Loading...</p>';
  try {
    const data = await fetch('/api/actions').then(r => r.json());
    allActions = data.items || [];
    renderActions();
  } catch {
    body.innerHTML = '<p style="color:#ef4444;text-align:center;padding:40px;">Failed to load actions</p>';
  }
}

function setActionsFilter(f) {
  actionsFilter = f;
  renderActions();
}

const ACTION_PRIORITY = { high: { label: 'High', cls: 'action-priority-high' }, normal: { label: 'Normal', cls: '' }, low: { label: 'Low', cls: 'action-priority-low' } };

function renderActions() {
  const body = document.getElementById('actions-body');
  const pending = allActions.filter(a => !a.doneDate);
  const done = allActions.filter(a => a.doneDate);
  const items = actionsFilter === 'pending' ? pending : done;

  // Sort pending: overdue first, then by priority, then by due date, then oldest first
  const PORDER = { high: 0, normal: 1, low: 2 };
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Brisbane' });
  const sorted = [...items].sort((a, b) => {
    const aOver = a.dueDate && a.dueDate < todayStr ? 0 : 1;
    const bOver = b.dueDate && b.dueDate < todayStr ? 0 : 1;
    if (aOver !== bOver) return aOver - bOver;
    const pd = (PORDER[a.priority] ?? 1) - (PORDER[b.priority] ?? 1);
    if (pd !== 0) return pd;
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return new Date(a.createdAt) - new Date(b.createdAt);
  });

  let html = '<div class="orders-topbar">';
  html += '<div class="orders-filter-group">';
  html += `<button class="orders-filter-btn ${actionsFilter === 'pending' ? 'active' : ''}" onclick="setActionsFilter('pending')">Pending <span class="orders-filter-count">${pending.length}</span></button>`;
  html += `<button class="orders-filter-btn ${actionsFilter === 'done' ? 'active' : ''}" onclick="setActionsFilter('done')">Done <span class="orders-filter-count">${done.length}</span></button>`;
  html += '</div>';
  html += '<div class="orders-topbar-actions" style="margin-left:auto;">';
  html += `<button class="orders-btn orders-btn-primary" onclick="showAddActionModal()">+ Add Action</button>`;
  html += '</div></div>';

  if (!sorted.length) {
    const msg = actionsFilter === 'pending' ? 'No pending actions. Add one using the button above.' : 'No completed actions yet.';
    html += `<div class="orders-empty">${msg}</div>`;
  } else {
    html += '<div class="actions-list">';
    for (const item of sorted) {
      const p = ACTION_PRIORITY[item.priority] || ACTION_PRIORITY.normal;
      html += `<div class="action-item${item.doneDate ? ' action-item-done' : ''}">`;
      html += '<div class="action-item-main">';
      html += '<div class="action-item-top">';
      if (p.cls) html += `<span class="action-priority-badge ${p.cls}">${p.label}</span>`;
      html += `<span class="action-item-title">${esc(item.title)}</span>`;
      if (item.dueDate && !item.doneDate) {
        const dueCls = item.dueDate < todayStr ? 'action-due-overdue' : item.dueDate <= new Date(Date.now() + 7*864e5).toLocaleDateString('en-CA', { timeZone: 'Australia/Brisbane' }) ? 'action-due-soon' : 'action-due-ok';
        const dueLabel = new Date(item.dueDate + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
        html += `<span class="action-due-badge ${dueCls}">${item.dueDate < todayStr ? 'Overdue · ' : ''}${dueLabel}</span>`;
      }
      html += '</div>';
      if (item.relatesTo) html += `<div class="action-item-relates">${esc(item.relatesTo)}</div>`;
      if (item.notes) html += `<div class="action-item-notes">${esc(item.notes)}</div>`;
      if (item.doneDate) {
        const d = new Date(item.doneDate + 'T00:00:00');
        html += `<div class="action-item-donedate">Completed ${d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}</div>`;
      }
      html += '</div>';
      html += '<div class="action-item-actions">';
      if (!item.doneDate) {
        html += `<button class="orders-act-btn action-act-edit" onclick="showEditActionModal('${item.id}')">Edit</button>`;
        html += `<button class="orders-act-btn action-act-done" onclick="markActionDone('${item.id}')">Mark Done</button>`;
      } else {
        html += `<button class="orders-act-btn orders-act-unorder" onclick="unmarkActionDone('${item.id}')">Reopen</button>`;
      }
      html += `<button class="orders-act-btn orders-act-delete" onclick="deleteAction('${item.id}')">Delete</button>`;
      html += '</div></div>';
    }
    html += '</div>';
  }

  body.innerHTML = html;
}

function showAddActionModal() {
  editingActionId = null;
  document.getElementById('actions-modal-title').textContent = 'Add Action';
  document.getElementById('actions-modal-save-btn').textContent = 'Add Action';
  document.getElementById('action-title-input').value = '';
  document.getElementById('action-notes-input').value = '';
  document.getElementById('action-relates-input').value = '';
  document.getElementById('action-due-input').value = '';
  document.getElementById('action-priority-input').value = 'normal';
  document.getElementById('actions-modal-backdrop').style.display = 'flex';
  setTimeout(() => document.getElementById('action-title-input').focus(), 50);
}

function showEditActionModal(id) {
  const item = allActions.find(a => a.id === id);
  if (!item) return;
  editingActionId = id;
  document.getElementById('actions-modal-title').textContent = 'Edit Action';
  document.getElementById('actions-modal-save-btn').textContent = 'Save Changes';
  document.getElementById('action-title-input').value = item.title;
  document.getElementById('action-notes-input').value = item.notes || '';
  document.getElementById('action-relates-input').value = item.relatesTo || '';
  document.getElementById('action-due-input').value = item.dueDate || '';
  document.getElementById('action-priority-input').value = item.priority || 'normal';
  document.getElementById('actions-modal-backdrop').style.display = 'flex';
  setTimeout(() => document.getElementById('action-title-input').focus(), 50);
}

function closeActionsModal(e) {
  if (e && e.target !== document.getElementById('actions-modal-backdrop')) return;
  document.getElementById('actions-modal-backdrop').style.display = 'none';
}

async function submitAction() {
  const title = document.getElementById('action-title-input').value.trim();
  const notes = document.getElementById('action-notes-input').value.trim();
  const relatesTo = document.getElementById('action-relates-input').value.trim();
  const dueDate = document.getElementById('action-due-input').value || null;
  const priority = document.getElementById('action-priority-input').value;
  if (!title) { showToast('Enter a title', 'error'); return; }

  try {
    if (editingActionId) {
      const res = await fetch(`/api/actions/${editingActionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, notes, relatesTo, dueDate, priority }),
      });
      const updated = await res.json();
      const idx = allActions.findIndex(a => a.id === editingActionId);
      if (idx !== -1) allActions[idx] = updated;
      showToast('Action updated');
    } else {
      const res = await fetch('/api/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, notes, relatesTo, dueDate, priority }),
      });
      const item = await res.json();
      allActions.push(item);
      actionsFilter = 'pending';
      showToast('Action added');
    }
    document.getElementById('actions-modal-backdrop').style.display = 'none';
    renderActions();
  } catch {
    showToast('Failed to save action', 'error');
  }
}

async function markActionDone(id) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Brisbane' });
  try {
    await fetch(`/api/actions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doneDate: today }),
    });
    const item = allActions.find(a => a.id === id);
    if (item) item.doneDate = today;
    renderActions();
    showToast('Marked as done');
  } catch {
    showToast('Failed to update', 'error');
  }
}

async function unmarkActionDone(id) {
  try {
    await fetch(`/api/actions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doneDate: null }),
    });
    const item = allActions.find(a => a.id === id);
    if (item) item.doneDate = null;
    renderActions();
    showToast('Action reopened');
  } catch {
    showToast('Failed to update', 'error');
  }
}

async function deleteAction(id) {
  if (!confirm('Delete this action?')) return;
  try {
    await fetch(`/api/actions/${id}`, { method: 'DELETE' });
    allActions = allActions.filter(a => a.id !== id);
    renderActions();
    showToast('Action deleted');
  } catch {
    showToast('Failed to delete', 'error');
  }
}

// --- Inventory ---
let inventoryFilter = 'not-prepped'; // 'all' | 'not-prepped' | 'prepped'
let inventorySearchQuery = '';

async function loadInventory() {
  const body = document.getElementById('orders-body');
  if (body) body.innerHTML = '<p style="color:#64748b;text-align:center;padding:40px;">Loading...</p>';
  try {
    const data = await fetch('/api/orders').then(r => r.json());
    allOrders = data.items || [];
    renderInventory(true);
  } catch {
    if (body) body.innerHTML = '<p style="color:#ef4444;text-align:center;padding:40px;">Failed to load inventory</p>';
  }
}

function setInventoryFilter(f) {
  inventoryFilter = f;
  renderInventory(true);
}

function renderInventory(inOrdersTab) {
  const body = document.getElementById('orders-body');
  if (!body) return;

  // Only items that have been ordered or marked in-stock
  const items = allOrders.filter(i => i.orderedDate || i.inStock);

  const q = inventorySearchQuery.toLowerCase().trim();
  const filtered = items.filter(i => {
    if (inventoryFilter === 'prepped' && !i.preppedDate) return false;
    if (inventoryFilter === 'not-prepped' && i.preppedDate) return false;
    if (q) {
      const hay = `${i.jobId} ${i.clientName || ''} ${i.code || ''} ${i.description} ${i.colour || ''} ${i.supplier || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const prepped = items.filter(i => i.preppedDate).length;
  const notPrepped = items.filter(i => !i.preppedDate).length;

  // Group by item type: code + description + colour
  const byType = new Map();
  for (const item of filtered) {
    const key = `${(item.code || '').toLowerCase()}|${item.description.toLowerCase()}|${(item.colour || '').toLowerCase()}`;
    if (!byType.has(key)) byType.set(key, { code: item.code, description: item.description, colour: item.colour, items: [] });
    byType.get(key).items.push(item);
  }

  const pending = allOrders.filter(i => !i.orderedDate && !i.inStock);
  const ordered = allOrders.filter(i => i.orderedDate || i.inStock);

  // Full orders topbar (Pending / Ordered / Inventory tabs + search + Add Item)
  let html = '<div class="orders-topbar">';
  html += '<div class="orders-filter-group">';
  html += `<button class="orders-filter-btn ${ordersFilter === 'pending' ? 'active' : ''}" onclick="setOrdersFilter('pending')">Pending <span class="orders-filter-count">${pending.length}</span></button>`;
  html += `<button class="orders-filter-btn ${ordersFilter === 'ordered' ? 'active' : ''}" onclick="setOrdersFilter('ordered')">Ordered <span class="orders-filter-count">${ordered.length}</span></button>`;
  html += `<button class="orders-filter-btn ${ordersFilter === 'inventory' ? 'active' : ''}" onclick="setOrdersFilter('inventory')">Inventory</button>`;
  html += '</div>';
  html += `<input type="text" id="inventory-search" class="orders-search-input" placeholder="Search job #, code or description…" autocomplete="off" value="${esc(inventorySearchQuery)}"
    oninput="inventorySearchQuery=this.value.toLowerCase().trim();renderInventory(true);">`;
  html += '<div class="orders-topbar-actions">';
  html += `<button class="orders-btn orders-btn-secondary" onclick="openOrdersModal()">+ Add Item</button>`;
  html += '</div>';
  html += '</div>';

  // Inventory-specific sub-filter row
  html += '<div class="orders-topbar" style="border-top:1px solid rgba(255,255,255,0.05);padding-top:8px;margin-top:-4px;">';
  html += '<div class="orders-filter-group">';
  html += `<button class="orders-filter-btn ${inventoryFilter === 'all' ? 'active' : ''}" onclick="setInventoryFilter('all')">All <span class="orders-filter-count">${items.length}</span></button>`;
  html += `<button class="orders-filter-btn ${inventoryFilter === 'not-prepped' ? 'active' : ''}" onclick="setInventoryFilter('not-prepped')">Not Prepped <span class="orders-filter-count">${notPrepped}</span></button>`;
  html += `<button class="orders-filter-btn ${inventoryFilter === 'prepped' ? 'active' : ''}" onclick="setInventoryFilter('prepped')">Prepped <span class="orders-filter-count">${prepped}</span></button>`;
  html += '</div>';
  html += '</div>';

  if (!byType.size) {
    const msg = q ? 'No items match your search.' : inventoryFilter === 'prepped' ? 'No prepped items yet.' : inventoryFilter === 'not-prepped' ? 'All items are prepped.' : 'No ordered or in-stock items.';
    html += `<div class="orders-empty">${msg}</div>`;
  } else {
    html += '<div class="orders-list">';
    for (const group of byType.values()) {
      html += `<div class="orders-job-group">`;
      html += `<div class="orders-job-header" style="cursor:default;display:flex;align-items:center;gap:8px;">`;
      html += `<span class="orders-collapse-chevron" style="width:10px;flex-shrink:0;"></span>`;
      if (group.code) html += `<span class="orders-item-code">${esc(group.code)}</span>`;
      html += `<span class="orders-job-client" style="font-weight:600;color:#e2e8f0;">${esc(group.description)}</span>`;
      if (group.colour) html += `<span class="orders-item-colour">${esc(group.colour)}</span>`;
      html += `<span style="margin-left:auto;font-size:.72rem;color:#64748b;">${group.items.length} job${group.items.length !== 1 ? 's' : ''}</span>`;
      html += '</div>';
      html += '<div class="orders-group-body">';
      for (const item of group.items) {
        html += '<div class="orders-item">';
        html += '<div class="orders-item-main">';
        html += `<a href="https://go.servicem8.com/job/${item.jobId}" target="_blank" class="orders-job-link" style="font-size:.95rem;font-weight:600;">#${esc(item.jobId)}</a>`;
        if (item.clientName) html += `<span class="inv-client-name">${esc(item.clientName)}</span>`;
        if (item.qty && item.qty > 1) html += `<span class="orders-item-qty">×${item.qty}</span>`;
        html += '</div>';
        html += '<div class="orders-item-actions">';
        if (item.inStock) {
          html += `<span class="orders-instock-badge">In Stock</span>`;
        } else if (item.orderedDate) {
          const d = new Date(item.orderedDate + 'T00:00:00');
          const dateStr = d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
          html += `<span class="orders-ordered-date">Ordered ${dateStr}</span>`;
        }
        if (item.preppedDate) {
          const pd = new Date(item.preppedDate + 'T00:00:00');
          const pdStr = pd.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
          html += `<span class="inv-prepped-badge">Prepped ${pdStr}</span>`;
          html += `<button class="orders-act-btn orders-act-unorder" onclick="unmarkItemPrepped('${item.id}')">Undo</button>`;
        } else {
          html += `<button class="orders-act-btn inv-act-prep" onclick="markItemPrepped('${item.id}')">Mark Prepped</button>`;
        }
        html += '</div></div>';
      }
      html += '</div></div>';
    }
    html += '</div>';
  }

  const prevActive = document.activeElement?.id;
  body.innerHTML = html;
  if (prevActive === 'inventory-search') {
    const el = document.getElementById('inventory-search');
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  }
}

async function markItemPrepped(id) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Brisbane' });
  try {
    await fetch(`/api/orders/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preppedDate: today }),
    });
    const item = allOrders.find(i => i.id === id);
    if (item) item.preppedDate = today;
    renderInventory(true);
    showToast('Marked as prepped');
  } catch {
    showToast('Failed to update', 'error');
  }
}

async function unmarkItemPrepped(id) {
  try {
    await fetch(`/api/orders/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preppedDate: null }),
    });
    const item = allOrders.find(i => i.id === id);
    if (item) item.preppedDate = null;
    renderInventory(true);
    showToast('Prepped mark removed');
  } catch {
    showToast('Failed to update', 'error');
  }
}

// --- Close app switcher on outside click ---
document.addEventListener('click', e => {
  const menu = document.querySelector('.app-switcher-menu');
  if (menu && !e.target.closest('.app-switcher')) menu.classList.remove('open');
});

// --- Start ---
init();
