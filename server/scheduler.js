// Scarborough QLD home base
const HOME_LAT = -27.2036;
const HOME_LNG = 153.1056;

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

// Estimate install hours based on job value
function estimateHours(amount) {
  if (amount >= 2500) return 7; // large — nearly full day
  if (amount >= 800) return 4;  // medium — half day
  return 2;                      // small — quick install
}

function sizeLabel(hours) {
  if (hours >= 7) return 'Full day';
  if (hours >= 4) return 'Half day';
  return '~2hrs';
}

const DAY_CAPACITY = 8; // hours

// Nearest-neighbour route from home base
function routeOrder(jobs) {
  if (jobs.length <= 1) return jobs;
  const ordered = [];
  const remaining = [...jobs];
  let curLat = HOME_LAT;
  let curLng = HOME_LNG;

  while (remaining.length) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = distanceKm(curLat, curLng, remaining[i].lat, remaining[i].lng);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    const next = remaining.splice(bestIdx, 1)[0];
    ordered.push(next);
    curLat = next.lat;
    curLng = next.lng;
  }
  return ordered;
}

function getFutureWorkdays(numWeeks) {
  const days = [];
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  // Start from tomorrow if today is already a workday
  d.setDate(d.getDate() + 1);
  const end = new Date(d);
  end.setDate(end.getDate() + numWeeks * 7);
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

  if (!eligible.length) return { scheduled: [], weeks: [], totalEligible: 0 };

  const candidates = eligible.map((j) => {
    const payDate =
      j.payment_date && !j.payment_date.startsWith('0000') ? j.payment_date : null;
    const amount = parseFloat(j.total_invoice_amount || 0);

    return {
      uuid: j.uuid,
      jobId: j.generated_job_id,
      client: j.company_name || 'Unknown',
      address: j.job_address || '',
      lat: parseFloat(j.lat),
      lng: parseFloat(j.lng),
      amount,
      hours: estimateHours(amount),
      queue: j.queue_name || '',
      hasDeposit: !!payDate,
      hasSuffix: /[A-Za-z]$/.test(j.generated_job_id),
      distFromHome: distanceKm(HOME_LAT, HOME_LNG, parseFloat(j.lat), parseFloat(j.lng)),
    };
  });

  // Priority: deposit paid first, then oldest WO date
  candidates.sort((a, b) => {
    if (a.hasDeposit !== b.hasDeposit) return a.hasDeposit ? -1 : 1;
    return 0;
  });

  const workdays = getFutureWorkdays(5);
  // Track hours used per day
  const dayHours = new Map();
  const dayJobs = new Map();
  for (const d of workdays) {
    const s = d.toISOString().slice(0, 10);
    dayHours.set(s, 0);
    dayJobs.set(s, []);
  }

  // Assign jobs to days respecting capacity
  for (const cand of candidates) {
    let bestDay = null;
    let bestScore = Infinity;

    for (const [dayStr, usedHours] of dayHours) {
      if (usedHours + cand.hours > DAY_CAPACITY) continue;

      const existing = dayJobs.get(dayStr);

      if (existing.length === 0) {
        // Empty day — use day index as tiebreaker (fill earlier days first)
        const dayIdx = [...dayHours.keys()].indexOf(dayStr);
        const score = 1000 + dayIdx;
        if (score < bestScore) { bestScore = score; bestDay = dayStr; }
      } else {
        // Proximity to existing jobs on this day
        const avgDist = existing.reduce(
          (sum, e) => sum + distanceKm(cand.lat, cand.lng, e.lat, e.lng), 0
        ) / existing.length;
        if (avgDist < bestScore) { bestScore = avgDist; bestDay = dayStr; }
      }
    }

    if (bestDay) {
      dayJobs.get(bestDay).push(cand);
      dayHours.set(bestDay, dayHours.get(bestDay) + cand.hours);
    }
  }

  // Route each day's jobs using nearest-neighbour from home
  const scheduled = [];
  for (const [dayStr, jobs] of dayJobs) {
    if (!jobs.length) continue;
    const routed = routeOrder(jobs);

    routed.forEach((cand, idx) => {
      scheduled.push({
        uuid: cand.uuid,
        jobId: cand.jobId,
        client: cand.client,
        address: cand.address,
        amount: cand.amount,
        hours: cand.hours,
        sizeLabel: sizeLabel(cand.hours),
        queue: cand.queue,
        installDate: dayStr,
        sequence: idx + 1,
        totalOnDay: routed.length,
        dayHoursUsed: dayHours.get(dayStr),
        hasDeposit: cand.hasDeposit,
        hasSuffix: cand.hasSuffix,
        distFromHome: Math.round(cand.distFromHome),
        nearby: routed.length > 1
          ? routed
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

  // Build 5-week calendar
  const weeks = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));

  for (let w = 0; w < 5; w++) {
    const weekStart = new Date(start);
    weekStart.setDate(weekStart.getDate() + w * 7);
    const days = [];

    for (let d = 0; d < 5; d++) {
      const day = new Date(weekStart);
      day.setDate(day.getDate() + d);
      const dayStr = day.toISOString().slice(0, 10);
      const dayNum = day.getDay();
      const dJobs = scheduled.filter((s) => s.installDate === dayStr);
      const hoursUsed = dJobs.reduce((sum, j) => sum + j.hours, 0);

      days.push({
        date: dayStr,
        dayName: day.toLocaleDateString('en-AU', { weekday: 'short' }),
        dayNum: day.getDate(),
        month: day.toLocaleDateString('en-AU', { month: 'short' }),
        isWorkday: dayNum >= 2 && dayNum <= 5,
        jobs: dJobs,
        hoursUsed,
        capacity: DAY_CAPACITY,
      });
    }

    const label = weekStart.toLocaleDateString('en-AU', { day: 'numeric', month: 'long' });
    weeks.push({ label: `Week of ${label}`, days });
  }

  return { scheduled, weeks, totalEligible: eligible.length };
}
