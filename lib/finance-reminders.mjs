const DAY_MS = 24 * 60 * 60 * 1000;

export function getDaysUntilDue(dueDate, today = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return null;
  const due = new Date(`${dueDate}T00:00:00.000Z`);
  if (!Number.isFinite(due.getTime()) || due.toISOString().slice(0, 10) !== dueDate) return null;
  const current = new Date(`${today.toISOString().slice(0, 10)}T00:00:00.000Z`);
  return Math.round((due.getTime() - current.getTime()) / DAY_MS);
}

export function getPayableStatus(payable, today = new Date()) {
  if (payable.is_paid) return 'paid';
  const daysUntilDue = getDaysUntilDue(payable.due_date, today);
  if (daysUntilDue === null) return 'invalid';
  if (daysUntilDue < 0) return 'overdue';
  if (daysUntilDue <= 7) return 'due-soon';
  return 'upcoming';
}