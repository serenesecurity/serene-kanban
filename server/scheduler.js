// Haversine distance in km between two lat/lng points
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

// Check if date is Tue-Fri (2=Tue, 5=Fri)
function isWorkday(date) {
  const day = date.getDay();
  return day >= 2 && day <= 5;
}

// Get all valid workdays in a range
function getWorkdays(start, end) {
  const days = [];
  const d = new Date(start);
  while (d <= end) {
    if (isWorkday(d)) days.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  return days;
}

export function buildSchedule(jobs) {
  // Step 1: Find eligible jobs (letter suffix in job number = deposit confirmed)
  const eligible = jobs.filter((j) => {
    if (j.status !== 'Work Order') return false;
    if (!j.generated_job_id || !/[A-Za-z]$/.test(j.generated_job_id)) return false;
    if (j.generated_job_id === 'SAMPLE') return false;
    return true;
  });

  if (!eligible.length) return { scheduled: [], unschedulable: [] };

  // Step 2: Calculate target windows (20-25 days after deposit)
  const candidates = eligible.map((j) => {
    const payDate = j.payment_date && !j.payment_date.startsWith('0000') ? j.payment_date : null;
    const woDate = j.work_order_date && !j.work_order_date.startsWith('0000') ? j.work_order_date : null;
    const depositDate = new Date(payDate || woDate || j.edit_date);
    const windowStart = new Date(depositDate);
    windowStart.setDate(windowStart.getDate() + 20);
    const windowEnd = new Date(depositDate);
    windowEnd.setDate(windowEnd.getDate() + 25);
    const workdays = getWorkdays(windowStart, windowEnd);
    return {
      uuid: j.uuid,
      jobId: j.generated_job_id,
      client: j.company_name || 'Unknown',
      address: j.job_address || '',
      lat: parseFloat(j.lat),
      lng: parseFloat(j.lng),
      depositDate,
      windowStart,
      windowEnd,
      workdays,
      amount: parseFloat(j.total_invoice_amount || 0),
    };
  });

  const unschedulable = candidates.filter((c) => c.workdays.length === 0);
  const schedulable = candidates.filter((c) => c.workdays.length > 0);

  // Step 3: Group into days using geographic clustering
  const daySlots = new Map(); // dateStr -> [{candidate, sequence}]

  // Sort by deposit date so earlier deposits get scheduled first
  schedulable.sort((a, b) => a.depositDate - b.depositDate);

  for (const cand of schedulable) {
    let bestDay = null;
    let bestScore = Infinity;

    for (const day of cand.workdays) {
      const dayStr = day.toISOString().slice(0, 10);
      const existing = daySlots.get(dayStr) || [];

      if (existing.length === 0) {
        // Empty day — prefer days that are closer to the middle of the window
        const midWindow = new Date(
          cand.windowStart.getTime() +
            (cand.windowEnd.getTime() - cand.windowStart.getTime()) / 2
        );
        const dayDiff = Math.abs(day - midWindow) / (1000 * 60 * 60 * 24);
        if (dayDiff < bestScore) {
          bestScore = dayDiff;
          bestDay = dayStr;
        }
      } else {
        // Has existing jobs — score by average distance to them
        const avgDist =
          existing.reduce(
            (sum, e) => sum + distanceKm(cand.lat, cand.lng, e.lat, e.lng),
            0
          ) / existing.length;
        // Proximity bonus: closer jobs get much better scores
        const score = avgDist * 0.1;
        if (score < bestScore) {
          bestScore = score;
          bestDay = dayStr;
        }
      }
    }

    if (bestDay) {
      if (!daySlots.has(bestDay)) daySlots.set(bestDay, []);
      daySlots.get(bestDay).push(cand);
    }
  }

  // Step 4: Sort each day's jobs geographically (north to south)
  const scheduled = [];
  const sortedDays = [...daySlots.keys()].sort();

  for (const dayStr of sortedDays) {
    const dayJobs = daySlots.get(dayStr);
    // Sort north to south (highest lat first)
    dayJobs.sort((a, b) => b.lat - a.lat);

    dayJobs.forEach((cand, idx) => {
      scheduled.push({
        uuid: cand.uuid,
        jobId: cand.jobId,
        client: cand.client,
        address: cand.address,
        amount: cand.amount,
        depositDate: cand.depositDate.toISOString().slice(0, 10),
        installDate: dayStr,
        sequence: idx + 1,
        totalOnDay: dayJobs.length,
        nearby:
          dayJobs.length > 1
            ? dayJobs
                .filter((_, i) => i !== idx)
                .map((o) => ({
                  jobId: o.jobId,
                  dist: Math.round(distanceKm(cand.lat, cand.lng, o.lat, o.lng)),
                }))
            : [],
      });
    });
  }

  return {
    scheduled,
    unschedulable: unschedulable.map((c) => ({
      jobId: c.jobId,
      client: c.client,
      depositDate: c.depositDate.toISOString().slice(0, 10),
      reason: 'No Tue-Fri workdays in 20-25 day window',
    })),
  };
}
