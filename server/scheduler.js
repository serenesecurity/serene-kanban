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

// Estimate drive time: ~1.5 min per km (avg suburban speed ~40km/h)
function travelHours(km) {
  return Math.round((km / 40) * 10) / 10;
}

function isWorkday(date) {
  const day = date.getDay();
  return day >= 2 && day <= 5;
}

const ITEM_PATTERNS = [
  [/pivot\s*door/gi, 2.5, 'Pivot Door'],
  [/french\s*door/gi, 2.25, 'French Door'],
  [/centre\s*close/gi, 1.75, 'Centre Close'],
  [/double\s*stack/gi, 2.0, 'Double Stacking'],
  [/outdoor\s*blind|patio\s*blind|external\s*blind|zip\s*screen/gi, 2.5, 'Outdoor Blind'],
  [/sliding\s*(screen|door|security)/gi, 1.25, 'Sliding Door'],
  [/sliding/gi, 1.25, 'Sliding Door'],
  [/hinged\s*(door|screen)/gi, 1.5, 'Hinged Door'],
  [/roller\s*blind|internal\s*blind/gi, 0.3, 'Roller Blind'],
  [/window\s*(screen|security)|security\s*screen/gi, 0.3, 'Window Screen'],
  [/window/gi, 0.3, 'Window Screen'],
  [/blind/gi, 0.3, 'Blind'],
  [/door/gi, 1.25, 'Door'],
  [/screen/gi, 0.3, 'Screen'],
];

function estimateFromDescription(desc, amount) {
  if (!desc || !desc.trim()) {
    // Fallback to amount-based estimate
    if (amount >= 5000) return { hours: 14, items: [{ label: 'Large job (est.)', qty: 1, hours: 14 }], method: 'amount' };
    if (amount >= 2500) return { hours: 7, items: [{ label: 'Medium job (est.)', qty: 1, hours: 7 }], method: 'amount' };
    if (amount >= 800) return { hours: 4, items: [{ label: 'Standard job (est.)', qty: 1, hours: 4 }], method: 'amount' };
    return { hours: 2, items: [], method: 'default' };
  }

  const text = desc.toLowerCase();
  const items = [];
  let totalHours = 0;
  const used = new Set();

  for (const [pattern, hours, label] of ITEM_PATTERNS) {
    const matches = text.match(pattern);
    if (!matches) continue;

    for (const m of matches) {
      const pos = text.indexOf(m);
      let skip = false;
      for (const u of used) {
        if (Math.abs(pos - u) < m.length + 5) { skip = true; break; }
      }
      if (skip) continue;
      used.add(pos);

      const before = desc.substring(Math.max(0, pos - 15), pos);
      const qtyMatch = before.match(/(\d+)\s*(?:x\s*)?$/i);
      const qty = qtyMatch ? parseInt(qtyMatch[1]) : 1;

      items.push({ label, qty, hours: Math.round(hours * qty * 10) / 10 });
      totalHours += hours * qty;
    }
  }

  if (!items.length) {
    if (amount >= 5000) return { hours: 14, items: [{ label: 'Large job (est.)', qty: 1, hours: 14 }], method: 'amount' };
    if (amount >= 2500) return { hours: 7, items: [{ label: 'Medium job (est.)', qty: 1, hours: 7 }], method: 'amount' };
    return { hours: 2, items: [], method: 'default' };
  }

  // Setup/cleanup buffer per job
  totalHours += 0.5;

  return { hours: Math.round(totalHours * 10) / 10, items, method: 'items' };
}

function sizeLabel(hours) {
  if (hours >= 12) return 'Multi-day';
  if (hours >= 6) return 'Full day';
  if (hours >= 3) return 'Half day';
  return 'Quick';
}

const DAY_CAPACITY = 8;

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

// Calculate travel time for a routed list of jobs (from home, between jobs)
function addTravelTime(routed) {
  let prevLat = HOME_LAT;
  let prevLng = HOME_LNG;

  for (const job of routed) {
    const km = distanceKm(prevLat, prevLng, job.lat, job.lng);
    job.travelKm = Math.round(km);
    job.travelHours = travelHours(km);
    prevLat = job.lat;
    prevLng = job.lng;
  }
}

function getFutureWorkdays(numWeeks) {
  const days = [];
  const d = new Date();
  d.setHours(0, 0, 0, 0);
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
    const hasSuffix = /[A-Za-z]$/.test(j.generated_job_id);
    const hasPayment = j.payment_date && !j.payment_date.startsWith('0000');
    const amount = parseFloat(j.total_invoice_amount || 0);
    const est = estimateFromDescription(j.job_description, amount);

    return {
      uuid: j.uuid,
      jobId: j.generated_job_id,
      client: j.company_name || 'Unknown',
      address: j.job_address || '',
      description: j.job_description || '',
      lat: parseFloat(j.lat),
      lng: parseFloat(j.lng),
      amount,
      hours: est.hours,
      items: est.items,
      estMethod: est.method,
      queue: j.queue_name || '',
      hasDeposit: hasSuffix || hasPayment,
      hasSuffix,
    };
  });

  // Deposit first, then by hours descending (big jobs get priority for space)
  candidates.sort((a, b) => {
    if (a.hasDeposit !== b.hasDeposit) return a.hasDeposit ? -1 : 1;
    return b.hours - a.hours;
  });

  const workdays = getFutureWorkdays(5);
  const dayHours = new Map();
  const dayJobs = new Map();
  for (const d of workdays) {
    const s = d.toISOString().slice(0, 10);
    dayHours.set(s, 0);
    dayJobs.set(s, []);
  }

  for (const cand of candidates) {
    // Multi-day jobs: split across consecutive workdays
    let remaining = cand.hours;
    const dayKeys = [...dayHours.keys()];
    let assigned = false;

    if (remaining > DAY_CAPACITY) {
      // Find consecutive workdays with enough total capacity
      for (let i = 0; i < dayKeys.length; i++) {
        let totalAvail = 0;
        let span = 0;
        for (let j = i; j < dayKeys.length && totalAvail < remaining; j++) {
          const avail = DAY_CAPACITY - dayHours.get(dayKeys[j]);
          if (avail <= 0) break;
          totalAvail += avail;
          span++;
        }
        if (totalAvail >= remaining) {
          for (let j = i; j < i + span && remaining > 0; j++) {
            const avail = DAY_CAPACITY - dayHours.get(dayKeys[j]);
            const use = Math.min(avail, remaining);
            const part = { ...cand, hours: use, multiDay: true, dayPart: `Day ${j - i + 1} of ${span}` };
            dayJobs.get(dayKeys[j]).push(part);
            dayHours.set(dayKeys[j], dayHours.get(dayKeys[j]) + use);
            remaining -= use;
          }
          assigned = true;
          break;
        }
      }
    }

    if (!assigned) {
      // Single-day assignment with proximity clustering
      let bestDay = null;
      let bestScore = Infinity;

      for (const [dayStr, usedHours] of dayHours) {
        const existing = dayJobs.get(dayStr);
        // Check capacity including estimated travel
        const travelEst = existing.length > 0
          ? travelHours(distanceKm(cand.lat, cand.lng,
              existing[existing.length - 1].lat, existing[existing.length - 1].lng))
          : travelHours(distanceKm(HOME_LAT, HOME_LNG, cand.lat, cand.lng));

        if (usedHours + cand.hours + travelEst > DAY_CAPACITY) continue;

        if (existing.length === 0) {
          const dayIdx = [...dayHours.keys()].indexOf(dayStr);
          const score = 1000 + dayIdx;
          if (score < bestScore) { bestScore = score; bestDay = dayStr; }
        } else {
          const avgDist = existing.reduce(
            (sum, e) => sum + distanceKm(cand.lat, cand.lng, e.lat, e.lng), 0
          ) / existing.length;
          if (avgDist < bestScore) { bestScore = avgDist; bestDay = dayStr; }
        }
      }

      if (bestDay) {
        dayJobs.get(bestDay).push(cand);
        const travelEst = dayJobs.get(bestDay).length > 1
          ? travelHours(distanceKm(cand.lat, cand.lng,
              dayJobs.get(bestDay)[dayJobs.get(bestDay).length - 2].lat,
              dayJobs.get(bestDay)[dayJobs.get(bestDay).length - 2].lng))
          : travelHours(distanceKm(HOME_LAT, HOME_LNG, cand.lat, cand.lng));
        dayHours.set(bestDay, dayHours.get(bestDay) + cand.hours + travelEst);
      }
    }
  }

  // Route each day and calculate travel
  const scheduled = [];
  for (const [dayStr, jobs] of dayJobs) {
    if (!jobs.length) continue;
    const routed = routeOrder(jobs);
    addTravelTime(routed);

    routed.forEach((cand, idx) => {
      scheduled.push({
        uuid: cand.uuid,
        jobId: cand.jobId,
        client: cand.client,
        address: cand.address,
        amount: cand.amount,
        hours: cand.hours,
        sizeLabel: sizeLabel(cand.hours),
        items: cand.items,
        estMethod: cand.estMethod,
        queue: cand.queue,
        installDate: dayStr,
        sequence: idx + 1,
        totalOnDay: routed.length,
        dayHoursUsed: Math.round(dayHours.get(dayStr) * 10) / 10,
        hasDeposit: cand.hasDeposit,
        hasSuffix: cand.hasSuffix,
        travelKm: cand.travelKm || 0,
        travelMins: Math.round((cand.travelHours || 0) * 60),
        multiDay: cand.multiDay || false,
        dayPart: cand.dayPart || null,
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
      const hoursUsed = dJobs.length ? Math.round(dayHours.get(dayStr) * 10) / 10 : 0;

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
