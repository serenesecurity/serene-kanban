export default function JobCard({ job, onClick }) {
  const isQuote = job.status === 'Quote';
  const amount = parseFloat(job.total_amount_including_tax || 0);

  function handleDragStart(e) {
    e.dataTransfer.setData('text/plain', job.uuid);
    e.currentTarget.classList.add('dragging');
  }

  function handleDragEnd(e) {
    e.currentTarget.classList.remove('dragging');
  }

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onClick={onClick}
      className="rounded-md p-2.5 cursor-pointer hover:brightness-110 transition-all"
      style={{ background: 'var(--card-bg)' }}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-mono text-slate-400">{job.generated_job_id}</span>
        <span
          className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
            isQuote
              ? 'bg-orange-500/20 text-orange-400'
              : 'bg-sky-500/20 text-sky-400'
          }`}
        >
          {isQuote ? 'Q' : 'WO'}
        </span>
      </div>
      <div className="text-sm font-medium text-slate-200 truncate">
        {job.company_name || 'No client'}
      </div>
      {job.job_description && (
        <div className="text-xs text-slate-400 mt-0.5 line-clamp-2">
          {job.job_description}
        </div>
      )}
      {amount > 0 && (
        <div className="text-xs text-emerald-400 mt-1 font-medium">
          ${amount.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
        </div>
      )}
    </div>
  );
}
