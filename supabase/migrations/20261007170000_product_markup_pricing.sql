create table public.product_costs (
  product_id uuid primary key references public.products (id) on delete restrict,
  unit_cost_cents integer not null check (unit_cost_cents > 0),
  updated_by uuid not null references auth.users (id),
  updated_at timestamptz not null default now()
);

alter table public.product_costs enable row level security;

revoke all on public.product_costs from anon, authenticated;

create policy "Managers can read product costs"
  on public.product_costs for select to authenticated
  using (public.has_inventory_write_access());

grant select on public.product_costs to authenticated;

create table public.product_pricing_history (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete restrict,
  unit_cost_cents integer not null check (unit_cost_cents > 0),
  variable_expense_bps integer not null check (variable_expense_bps between 0 and 10000),
  tax_bps integer not null check (tax_bps between 0 and 10000),
  target_profit_bps integer not null check (target_profit_bps between 0 and 10000),
  unit_price_cents integer not null check (unit_price_cents > 0),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  check (variable_expense_bps + tax_bps + target_profit_bps < 10000)
);

create index product_pricing_history_product_created_idx
  on public.product_pricing_history (product_id, created_at desc);

alter table public.product_pricing_history enable row level security;

revoke all on public.product_pricing_history from anon, authenticated;

create policy "Managers can read product pricing history"
  on public.product_pricing_history for select to authenticated
  using (public.has_inventory_write_access());

grant select on public.product_pricing_history to authenticated;

create or replace function public.save_product_pricing(
  p_product_id uuid,
  p_unit_cost_cents integer,
  p_variable_expense_bps integer,
  p_tax_bps integer,
  p_target_profit_bps integer
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total_rate_bps integer;
  v_unit_price_cents integer;
  v_locked_product_id uuid;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required';
  end if;

  if not public.has_inventory_write_access() then
    raise exception 'Insufficient permissions';
  end if;

  if p_product_id is null
    or p_unit_cost_cents is null
    or p_unit_cost_cents <= 0
    or p_variable_expense_bps is null
    or p_variable_expense_bps not between 0 and 10000
    or p_tax_bps is null
    or p_tax_bps not between 0 and 10000
    or p_target_profit_bps is null
    or p_target_profit_bps not between 0 and 10000 then
    raise exception 'Invalid pricing input';
  end if;

  v_total_rate_bps :=
    p_variable_expense_bps + p_tax_bps + p_target_profit_bps;

  if v_total_rate_bps >= 10000 then
    raise exception 'Combined pricing rates must be below 100 percent';
  end if;

  select id
  into v_locked_product_id
  from public.products
  where id = p_product_id and active
  for update;

  if not found then
    raise exception 'Product not found or inactive';
  end if;

  if p_unit_cost_cents::numeric * 10000 / (10000 - v_total_rate_bps) > 2147483647 then
    raise exception 'Calculated price exceeds the supported limit';
  end if;

  v_unit_price_cents := round(
    p_unit_cost_cents::numeric * 10000 / (10000 - v_total_rate_bps)
  )::integer;

  update public.products
  set unit_price_cents = v_unit_price_cents
  where id = p_product_id;

  insert into public.product_costs (product_id, unit_cost_cents, updated_by)
  values (p_product_id, p_unit_cost_cents, (select auth.uid()))
  on conflict (product_id) do update
  set unit_cost_cents = excluded.unit_cost_cents,
      updated_by = excluded.updated_by,
      updated_at = now();

  insert into public.product_pricing_history (
    product_id,
    unit_cost_cents,
    variable_expense_bps,
    tax_bps,
    target_profit_bps,
    unit_price_cents,
    created_by
  )
  values (
    p_product_id,
    p_unit_cost_cents,
    p_variable_expense_bps,
    p_tax_bps,
    p_target_profit_bps,
    v_unit_price_cents,
    (select auth.uid())
  );

  return v_unit_price_cents;
end;
$$;

revoke all on function public.save_product_pricing(uuid, integer, integer, integer, integer)
  from public, anon;
grant execute on function public.save_product_pricing(uuid, integer, integer, integer, integer)
  to authenticated;
