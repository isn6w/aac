export type PayableStatus = 'paid' | 'overdue' | 'due-soon' | 'upcoming' | 'invalid';

export function getDaysUntilDue(dueDate: string, today?: Date): number | null;
export function getPayableStatus(
  payable: { is_paid: boolean; due_date: string },
  today?: Date
): PayableStatus;