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
  return day >= 2 && day <= 5;
}

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
  const eligible = jobs.filter((j) => {
    if (j.status !== 'Work Order') return false;
    if (!j.generated_job_id || j.generated_job_id === 'SAMPLE') return false;
    if (!j.lat || !j.lng) return false;
    return true;
  });

  if (!eligible.length) return { scheduled: [], weeks: [] };

  const candidates = eligible.map((j) => {
    const payDate =
      j.payment_date && !j.payment_date.startsWith('0000')
        ? j.payment_date
        : null;
    const woDate =
      j.work_order_date && !j.work_order_date.startsWith('0000')
        ? j.work_order_date
        : null;
    const baseDate = new Date(payDate || woDate || j.edit_date);

    const windowStart = new Date(baseDate);
    windowStart.setDate(windowStart.getDate() + 20);
    const windowEnd = new Date(baseDate);
    windowEnd.setDate(windowEnd.getDate() + 25);

    return {
      uuid: j.uuid,
      jobId: j.generated_job_id,
      client: j.company_name || 'Unknown',
      address: j.job_address || '',
      lat: parseFloat(j.lat),
      lng: parseFloat(j.lng),
      amount: parseFloat(j.total_invoice_amount || 0),
      queue: j.queue_name || '',
      baseDate,
      windowStart,
      windowEnd,
      hasDeposit: !!payDate,
      hasSuffix: /[A-Za-z]$/.test(j.generated_job_id),
    };
  });

  // Sort by base date (earliest first)
  candidates.sort((a, b) => a.baseDate - b.baseDate);

  // Schedule into days using geographic clustering
  const daySlots = new Map();

  for (const cand of candidates) {
    const workdays = getWorkdays(cand.windowStart, cand.windowEnd);
    if (!workdays.length) {
      // Expand to nearest workday
      const d = new Date(cand.windowStart);
      for (let i = 0; i < 10; i++) {
        if (isWorkday(d)) { workdays.push(new Date(d)); break; }
        d.setDate(d.getDate() + 1);
      }
    }

    let bestDay = null;
    let bestScore = Infinity;

    for (const day of workdays) {
      const dayStr = day.toISOString().slice(0, 10);
      const existing = daySlots.get(dayStr) || [];

      if (existing.length === 0) {
        const midWindow = new Date(
          cand.windowStart.getTime() +
            (cand.windowEnd.getTime() - cand.windowStart.getTime()) / 2
        );
        const score = Math.abs(day - midWindow) / (1000 * 60 * 60 * 24);
        if (score < bestScore) { bestScore = score; bestDay = dayStr; }
      } else {
        const avgDist =
          existing.reduce(
            (sum, e) => sum + distanceKm(cand.lat, cand.lng, e.lat, e.lng),
            0
          ) / existing.length;
        const score = avgDist * 0.1;
        if (score < bestScore) { bestScore = score; bestDay = dayStr; }
      }
    }

    if (bestDay) {
      if (!daySlots.has(bestDay)) daySlots.set(bestDay, []);
      daySlots.get(bestDay).push(cand);
    }
  }

  // Sort each day north-to-south and build output
  const scheduled = [];
  const sortedDays = [...daySlots.keys()].sort();

  for (const dayStr of sortedDays) {
    const dayJobs = daySlots.get(dayStr);
    dayJobs.sort((a, b) => b.lat - a.lat);

    dayJobs.forEach((cand, idx) => {
      scheduled.push({
        uuid: cand.uuid,
        jobId: cand.jobId,
        client: cand.client,
        address: cand.address,
        amount: cand.amount,
        queue: cand.queue,
        baseDate: cand.baseDate.toISOString().slice(0, 10),
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

  // Build week structure for calendar
  const weeks = [];
  if (sortedDays.length) {
    const firstDay = new Date(sortedDays[0] + 'T00:00:00');
    const lastDay = new Date(sortedDays[sortedDays.length - 1] + 'T00:00:00');

    // Start from Monday of first week
    const start = new Date(firstDay);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));

    const end = new Date(lastDay);
    end.setDate(end.getDate() + (5 - end.getDay()));

    const d = new Date(start);
    let currentWeek = [];
    while (d <= end) {
      const dayStr = d.toISOString().slice(0, 10);
      const dayNum = d.getDay();
      if (dayNum >= 1 && dayNum <= 5) {
        currentWeek.push({
          date: dayStr,
          dayName: d.toLocaleDateString('en-AU', { weekday: 'short' }),
          dayNum: d.getDate(),
          month: d.toLocaleDateString('en-AU', { month: 'short' }),
          isWorkday: dayNum >= 2,
          jobs: scheduled.filter((s) => s.installDate === dayStr),
        });
      }
      if (dayNum === 5) {
        weeks.push({
          label: `Week of ${currentWeek[0]?.date || dayStr}`,
          days: currentWeek,
        });
        currentWeek = [];
      }
      d.setDate(d.getDate() + 1);
    }
    if (currentWeek.length) {
      weeks.push({ label: `Week of ${currentWeek[0]?.date}`, days: currentWeek });
    }
  }

  return { scheduled, weeks };
}
