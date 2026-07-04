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

function travelHours(km) {
  return Math.round((km / 40) * 10) / 10;
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

const ITEM_DURATION = [
  [/pivot.*door|pivot.*protect/i, 2.5],
  [/french.*door/i, 2.25],
  [/centre\s*close/i, 1.75],
  [/double\s*stacking/i, 2.0],
  [/zip\s*(blind|screen)|zipscreen|external.*blind|patio.*blind/i, 2.5],
  [/sliding.*door|sliding.*protect|sliding.*intrudaguard|sliding.*security|sliding.*grill/i, 1.25],
  [/hinged.*door|hinged.*protect|hinged.*intrudaguard|hinged.*security|hinged.*grill/i, 1.5],
  [/roller\s*blind|internal\s*blind|kleenscreen/i, 0.3],
  [/plantation\s*shutter/i, 0.5],
  [/window\s*screen|window.*mesh|window.*grill/i, 0.3],
];

const SKIP_PATTERNS = [
  /colour/i, /discount/i, /surcharge/i, /powder\s*coat/i, /partial\s*invoice/i,
  /credit\s*card/i, /processing\s*fee/i, /includes\s*supply/i, /framing\s*colour/i,
  /build-out/i, /accessori/i, /remote/i, /hub/i, /motor/i, /sensor/i,
  /ballast/i, /cassett/i, /cassette/i, /bolt\s*lock/i, /stop\s*bead/i, /jamb/i,
  /pet\s*door/i, /door\s*closer/i, /yale/i, /pricing\s*valid/i,
  /louver/i, /support\s*post/i, /track/i, /handle/i, /^fabric.*pelmet/i, /^pelmet\b/i,
  /^\*\*/i, /^price\s*based/i, /^ground\s*floor/i,
];

function deduplicateMaterials(materials) {
  // SM8 stores multiple revisions — take the last occurrence of each unique item name
  const seen = new Map();
  for (const m of materials) {
    const key = (m.name || '').trim().toLowerCase();
    if (!key) continue;
    seen.set(key, m);
  }
  return [...seen.values()];
}

function estimateFromMaterials(materials) {
  if (!materials || !materials.length) return { hours: 2, items: [], method: 'default' };

  const deduped = deduplicateMaterials(materials);
  const items = [];
  let totalHours = 0;

  for (const mat of deduped) {
    const name = mat.name || '';
    const qty = Math.max(0, mat.quantity || 0);
    if (qty <= 0) continue;
    if (SKIP_PATTERNS.some((p) => p.test(name))) continue;

    let matched = false;
    for (const [pattern, hoursPerUnit] of ITEM_DURATION) {
      if (pattern.test(name)) {
        const h = Math.round(hoursPerUnit * qty * 10) / 10;
        items.push({ label: name.split(' - ')[0].split(' -- ')[0].trim(), qty, hours: h });
        totalHours += h;
        matched = true;
        break;
      }
    }

    if (!matched) {
      items.push({ label: name.split(' - ')[0].split(' -- ')[0].trim(), qty, hours: qty });
      totalHours += qty;
    }
  }

  if (!items.length) return { hours: 2, items: [], method: 'default' };

  totalHours += 0.5; // setup buffer
  return { hours: Math.round(totalHours * 10) / 10, items, method: 'materials' };
}

// Find the deposit/suffix date from the "Partial invoice #XXXXA" line item
function findDepositDate(materials) {
  if (!materials) return null;
  for (const m of materials) {
    if (/^partial\s*invoice\s*#/i.test(m.name) && /[A-Za-z]$/i.test(m.name)) {
      if (m.edit_date && !m.edit_date.startsWith('0000')) {
        return new Date(m.edit_date);
      }
    }
  }
  return null;
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

export function buildSchedule(jobs, overrides = {}) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Find SM8-booked jobs (future bookings from dispatch board)
  const bookedJobs = [];
  const bookedUuids = new Set();
  for (const j of jobs) {
    if (j.status !== 'Work Order') continue;
    if (!j.generated_job_id || j.generated_job_id === 'SAMPLE') continue;
    const stamp = j.job_is_scheduled_until_stamp;
    if (!stamp || stamp.startsWith('0000')) continue;
    const bookedDate = new Date(stamp);
    if (isNaN(bookedDate.getTime())) continue;
    bookedDate.setHours(0, 0, 0, 0);
    if (bookedDate < today) continue;

    const est = estimateFromMaterials(j.materials);
    const hasPartialInvoice = (j.materials || []).some(
      m => /^partial\s*invoice\s*#.*[A-Za-z]$/i.test(m.name)
    );
    const hasPayment = j.payment_date && !j.payment_date.startsWith('0000');

    bookedJobs.push({
      uuid: j.uuid,
      jobId: j.generated_job_id,
      client: j.company_name || 'Unknown',
      address: j.job_address || '',
      lat: parseFloat(j.lat || 0),
      lng: parseFloat(j.lng || 0),
      amount: parseFloat(j.total_invoice_amount_combined ?? j.total_invoice_amount ?? 0),
      hours: est.hours,
      items: est.items,
      estMethod: est.method,
      queue: j.queue_name || '',
      hasDeposit: hasPartialInvoice || hasPayment,
      hasSuffix: hasPartialInvoice,
      depositDate: findDepositDate(j.materials),
      booked: true,
      bookedDate: bookedDate.toISOString().slice(0, 10),
    });
    bookedUuids.add(j.uuid);
  }

  // All deposit-confirmed WOs not already booked
  const allDeposit = jobs.filter((j) => {
    if (bookedUuids.has(j.uuid)) return false;
    if (j.status !== 'Work Order') return false;
    if (!j.generated_job_id || j.generated_job_id === 'SAMPLE') return false;
    if (!j.lat || !j.lng) return false;
    const hasPartialInvoice = (j.materials || []).some(
      m => /^partial\s*invoice\s*#.*[A-Za-z]$/i.test(m.name)
    );
    const hasPayment = j.payment_date && !j.payment_date.startsWith('0000');
    return hasPartialInvoice || hasPayment;
  });

  // All deposit-confirmed WOs are eligible for auto-scheduling.
  // Order form date controls the preferred scheduling window (18-25 days after order);
  // jobs with no order form or a recent order form fall back to next available slot.
  const eligible = allDeposit;
  const sidebarJobs = [];

  if (!eligible.length && !bookedJobs.length && !sidebarJobs.length) return { scheduled: [], unscheduled: [], weeks: [], totalEligible: 0 };

  const candidates = eligible.map((j) => {
    const hasPartialInvoice = (j.materials || []).some(
      m => /^partial\s*invoice\s*#.*[A-Za-z]$/i.test(m.name)
    );
    const hasSuffix = hasPartialInvoice;
    const hasPayment = j.payment_date && !j.payment_date.startsWith('0000');
    const amount = parseFloat(j.total_invoice_amount || 0);
    const est = estimateFromMaterials(j.materials);
    const depositDate = findDepositDate(j.materials);

    return {
      uuid: j.uuid,
      jobId: j.generated_job_id,
      client: j.company_name || 'Unknown',
      address: j.job_address || '',
      lat: parseFloat(j.lat),
      lng: parseFloat(j.lng),
      amount,
      hours: est.hours,
      items: est.items,
      estMethod: est.method,
      queue: j.queue_name || '',
      hasDeposit: hasSuffix || hasPayment,
      hasSuffix,
      depositDate,
      orderFormDate: j.order_form_sent_date ? new Date(j.order_form_sent_date) : null,
      booked: false,
    };
  });

  // Apply overrides: remove or pin jobs
  const pinned = []; // jobs with a forced date
  const removed = new Set();
  for (const cand of candidates) {
    const ov = overrides[cand.uuid];
    if (ov?.removed) { removed.add(cand.uuid); continue; }
    if (ov?.installDate) { cand.pinnedDate = ov.installDate; pinned.push(cand); }
  }
  const unpinned = candidates.filter(c => !removed.has(c.uuid) && !c.pinnedDate);

  // Deposit first, then big jobs first
  unpinned.sort((a, b) => {
    if (a.hasDeposit !== b.hasDeposit) return a.hasDeposit ? -1 : 1;
    return b.hours - a.hours;
  });

  const unscheduled = [];

  // Calculate the scheduling range — 8 weeks from today
  const scheduleEnd = new Date(today);
  scheduleEnd.setDate(scheduleEnd.getDate() + 56);

  const dayHours = new Map();
  const dayJobs = new Map();
  // Build all workdays in range
  const d = new Date(today);
  d.setDate(d.getDate() + 1);
  while (d <= scheduleEnd) {
    if (isWorkday(d)) {
      const s = d.toISOString().slice(0, 10);
      dayHours.set(s, 0);
      dayJobs.set(s, []);
    }
    d.setDate(d.getDate() + 1);
  }

  // Place SM8-booked jobs first (confirmed bookings from dispatch board)
  for (const bj of bookedJobs) {
    const dayStr = bj.bookedDate;
    if (!dayHours.has(dayStr)) {
      dayHours.set(dayStr, 0);
      dayJobs.set(dayStr, []);
    }
    dayJobs.get(dayStr).push(bj);
    dayHours.set(dayStr, dayHours.get(dayStr) + bj.hours);
  }

  // Place pinned jobs first
  for (const cand of pinned) {
    const dayStr = cand.pinnedDate;
    if (!dayHours.has(dayStr)) {
      // Add the day even if it's not a normal workday
      dayHours.set(dayStr, 0);
      dayJobs.set(dayStr, []);
    }
    dayJobs.get(dayStr).push(cand);
    dayHours.set(dayStr, dayHours.get(dayStr) + cand.hours);
  }

  for (const cand of unpinned) {
    // Determine which days this job can be scheduled
    let allowedDays;
    if (cand.orderFormDate) {
      // Schedule from 18-25 days after order form sent (2.5-3.5 week ready window)
      const winStart = new Date(cand.orderFormDate);
      winStart.setDate(winStart.getDate() + 18);
      const winEnd = new Date(cand.orderFormDate);
      winEnd.setDate(winEnd.getDate() + 25);
      allowedDays = getWorkdays(winStart, winEnd).map(d => d.toISOString().slice(0, 10));
      // If window is entirely in the past or no workdays with capacity, expand to any future day
      const futureDays = allowedDays.filter(d => dayHours.has(d));
      if (!futureDays.length) allowedDays = [...dayHours.keys()];
      else allowedDays = futureDays;
    } else {
      allowedDays = [...dayHours.keys()];
    }

    let remaining = cand.hours;
    const dayKeys = [...dayHours.keys()];

    // Multi-day jobs
    if (remaining > DAY_CAPACITY) {
      let assigned = false;
      for (let i = 0; i < dayKeys.length; i++) {
        let totalAvail = 0;
        let span = 0;
        for (let j = i; j < dayKeys.length && totalAvail < remaining; j++) {
          const avail = DAY_CAPACITY - dayHours.get(dayKeys[j]);
          if (avail < 2) break;
          totalAvail += avail;
          span++;
        }
        if (totalAvail >= remaining) {
          let rem = remaining;
          for (let j = i; j < i + span && rem > 0; j++) {
            const avail = DAY_CAPACITY - dayHours.get(dayKeys[j]);
            const use = Math.min(avail, rem);
            const part = { ...cand, hours: use, multiDay: true, dayPart: `Day ${j - i + 1} of ${span}` };
            dayJobs.get(dayKeys[j]).push(part);
            dayHours.set(dayKeys[j], dayHours.get(dayKeys[j]) + use);
            rem -= use;
          }
          assigned = true;
          break;
        }
      }
      if (!assigned) unscheduled.push(cand);
      continue;
    }

    // Single-day with proximity clustering — only within allowed days
    let bestDay = null;
    let bestScore = Infinity;

    for (const dayStr of allowedDays) {
      if (!dayHours.has(dayStr)) continue;
      const usedHours = dayHours.get(dayStr);
      const existing = dayJobs.get(dayStr);
      const travelEst = existing.length > 0
        ? travelHours(distanceKm(cand.lat, cand.lng, existing[existing.length - 1].lat, existing[existing.length - 1].lng))
        : travelHours(distanceKm(HOME_LAT, HOME_LNG, cand.lat, cand.lng));

      if (usedHours + cand.hours + travelEst > DAY_CAPACITY) continue;

      if (existing.length === 0) {
        const dayIdx = dayKeys.indexOf(dayStr);
        const score = 1000 + dayIdx;
        if (score < bestScore) { bestScore = score; bestDay = dayStr; }
      } else {
        const avgDist = existing.reduce(
          (sum, e) => sum + distanceKm(cand.lat, cand.lng, e.lat, e.lng), 0
        ) / existing.length;
        if (avgDist < bestScore) { bestScore = avgDist; bestDay = dayStr; }
      }
    }

    // Fallback: search ALL future days if allowed window had no capacity
    if (!bestDay) {
      for (const dayStr of dayKeys) {
        if (allowedDays.includes(dayStr)) continue;
        const usedHours = dayHours.get(dayStr);
        const existing = dayJobs.get(dayStr);
        const travelEst = existing.length > 0
          ? travelHours(distanceKm(cand.lat, cand.lng, existing[existing.length - 1].lat, existing[existing.length - 1].lng))
          : travelHours(distanceKm(HOME_LAT, HOME_LNG, cand.lat, cand.lng));
        if (usedHours + cand.hours + travelEst > DAY_CAPACITY) continue;
        bestDay = dayStr;
        break;
      }
    }

    if (bestDay) {
      const existing = dayJobs.get(bestDay);
      const travelEst = existing.length > 0
        ? travelHours(distanceKm(cand.lat, cand.lng, existing[existing.length - 1].lat, existing[existing.length - 1].lng))
        : travelHours(distanceKm(HOME_LAT, HOME_LNG, cand.lat, cand.lng));
      dayJobs.get(bestDay).push(cand);
      dayHours.set(bestDay, dayHours.get(bestDay) + cand.hours + travelEst);
    } else {
      unscheduled.push(cand);
    }
  }

  // Route and build output
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
        booked: cand.booked || false,
        hasDeposit: cand.hasDeposit,
        hasSuffix: cand.hasSuffix,
        depositDate: cand.depositDate ? cand.depositDate.toISOString().slice(0, 10) : null,
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
  const start = new Date(today);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));

  for (let w = 0; w < 8; w++) {
    const weekStart = new Date(start);
    weekStart.setDate(weekStart.getDate() + w * 7);
    const days = [];

    for (let di = 0; di < 5; di++) {
      const day = new Date(weekStart);
      day.setDate(day.getDate() + di);
      const dayStr = day.toISOString().slice(0, 10);
      const dayNum = day.getDay();
      const dJobs = scheduled.filter((s) => s.installDate === dayStr);
      const hoursUsed = dayHours.has(dayStr)
        ? Math.round(dayHours.get(dayStr) * 10) / 10
        : 0;

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

  // Handle sidebar jobs: pinned ones go on calendar, rest go to unscheduled
  for (const j of sidebarJobs) {
    const ov = overrides[j.uuid];
    if (ov?.removed) continue;
    const est = estimateFromMaterials(j.materials);
    const hasPartialInvoice = (j.materials || []).some(
      m => /^partial\s*invoice\s*#.*[A-Za-z]$/i.test(m.name)
    );
    const hasPayment = j.payment_date && !j.payment_date.startsWith('0000');

    if (ov?.installDate) {
      // Manually placed on calendar via drag — add to the day
      const dayStr = ov.installDate;
      if (!dayHours.has(dayStr)) { dayHours.set(dayStr, 0); dayJobs.set(dayStr, []); }
      const cand = {
        uuid: j.uuid, jobId: j.generated_job_id, client: j.company_name || 'Unknown',
        address: j.job_address || '', lat: parseFloat(j.lat || 0), lng: parseFloat(j.lng || 0),
        amount: parseFloat(j.total_invoice_amount_combined ?? j.total_invoice_amount ?? 0), hours: est.hours, items: est.items,
        estMethod: est.method, queue: j.queue_name || '', hasDeposit: hasPartialInvoice || hasPayment,
        hasSuffix: hasPartialInvoice, depositDate: findDepositDate(j.materials), booked: false,
      };
      dayJobs.get(dayStr).push(cand);
      dayHours.set(dayStr, dayHours.get(dayStr) + cand.hours);
      continue;
    }

    const orderSent = j.order_form_sent_date ? Math.floor((today - new Date(j.order_form_sent_date)) / (1000 * 60 * 60 * 24)) : null;
    unscheduled.push({
      uuid: j.uuid, jobId: j.generated_job_id, client: j.company_name || 'Unknown',
      hours: est.hours, items: est.items, hasDeposit: hasPartialInvoice || hasPayment, orderDaysAgo: orderSent,
    });
  }

  return { scheduled, unscheduled, weeks, totalEligible: eligible.length };
}
