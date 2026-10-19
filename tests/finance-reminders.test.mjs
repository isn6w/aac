import test from 'node:test';
import assert from 'node:assert/strict';
import { getDaysUntilDue, getPayableStatus } from '../lib/finance-reminders.mjs';

const today = new Date('2026-10-13T15:00:00.000Z');

test('classifies overdue, due soon, upcoming, and paid payables', () => {
  assert.equal(getPayableStatus({ is_paid: false, due_date: '2026-10-12' }, today), 'overdue');
  assert.equal(getPayableStatus({ is_paid: false, due_date: '2026-10-20' }, today), 'due-soon');
  assert.equal(getPayableStatus({ is_paid: false, due_date: '2026-10-21' }, today), 'upcoming');
  assert.equal(getPayableStatus({ is_paid: true, due_date: '2026-10-12' }, today), 'paid');
});

test('calculates day differences from calendar dates and rejects invalid dates', () => {
  assert.equal(getDaysUntilDue('2026-10-13', today), 0);
  assert.equal(getDaysUntilDue('2026-10-20', today), 7);
  assert.equal(getDaysUntilDue('2026-02-30', today), null);
});