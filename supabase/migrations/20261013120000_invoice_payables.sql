create table public.invoice_payables (
  invoice_id uuid primary key references public.purchase_invoices (id) on delete restrict,
  due_date date not null,
  tax_total_cents integer check (tax_total_cents is null or tax_total_cents between 0 and 2147483647),
  boleto_reference text check (boleto_reference is null or char_length(boleto_reference) <= 200),
  is_paid boolean not null default false,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((is_paid and paid_at is not null) or (not is_paid and paid_at is null))
);

create index invoice_payables_due_idx
  on public.invoice_payables (due_date asc, invoice_id)
  where not is_paid;

insert into public.invoice_payables (invoice_id, due_date)
select id, issue_date + 30
from public.purchase_invoices
on conflict (invoice_id) do nothing;

alter table public.invoice_payables enable row level security;
revoke all on public.invoice_payables from anon, authenticated;

create policy "Managers can read invoice payables"
  on public.invoice_payables for select to authenticated
  using (public.has_inventory_write_access());

grant select on public.invoice_payables to authenticated;

create or replace function public.create_invoice_payable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.invoice_payables (invoice_id, due_date)
  values (new.id, new.issue_date + 30);
  return new;
end;
$$;

revoke all on function public.create_invoice_payable() from public, anon, authenticated;

create trigger purchase_invoice_create_payable
  after insert on public.purchase_invoices
  for each row execute function public.create_invoice_payable();

create or replace function public.update_invoice_payable(
  p_invoice_id uuid,
  p_due_date date,
  p_tax_total_cents integer,
  p_boleto_reference text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  if not public.has_inventory_write_access() then raise exception 'Insufficient permissions'; end if;
  if p_invoice_id is null or p_due_date is null
    or (p_tax_total_cents is not null and p_tax_total_cents not between 0 and 2147483647)
    or (p_boleto_reference is not null and char_length(trim(p_boleto_reference)) > 200) then
    raise exception 'Invalid payable details';
  end if;

  update public.invoice_payables
  set due_date = p_due_date,
      tax_total_cents = p_tax_total_cents,
      boleto_reference = nullif(trim(p_boleto_reference), ''),
      updated_at = now()
  where invoice_id = p_invoice_id;
  if not found then raise exception 'Invoice payable not found'; end if;
end;
$$;

revoke all on function public.update_invoice_payable(uuid, date, integer, text) from public, anon;
grant execute on function public.update_invoice_payable(uuid, date, integer, text) to authenticated;

create or replace function public.set_invoice_payable_paid(
  p_invoice_id uuid,
  p_is_paid boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  if not public.has_inventory_write_access() then raise exception 'Insufficient permissions'; end if;
  if p_invoice_id is null or p_is_paid is null then raise exception 'Invalid payment status'; end if;

  update public.invoice_payables
  set is_paid = p_is_paid,
      paid_at = case when p_is_paid then now() else null end,
      updated_at = now()
  where invoice_id = p_invoice_id;
  if not found then raise exception 'Invoice payable not found'; end if;
end;
$$;

revoke all on function public.set_invoice_payable_paid(uuid, boolean) from public, anon;
grant execute on function public.set_invoice_payable_paid(uuid, boolean) to authenticated;

notify pgrst, 'reload schema';