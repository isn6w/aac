do $$
begin
  if to_regclass('public.sales') is null
    or to_regclass('public.sale_items') is null
    or to_regprocedure('public.record_sale(jsonb,text,integer)') is null then
    raise exception using
      message = 'Prerequisite missing: run 20261010190000_sales_and_markup_invoice_import.sql successfully before this migration.';
  end if;
end;
$$;

alter table public.sales
  add column if not exists installments smallint not null default 1
  check (installments between 1 and 12);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'sales_installments_payment_method_check'
      and conrelid = 'public.sales'::regclass
  ) then
    alter table public.sales
      add constraint sales_installments_payment_method_check
      check (payment_method = 'credit' or installments = 1);
  end if;
end;
$$;

create or replace function public.record_sale(
  p_lines jsonb,
  p_payment_method text,
  p_amount_received_cents integer,
  p_installments integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_sale_id uuid;
begin
  if p_installments is null or p_installments not between 1 and 12
    or (p_payment_method is distinct from 'credit' and p_installments <> 1) then
    raise exception 'Invalid payment installments';
  end if;

  v_result := public.record_sale(p_lines, p_payment_method, p_amount_received_cents);
  v_sale_id := (v_result ->> 'sale_id')::uuid;
  update public.sales set installments = p_installments where id = v_sale_id;
  return v_result;
end;
$$;

revoke all on function public.record_sale(jsonb, text, integer, integer) from public, anon;
grant execute on function public.record_sale(jsonb, text, integer, integer) to authenticated;

notify pgrst, 'reload schema';
