/**
 * @typedef {object} PricingCalculation
 * @property {number} priceCents
 * @property {number} minimumPriceCents
 * @property {number} variableExpenseCents
 * @property {number} fixedExpenseCents
 * @property {number} targetProfitCents
 * @property {number} targetProfitBps
 * @property {number} totalExpenseRateBps
 * @property {number} markupFactor
 * @property {number} markupOverCostPercent
 */

/**
 * @param {number} unitCostCents
 * @param {number} totalExpenseRateBps
 */
export function calculateMinimumPriceCents(unitCostCents, totalExpenseRateBps) {
  if (
    !Number.isSafeInteger(unitCostCents) || unitCostCents <= 0
    || !Number.isSafeInteger(totalExpenseRateBps)
    || totalExpenseRateBps < 0 || totalExpenseRateBps >= 10000
  ) return null;

  const minimum = Math.ceil(unitCostCents * 10000 / (10000 - totalExpenseRateBps));
  return Number.isSafeInteger(minimum) && minimum <= 2147483647 ? minimum : null;
}

/**
 * @param {number} unitCostCents
 * @param {number} variableExpenseRateBps
 * @param {number} fixedExpenseRateBps
 * @param {number} desiredPriceCents
 */
export function calculateDesiredProfitRateBps(
  unitCostCents,
  variableExpenseRateBps,
  fixedExpenseRateBps,
  desiredPriceCents
) {
  const totalExpenseRateBps = variableExpenseRateBps + fixedExpenseRateBps;
  if (
    !Number.isSafeInteger(unitCostCents) || unitCostCents <= 0
    || !Number.isSafeInteger(variableExpenseRateBps) || variableExpenseRateBps < 0
    || !Number.isSafeInteger(fixedExpenseRateBps) || fixedExpenseRateBps < 0
    || totalExpenseRateBps >= 10000
    || !Number.isSafeInteger(desiredPriceCents) || desiredPriceCents <= 0
  ) return null;

  return Math.round(
    10000 - totalExpenseRateBps - unitCostCents * 10000 / desiredPriceCents
  );
}

/**
 * @param {number} unitCostCents
 * @param {number} variableExpenseRateBps
 * @param {number} fixedExpenseRateBps
 * @param {number} targetProfitBps
 * @returns {PricingCalculation | null}
 */
export function calculateMarkupPrice(
  unitCostCents,
  variableExpenseRateBps,
  fixedExpenseRateBps,
  targetProfitBps
) {
  const totalExpenseRateBps = variableExpenseRateBps + fixedExpenseRateBps;
  const minimumPriceCents = calculateMinimumPriceCents(unitCostCents, totalExpenseRateBps);
  if (
    minimumPriceCents === null
    || !Number.isSafeInteger(targetProfitBps) || targetProfitBps < 0
    || totalExpenseRateBps + targetProfitBps >= 10000
  ) return null;

  const totalRateBps = totalExpenseRateBps + targetProfitBps;
  const calculatedPriceCents = unitCostCents * 10000 / (10000 - totalRateBps);
  const priceCents = targetProfitBps === 0
    ? Math.max(minimumPriceCents, Math.ceil(calculatedPriceCents))
    : Math.round(calculatedPriceCents);
  if (!Number.isSafeInteger(priceCents) || priceCents < minimumPriceCents || priceCents > 2147483647) return null;

  return {
    priceCents,
    minimumPriceCents,
    variableExpenseCents: Math.round(priceCents * variableExpenseRateBps / 10000),
    fixedExpenseCents: Math.round(priceCents * fixedExpenseRateBps / 10000),
    targetProfitCents: Math.round(priceCents * targetProfitBps / 10000),
    targetProfitBps,
    totalExpenseRateBps,
    markupFactor: 10000 / (10000 - totalRateBps),
    markupOverCostPercent: (priceCents / unitCostCents - 1) * 100
  };
}

/**
 * @param {number} unitCostCents
 * @param {number} variableExpenseRateBps
 * @param {number} fixedExpenseRateBps
 * @param {number} desiredPriceCents
 * @returns {PricingCalculation | null}
 */
export function calculateDesiredPrice(
  unitCostCents,
  variableExpenseRateBps,
  fixedExpenseRateBps,
  desiredPriceCents
) {
  const totalExpenseRateBps = variableExpenseRateBps + fixedExpenseRateBps;
  const minimumPriceCents = calculateMinimumPriceCents(unitCostCents, totalExpenseRateBps);
  if (
    minimumPriceCents === null
    || !Number.isSafeInteger(desiredPriceCents)
    || desiredPriceCents < minimumPriceCents
    || desiredPriceCents > 2147483647
  ) return null;

  const targetProfitBps = Math.max(0, calculateDesiredProfitRateBps(
    unitCostCents,
    variableExpenseRateBps,
    fixedExpenseRateBps,
    desiredPriceCents
  ) ?? 0);

  return {
    priceCents: desiredPriceCents,
    minimumPriceCents,
    variableExpenseCents: Math.round(desiredPriceCents * variableExpenseRateBps / 10000),
    fixedExpenseCents: Math.round(desiredPriceCents * fixedExpenseRateBps / 10000),
    targetProfitCents: Math.max(0, desiredPriceCents
      - Math.round(desiredPriceCents * totalExpenseRateBps / 10000)
      - unitCostCents),
    targetProfitBps,
    totalExpenseRateBps,
    markupFactor: desiredPriceCents / unitCostCents,
    markupOverCostPercent: (desiredPriceCents / unitCostCents - 1) * 100
  };
}
