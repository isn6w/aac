export type PricingCalculation = {
  priceCents: number;
  minimumPriceCents: number;
  variableExpenseCents: number;
  fixedExpenseCents: number;
  targetProfitCents: number;
  targetProfitBps: number;
  totalExpenseRateBps: number;
  markupFactor: number;
  markupOverCostPercent: number;
};

export function calculateDesiredProfitRateBps(
  unitCostCents: number,
  variableExpenseRateBps: number,
  fixedExpenseRateBps: number,
  desiredPriceCents: number
): number | null;
export function calculateMinimumPriceCents(unitCostCents: number, totalExpenseRateBps: number): number | null;
export function calculateMarkupPrice(
  unitCostCents: number,
  variableExpenseRateBps: number,
  fixedExpenseRateBps: number,
  targetProfitBps: number
): PricingCalculation | null;
export function calculateDesiredPrice(
  unitCostCents: number,
  variableExpenseRateBps: number,
  fixedExpenseRateBps: number,
  desiredPriceCents: number
): PricingCalculation | null;
