import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchQueues, fetchJobs, moveJob, triggerSync, subscribeSSE } from './api.js';
import Column from './components/Column.jsx';
import JobModal from './components/JobModal.jsx';
import Toast from './components/Toast.jsx';

const COLUMN_ORDER = [
  'Lead', 'Lead Called', 'Quote Request', 'Quote Draft', 'Quote to Send',
  'Pending Quote Outcome', 'Quote Outcome Follow-Up', 'Expired Quote',
  'Awaiting 50% Deposit', 'Schedule Works', 'Order Parts', 'Send Order Form',
  'Outreach', 'On Hold',
];

export default function App() {
  const [jobs, setJobs] = useState([]);
  const [queues, setQueues] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [selectedJob, setSelectedJob] = useState(null);
  const [search, setSearch] = useState('');
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  function showToast(message, type = 'info') {
    clearTimeout(toastTimer.current);
    setToast({ message, type });
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }

  const loadData = useCallback(async () => {
    try {
      const [q, j] = await Promise.all([fetchQueues(), fetchJobs()]);
      setQueues(q);
      setJobs(j);
    } catch {
      showToast('Failed to load data', 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    const unsub = subscribeSSE((event, data) => {
      if (event === 'job_updated') {
        setJobs((prev) => {
          const idx = prev.findIndex((j) => j.uuid === data.uuid);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = data;
            return next;
          }
          return [...prev, data];
        });
      } else if (event === 'job_removed') {
        setJobs((prev) => prev.filter((j) => j.uuid !== data.uuid));
      } else if (event === 'sync_complete') {
        loadData();
        showToast(`Synced ${data.jobCount} jobs`);
      }
    });
    return unsub;
  }, [loadData]);

  async function handleMove(jobUuid, targetQueue) {
    const prev = jobs.find((j) => j.uuid === jobUuid);
    if (!prev || prev.queue_name === targetQueue) return;

    setJobs((cur) =>
      cur.map((j) => (j.uuid === jobUuid ? { ...j, queue_name: targetQueue } : j))
    );

    try {
      await moveJob(jobUuid, targetQueue);
    } catch {
      setJobs((cur) =>
        cur.map((j) => (j.uuid === jobUuid ? { ...j, queue_name: prev.queue_name } : j))
      );
      showToast('Failed to move job', 'error');
    }
  }

  async function handleSync() {
    setSyncing(true);
    try {
      await triggerSync();
    } catch {
      showToast('Sync failed', 'error');
    } finally {
      setSyncing(false);
    }
  }

  const filtered = search
    ? jobs.filter((j) => {
        const s = search.toLowerCase();
        return (
          j.generated_job_id?.toLowerCase().includes(s) ||
          j.company_name?.toLowerCase().includes(s) ||
          j.job_description?.toLowerCase().includes(s)
        );
      })
    : jobs;

  const jobsByQueue = new Map();
  for (const q of COLUMN_ORDER) jobsByQueue.set(q, []);
  for (const j of filtered) {
    const bucket = jobsByQueue.get(j.queue_name);
    if (bucket) bucket.push(j);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-lg text-slate-400 animate-pulse">Loading board…</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-slate-700 bg-slate-900 shrink-0">
        <h1 className="text-lg font-semibold text-sky-400 tracking-tight">Serene Kanban</h1>
        <div className="flex items-center gap-3">
          <input
            type="text"
            placeholder="Search jobs…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="px-3 py-1.5 rounded bg-slate-800 border border-slate-600 text-sm text-slate-200 placeholder-slate-500 w-56 focus:outline-none focus:border-sky-500"
          />
          <span className="text-xs text-slate-500">{jobs.length} jobs</span>
          <button
            onClick={handleSync}
            disabled={syncing}
            className="px-3 py-1.5 rounded bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-sm font-medium transition-colors"
          >
            {syncing ? 'Syncing…' : 'Sync'}
          </button>
        </div>
      </header>

      {/* Board */}
      <div className="flex-1 overflow-x-auto kanban-scroll p-4">
        <div className="flex gap-3 h-full" style={{ minWidth: 'max-content' }}>
          {COLUMN_ORDER.map((name) => (
            <Column
              key={name}
              name={name}
              jobs={jobsByQueue.get(name) || []}
              onDrop={handleMove}
              onCardClick={setSelectedJob}
            />
          ))}
        </div>
      </div>

      {/* Modal */}
      {selectedJob && (
        <JobModal job={selectedJob} onClose={() => setSelectedJob(null)} />
      )}

      {/* Toast */}
      {toast && <Toast message={toast.message} type={toast.type} />}
    </div>
  );
}
