/**
 * @param {{ quantityMilli: number, unitPriceCents: number, discountBps: number }} line
 */
export function calculateSaleLine(line) {
  const { quantityMilli, unitPriceCents, discountBps } = line;
  if (
    !Number.isSafeInteger(quantityMilli) || quantityMilli <= 0
    || !Number.isSafeInteger(unitPriceCents) || unitPriceCents <= 0
    || !Number.isSafeInteger(discountBps) || discountBps < 0 || discountBps > 10000
  ) return null;
  const subtotalCents = Math.round(quantityMilli * unitPriceCents / 1000);
  const discountCents = Math.round(subtotalCents * discountBps / 10000);
  return { subtotalCents, discountCents, totalCents: subtotalCents - discountCents };
}

/**
 * @param {{ totalCents: number, receivedCents: number, paymentMethod: string }} payment
 */
export function calculateChange(payment) {
  const { totalCents, receivedCents, paymentMethod } = payment;
  if (
    !Number.isSafeInteger(totalCents) || totalCents <= 0
    || !Number.isSafeInteger(receivedCents) || receivedCents < 0
  ) return null;
  if (paymentMethod !== 'cash') {
    return receivedCents === totalCents ? 0 : null;
  }
  return receivedCents >= totalCents ? receivedCents - totalCents : null;
}
