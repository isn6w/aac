create table public.pricing_settings (
  id boolean primary key default true check (id),
  expected_monthly_revenue_cents integer not null default 0
    check (expected_monthly_revenue_cents between 0 and 2147483647),
  updated_at timestamptz not null default now()
);

insert into public.pricing_settings (id) values (true);

alter table public.pricing_settings enable row level security;
revoke all on public.pricing_settings from anon, authenticated;

create policy "Managers can read pricing settings"
  on public.pricing_settings for select to authenticated
  using (public.has_inventory_write_access());

create policy "Managers can update pricing settings"
  on public.pricing_settings for update to authenticated
  using (public.has_inventory_write_access())
  with check (public.has_inventory_write_access());

grant select, update on public.pricing_settings to authenticated;

create table public.pricing_variable_fees (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 80),
  rate_bps integer not null check (rate_bps between 0 and 10000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.pricing_fixed_expenses (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 80),
  monthly_amount_cents integer not null check (monthly_amount_cents between 0 and 2147483647),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index pricing_variable_fees_name_ci_unique
  on public.pricing_variable_fees (lower(trim(name)));
create unique index pricing_fixed_expenses_name_ci_unique
  on public.pricing_fixed_expenses (lower(trim(name)));

alter table public.pricing_variable_fees enable row level security;
alter table public.pricing_fixed_expenses enable row level security;
revoke all on public.pricing_variable_fees, public.pricing_fixed_expenses from anon, authenticated;

create policy "Managers can manage pricing variable fees"
  on public.pricing_variable_fees for all to authenticated
  using (public.has_inventory_write_access())
  with check (public.has_inventory_write_access());

create policy "Managers can manage pricing fixed expenses"
  on public.pricing_fixed_expenses for all to authenticated
  using (public.has_inventory_write_access())
  with check (public.has_inventory_write_access());

grant select, insert, update, delete on public.pricing_variable_fees,
  public.pricing_fixed_expenses to authenticated;

create trigger pricing_variable_fees_set_updated_at
  before update on public.pricing_variable_fees
  for each row execute function public.set_updated_at();
create trigger pricing_fixed_expenses_set_updated_at
  before update on public.pricing_fixed_expenses
  for each row execute function public.set_updated_at();
create trigger pricing_settings_set_updated_at
  before update on public.pricing_settings
  for each row execute function public.set_updated_at();

alter table public.product_pricing_history
  add column custom_variable_rate_bps integer not null default 0
    check (custom_variable_rate_bps between 0 and 10000),
  add column fixed_cost_rate_bps integer not null default 0
    check (fixed_cost_rate_bps between 0 and 10000),
  add column fixed_monthly_cost_cents integer not null default 0
    check (fixed_monthly_cost_cents between 0 and 2147483647),
  add column expected_monthly_revenue_cents integer not null default 0
    check (expected_monthly_revenue_cents between 0 and 2147483647),
  add column custom_fees_snapshot jsonb not null default '[]'::jsonb,
  add column fixed_expenses_snapshot jsonb not null default '[]'::jsonb;

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
  v_total_rate_bps bigint;
  v_custom_rate_bps bigint;
  v_fixed_cost_rate_bps integer;
  v_fixed_monthly_cost_cents bigint;
  v_expected_monthly_revenue_cents integer;
  v_unit_price_cents integer;
  v_locked_product_id uuid;
  v_custom_fees_snapshot jsonb;
  v_fixed_expenses_snapshot jsonb;
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

  select coalesce(sum(rate_bps), 0),
    coalesce(jsonb_agg(jsonb_build_object('name', name, 'rate_bps', rate_bps)
      order by name), '[]'::jsonb)
  into v_custom_rate_bps, v_custom_fees_snapshot
  from public.pricing_variable_fees
  where active;
  if v_custom_rate_bps >= 10000 then
    raise exception 'Combined pricing rates must be below 100 percent';
  end if;

  select coalesce(sum(monthly_amount_cents), 0),
    coalesce(jsonb_agg(jsonb_build_object('name', name, 'monthly_amount_cents', monthly_amount_cents)
      order by name), '[]'::jsonb)
  into v_fixed_monthly_cost_cents, v_fixed_expenses_snapshot
  from public.pricing_fixed_expenses
  where active;
  if v_fixed_monthly_cost_cents > 2147483647 then
    raise exception 'Combined fixed expenses exceed the supported limit';
  end if;

  select expected_monthly_revenue_cents
  into v_expected_monthly_revenue_cents
  from public.pricing_settings
  where id = true;

  if v_expected_monthly_revenue_cents is null then
    raise exception 'Pricing settings are not configured';
  end if;

  if v_fixed_monthly_cost_cents > 0 and v_expected_monthly_revenue_cents <= 0 then
    raise exception 'Expected monthly revenue must be configured';
  end if;

  v_fixed_cost_rate_bps := case
    when v_fixed_monthly_cost_cents = 0 then 0
    else ceil(v_fixed_monthly_cost_cents * 10000::numeric
      / v_expected_monthly_revenue_cents)::integer
  end;

  v_total_rate_bps := p_variable_expense_bps + p_tax_bps + p_target_profit_bps
    + v_custom_rate_bps + v_fixed_cost_rate_bps;

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
    product_id, unit_cost_cents, variable_expense_bps, tax_bps, target_profit_bps,
    unit_price_cents, created_by, custom_variable_rate_bps, fixed_cost_rate_bps,
    fixed_monthly_cost_cents, expected_monthly_revenue_cents, custom_fees_snapshot,
    fixed_expenses_snapshot
  )
  values (
    p_product_id, p_unit_cost_cents, p_variable_expense_bps, p_tax_bps,
    p_target_profit_bps, v_unit_price_cents, (select auth.uid()), v_custom_rate_bps::integer,
    v_fixed_cost_rate_bps, v_fixed_monthly_cost_cents::integer,
    v_expected_monthly_revenue_cents, v_custom_fees_snapshot, v_fixed_expenses_snapshot
  );

  return v_unit_price_cents;
end;
$$;

revoke all on function public.save_product_pricing(uuid, integer, integer, integer, integer)
  from public, anon;
grant execute on function public.save_product_pricing(uuid, integer, integer, integer, integer)
  to authenticated;

notify pgrst, 'reload schema';
