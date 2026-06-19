import { useEffect } from 'react';

export default function JobModal({ job, onClose }) {
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const amount = parseFloat(job.total_amount_including_tax || 0);

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-slate-800 rounded-xl max-w-lg w-full max-h-[80vh] overflow-y-auto shadow-2xl">
        <div className="flex items-center justify-between p-4 border-b border-slate-700">
          <div>
            <span className="text-xs text-slate-400 font-mono">{job.generated_job_id}</span>
            <h2 className="text-lg font-semibold text-slate-100">
              {job.company_name || 'No client'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 text-xl leading-none"
          >
            ×
          </button>
        </div>

        <div className="p-4 space-y-3 text-sm">
          <Row label="Queue" value={job.queue_name} />
          <Row label="Status" value={job.status} />
          <Row label="Description" value={job.job_description} />
          <Row label="Address" value={job.job_address} />
          <Row
            label="Created"
            value={job.date ? new Date(job.date).toLocaleDateString('en-AU') : '—'}
          />
          {amount > 0 && (
            <Row
              label="Amount"
              value={`$${amount.toLocaleString('en-AU', { minimumFractionDigits: 2 })}`}
            />
          )}
          {job.work_done_description && (
            <Row label="Notes" value={job.work_done_description} />
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }) {
  if (!value) return null;
  return (
    <div>
      <dt className="text-xs text-slate-500 uppercase tracking-wider">{label}</dt>
      <dd className="text-slate-200 mt-0.5 whitespace-pre-wrap">{value}</dd>
    </div>
  );
}
