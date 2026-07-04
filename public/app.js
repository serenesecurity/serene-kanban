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

  if (view === 'schedule') {
    document.getElementById('board').classList.add('hidden');
    document.getElementById('schedule-view').classList.remove('hidden');
    if (scheduleTab === 'scheduler') loadScheduler();
    else loadSchedule();
  } else {
    document.getElementById('board').classList.remove('hidden');
    document.getElementById('schedule-view').classList.add('hidden');
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
    const res = await fetch('/api/scheduler');
    const data = await res.json();
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

  // Assign status to each job
  const rows = data.items.map(job => {
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
    <th class="sched-th-right">Job Total</th>
  </tr></thead><tbody>`;

  let lastStatus = '';
  for (const r of rows) {
    // Section divider row
    if (r.status !== lastStatus) {
      lastStatus = r.status;
      html += `<tr class="sched-divider ${r.statusCls}-bg"><td colspan="9">${esc(r.status)}${r.status === 'Ready' ? ' — ready to book installation' : r.status === 'Coming Soon' ? ' — parts arriving soon' : r.status === 'Ordered' ? ' — recently placed' : r.status === 'Not Sent' ? ' — order form not yet sent' : ' — installation scheduled'}</td></tr>`;
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

    html += `<tr class="sched-row">
      <td><span class="sched-status-badge ${r.statusCls}">${esc(r.status)}</span></td>
      <td class="sched-cell-id">${esc(r.jobId)}</td>
      <td>${esc(r.client)}</td>
      <td>${esc(r.suburb || '')}</td>
      <td>${sentStr}</td>
      <td>${daysStr}${progressBar}</td>
      <td>${estReadyStr}</td>
      <td>${depositStr}</td>
      <td class="sched-cell-right">${amtStr}</td>
    </tr>`;
  }

  html += `</tbody></table></div>`;
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

// --- Close app switcher on outside click ---
document.addEventListener('click', e => {
  const menu = document.querySelector('.app-switcher-menu');
  if (menu && !e.target.closest('.app-switcher')) menu.classList.remove('open');
});

// --- Start ---
init();
