import { useState } from 'react';
import JobCard from './JobCard.jsx';

export default function Column({ name, jobs, onDrop, onCardClick }) {
  const [dragOver, setDragOver] = useState(false);

  function handleDragOver(e) {
    e.preventDefault();
    setDragOver(true);
  }

  function handleDragLeave() {
    setDragOver(false);
  }

  function handleDrop(e) {
    e.preventDefault();
    setDragOver(false);
    const jobUuid = e.dataTransfer.getData('text/plain');
    if (jobUuid) onDrop(jobUuid, name);
  }

  return (
    <div
      className={`flex flex-col w-64 shrink-0 rounded-lg transition-colors ${
        dragOver ? 'drag-over' : ''
      }`}
      style={{ background: 'var(--column-bg)' }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-600">
        <h2 className="text-xs font-semibold text-slate-300 uppercase tracking-wider truncate">
          {name}
        </h2>
        <span className="text-xs text-slate-500 ml-1">{jobs.length}</span>
      </div>
      <div className="flex-1 overflow-y-auto column-scroll p-2 space-y-2">
        {jobs.length === 0 && (
          <div className="text-xs text-slate-600 text-center py-4">No jobs</div>
        )}
        {jobs.map((job) => (
          <JobCard key={job.uuid} job={job} onClick={() => onCardClick(job)} />
        ))}
      </div>
    </div>
  );
}
