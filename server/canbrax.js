// Canbrax lead-time rules.
// Canbrax manufactures our SecureView (SV), Xceed (XC) and BasiX (BX) products.
// Manufacturing takes 8 business days (Mon-Fri) from the order date, and Canbrax
// delivers on Mondays: the delivery Monday is the first Monday strictly after
// the 8th business day. Example: orders placed Wed 4 Nov to Tue 10 Nov arrive Mon 23 Nov.
// Public holidays are not accounted for.

const CANBRAX_PRODUCT = /\b(secure\s?view|xceed|basix)\b/i;
const MANUFACTURE_BUSINESS_DAYS = 8;

// True if the job has an active, billable SecureView / Xceed / BasiX line.
// Colour-information lines mention these brands too but have zero qty or price.
export function isCanbraxJob(materials) {
  return (materials || []).some(m =>
    m.active !== false &&
    (parseFloat(m.quantity) || 0) > 0 &&
    (m.price === undefined || m.price > 0) &&
    CANBRAX_PRODUCT.test(m.name || '')
  );
}

// orderDateStr: 'YYYY-MM-DD' (or a longer SM8 timestamp). Returns delivery Monday as 'YYYY-MM-DD'.
export function canbraxDeliveryDate(orderDateStr) {
  if (!orderDateStr) return null;
  const [y, mo, d] = orderDateStr.slice(0, 10).split('-').map(Number);
  if (!y || !mo || !d) return null;
  const date = new Date(Date.UTC(y, mo - 1, d));

  // Count forward 8 business days
  let added = 0;
  while (added < MANUFACTURE_BUSINESS_DAYS) {
    date.setUTCDate(date.getUTCDate() + 1);
    const dow = date.getUTCDay();
    if (dow !== 0 && dow !== 6) added++;
  }

  // Then the next Monday strictly after that day
  do {
    date.setUTCDate(date.getUTCDate() + 1);
  } while (date.getUTCDay() !== 1);

  return date.toISOString().slice(0, 10);
}
