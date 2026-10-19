import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateDesiredPrice,
  calculateDesiredProfitRateBps,
  calculateMarkupPrice,
  calculateMinimumPriceCents
} from '../lib/pricing-calculation.mjs';

test('calculates markup price using configured variable and fixed percentages', () => {
  const result = calculateMarkupPrice(60000, 1500, 100, 2000);
  assert.ok(result);
  assert.equal(result.minimumPriceCents, 71429);
  assert.equal(result.priceCents, 93750);
  assert.equal(result.variableExpenseCents, 14063);
  assert.equal(result.fixedExpenseCents, 938);
  assert.equal(result.targetProfitCents, 18750);
  assert.equal(result.totalExpenseRateBps, 1600);
  assert.equal((1 / result.markupFactor).toFixed(5), '0.64000');
});

test('suggests and permits saving the minimum price when desired profit is zero', () => {
  const result = calculateMarkupPrice(60000, 1500, 100, 0);
  assert.ok(result);
  assert.equal(result.minimumPriceCents, 71429);
  assert.equal(result.priceCents, result.minimumPriceCents);
  assert.equal(result.targetProfitBps, 0);
  assert.equal(result.targetProfitCents, 0);
});

test('computes profit when an operator chooses a valid final price', () => {
  const result = calculateDesiredPrice(60000, 1500, 100, 90000);
  assert.ok(result);
  assert.equal(result.minimumPriceCents, 71429);
  assert.equal(result.priceCents, 90000);
  assert.equal(result.targetProfitBps, 1733);
  assert.equal(result.targetProfitCents, 15600);
});

test('derives the desired profit percentage with the markup divisor equation', () => {
  const costCents = 5000;
  const variableRateBps = 1000;
  const fixedRateBps = 2500;
  const desiredPriceCents = 10000;
  const result = calculateDesiredPrice(
    costCents,
    variableRateBps,
    fixedRateBps,
    desiredPriceCents
  );

  assert.ok(result);
  assert.equal(result.targetProfitBps, 1500);
  assert.equal(result.priceCents, Math.round(
    costCents * 10000 / (10000 - variableRateBps - fixedRateBps - result.targetProfitBps)
  ));
  assert.equal(calculateDesiredProfitRateBps(
    costCents,
    variableRateBps,
    fixedRateBps,
    desiredPriceCents
  ), 1500);
  assert.ok(calculateDesiredProfitRateBps(60000, 1500, 100, 70000) < 0);
});

test('blocks a desired price below the zero-profit minimum', () => {
  const minimum = calculateMinimumPriceCents(60000, 1600);
  assert.equal(minimum, 71429);
  assert.equal(calculateDesiredPrice(60000, 1500, 100, minimum - 1), null);
  assert.ok(calculateDesiredPrice(60000, 1500, 100, minimum));
});

test('requires expense rates below 100 percent and valid monetary values', () => {
  assert.equal(calculateMarkupPrice(10000, 9500, 500, 0), null);
  assert.equal(calculateDesiredPrice(10000, 10000, 0, 20000), null);
  assert.equal(calculateMinimumPriceCents(0, 0), null);
});
