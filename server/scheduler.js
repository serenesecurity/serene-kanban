function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isWorkday(date) {
  const day = date.getDay();
  return day >= 2 && day <= 5; // Tue-Fri
}

// Get next 4 weeks of Tue-Fri workdays starting from today
function getFutureWorkdays(numWeeks) {
  const days = [];
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const end = new Date(d);
  end.setDate(end.getDate() + numWeeks * 7);

  while (d <= end) {
    if (isWorkday(d)) days.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  return days;
}

const MAX_PER_DAY = 4;

export function buildSchedule(jobs) {
  const eligible = jobs.filter((j) => {
    if (j.status !== 'Work Order') return false;
    if (!j.generated_job_id || j.generated_job_id === 'SAMPLE') return false;
    if (!j.lat || !j.lng) return false;
    return true;
  });

  if (!eligible.length) return { scheduled: [], weeks: [] };

  const candidates = eligible.map((j) => {
    const payDate =
      j.payment_date && !j.payment_date.startsWith('0000') ? j.payment_date : null;
    const woDate =
      j.work_order_date && !j.work_order_date.startsWith('0000') ? j.work_order_date : null;

    return {
      uuid: j.uuid,
      jobId: j.generated_job_id,
      client: j.company_name || 'Unknown',
      address: j.job_address || '',
      lat: parseFloat(j.lat),
      lng: parseFloat(j.lng),
      amount: parseFloat(j.total_invoice_amount || 0),
      queue: j.queue_name || '',
      woDate: woDate ? new Date(woDate) : null,
      hasDeposit: !!payDate,
      hasSuffix: /[A-Za-z]$/.test(j.generated_job_id),
    };
  });

  // Priority sort: deposit paid first, then by WO date (oldest first)
  candidates.sort((a, b) => {
    if (a.hasDeposit !== b.hasDeposit) return a.hasDeposit ? -1 : 1;
    const da = a.woDate || new Date('2099-01-01');
    const db = b.woDate || new Date('2099-01-01');
    return da - db;
  });

  const workdays = getFutureWorkdays(5);
  const daySlots = new Map();
  for (const d of workdays) daySlots.set(d.toISOString().slice(0, 10), []);

  // Assign each job to the best day based on geographic clustering
  for (const cand of candidates) {
    let bestDay = null;
    let bestScore = Infinity;

    for (const [dayStr, existing] of daySlots) {
      if (existing.length >= MAX_PER_DAY) continue;

      if (existing.length === 0) {
        // Empty day — prefer earlier days for higher-priority jobs
        const dayIdx = [...daySlots.keys()].indexOf(dayStr);
        const score = 1000 + dayIdx;
        if (score < bestScore) { bestScore = score; bestDay = dayStr; }
      } else {
        // Has jobs — score by proximity
        const avgDist = existing.reduce(
          (sum, e) => sum + distanceKm(cand.lat, cand.lng, e.lat, e.lng), 0
        ) / existing.length;
        // Strong preference for clustering nearby (low distance = low score)
        const score = avgDist;
        if (score < bestScore) { bestScore = score; bestDay = dayStr; }
      }
    }

    if (bestDay) {
      daySlots.get(bestDay).push(cand);
    }
  }

  // Sort each day north-to-south and build output
  const scheduled = [];

  for (const [dayStr, dayJobs] of daySlots) {
    if (!dayJobs.length) continue;
    dayJobs.sort((a, b) => b.lat - a.lat);

    dayJobs.forEach((cand, idx) => {
      scheduled.push({
        uuid: cand.uuid,
        jobId: cand.jobId,
        client: cand.client,
        address: cand.address,
        amount: cand.amount,
        queue: cand.queue,
        installDate: dayStr,
        sequence: idx + 1,
        totalOnDay: dayJobs.length,
        hasDeposit: cand.hasDeposit,
        hasSuffix: cand.hasSuffix,
        nearby: dayJobs.length > 1
          ? dayJobs
              .filter((_, i) => i !== idx)
              .map((o) => ({
                jobId: o.jobId,
                client: o.client,
                dist: Math.round(distanceKm(cand.lat, cand.lng, o.lat, o.lng)),
              }))
          : [],
      });
    });
  }

  // Build week structure for calendar (next 5 weeks from today)
  const weeks = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // Monday of this week

  for (let w = 0; w < 5; w++) {
    const weekStart = new Date(start);
    weekStart.setDate(weekStart.getDate() + w * 7);
    const days = [];

    for (let d = 0; d < 5; d++) {
      const day = new Date(weekStart);
      day.setDate(day.getDate() + d);
      const dayStr = day.toISOString().slice(0, 10);
      const dayNum = day.getDay();

      days.push({
        date: dayStr,
        dayName: day.toLocaleDateString('en-AU', { weekday: 'short' }),
        dayNum: day.getDate(),
        month: day.toLocaleDateString('en-AU', { month: 'short' }),
        isWorkday: dayNum >= 2 && dayNum <= 5,
        jobs: scheduled.filter((s) => s.installDate === dayStr),
      });
    }

    const label = weekStart.toLocaleDateString('en-AU', { day: 'numeric', month: 'long' });
    weeks.push({ label: `Week of ${label}`, days });
  }

  return { scheduled, weeks, totalEligible: eligible.length };
}
