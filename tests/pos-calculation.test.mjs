import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateChange, calculateSaleLine } from '../lib/pos-calculation.mjs';

test('calculates line totals with quantity and percentage discount in cents', () => {
  assert.deepEqual(calculateSaleLine({
    quantityMilli: 1500,
    unitPriceCents: 1299,
    discountBps: 500
  }), { subtotalCents: 1949, discountCents: 97, totalCents: 1852 });
});

test('rejects invalid prices, quantities, and discounts', () => {
  assert.equal(calculateSaleLine({ quantityMilli: 0, unitPriceCents: 100, discountBps: 0 }), null);
  assert.equal(calculateSaleLine({ quantityMilli: 1000, unitPriceCents: 0, discountBps: 0 }), null);
  assert.equal(calculateSaleLine({ quantityMilli: 1000, unitPriceCents: 100, discountBps: 10001 }), null);
});

test('calculates cash change and rejects underpayment', () => {
  assert.equal(calculateChange({ totalCents: 850, receivedCents: 1000, paymentMethod: 'cash' }), 150);
  assert.equal(calculateChange({ totalCents: 850, receivedCents: 849, paymentMethod: 'cash' }), null);
});

test('non-cash payments must match the sale total', () => {
  assert.equal(calculateChange({ totalCents: 850, receivedCents: 850, paymentMethod: 'pix' }), 0);
  assert.equal(calculateChange({ totalCents: 850, receivedCents: 900, paymentMethod: 'credit' }), null);
});
