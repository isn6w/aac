do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'pricing_fixed_expenses'
      and column_name = 'rate_bps'
  ) then
    alter table public.pricing_fixed_expenses
      add column rate_bps integer not null default 0;

    update public.pricing_fixed_expenses expense
    set rate_bps = case
      when expense.monthly_amount_cents = 0 then 0
      when settings.expected_monthly_revenue_cents > 0 then least(
        10000::numeric,
        ceil(expense.monthly_amount_cents * 10000::numeric
          / settings.expected_monthly_revenue_cents)
      )::integer
      else 10000
    end
    from public.pricing_settings settings
    where settings.id = true;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'pricing_fixed_expenses_rate_bps_check'
      and conrelid = 'public.pricing_fixed_expenses'::regclass
  ) then
    alter table public.pricing_fixed_expenses
      add constraint pricing_fixed_expenses_rate_bps_check
      check (rate_bps between 0 and 10000);
  end if;
end;
$$;

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
  v_variable_rate_bps bigint;
  v_fixed_rate_bps bigint;
  v_fixed_monthly_cents bigint;
  v_expected_monthly_cents integer;
  v_total_rate_bps bigint;
  v_price_cents integer;
  v_custom_snapshot jsonb;
  v_fixed_snapshot jsonb;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  if not public.has_inventory_write_access() then raise exception 'Insufficient permissions'; end if;
  if p_product_id is null or p_unit_cost_cents is null or p_unit_cost_cents <= 0
    or p_variable_expense_bps is distinct from 0
    or p_tax_bps is distinct from 0
    or p_target_profit_bps is null or p_target_profit_bps not between 0 and 10000 then
    raise exception 'Invalid pricing input';
  end if;

  select coalesce(sum(rate_bps), 0),
    coalesce(jsonb_agg(jsonb_build_object('name', name, 'rate_bps', rate_bps)
      order by name), '[]'::jsonb)
  into v_variable_rate_bps, v_custom_snapshot
  from public.pricing_variable_fees where active;

  select coalesce(sum(rate_bps), 0),
    coalesce(jsonb_agg(jsonb_build_object('name', name, 'rate_bps', rate_bps)
      order by name), '[]'::jsonb)
  into v_fixed_rate_bps, v_fixed_snapshot
  from public.pricing_fixed_expenses where active;

  select coalesce(sum(monthly_amount_cents), 0)
  into v_fixed_monthly_cents
  from public.pricing_fixed_expenses where active;
  select expected_monthly_revenue_cents into v_expected_monthly_cents
  from public.pricing_settings where id = true;

  if v_variable_rate_bps + v_fixed_rate_bps >= 10000
    or v_fixed_monthly_cents > 2147483647
    or v_expected_monthly_cents is null then
    raise exception 'Invalid pricing configuration';
  end if;
  v_total_rate_bps := v_variable_rate_bps + v_fixed_rate_bps + p_target_profit_bps;
  if v_total_rate_bps >= 10000 then raise exception 'Combined rates must be below 100 percent'; end if;
  if p_unit_cost_cents::numeric * 10000 / (10000 - v_total_rate_bps) > 2147483647 then
    raise exception 'Calculated price exceeds the supported limit';
  end if;
  v_price_cents := case
    when p_target_profit_bps = 0 then greatest(
      ceil(p_unit_cost_cents::numeric * 10000 / (10000 - v_variable_rate_bps - v_fixed_rate_bps)),
      ceil(p_unit_cost_cents::numeric * 10000 / (10000 - v_total_rate_bps))
    )::integer
    else round(p_unit_cost_cents::numeric * 10000 / (10000 - v_total_rate_bps))::integer
  end;

  perform 1 from public.products where id = p_product_id and active for update;
  if not found then raise exception 'Product not found or inactive'; end if;
  update public.products set unit_price_cents = v_price_cents where id = p_product_id;
  insert into public.product_costs (product_id, unit_cost_cents, updated_by)
  values (p_product_id, p_unit_cost_cents, (select auth.uid()))
  on conflict (product_id) do update set unit_cost_cents = excluded.unit_cost_cents,
    updated_by = excluded.updated_by, updated_at = now();

  insert into public.product_pricing_history (
    product_id, unit_cost_cents, variable_expense_bps, tax_bps, target_profit_bps,
    unit_price_cents, created_by, custom_variable_rate_bps, fixed_cost_rate_bps,
    fixed_monthly_cost_cents, expected_monthly_revenue_cents, custom_fees_snapshot,
    fixed_expenses_snapshot, desired_price_mode
  ) values (
    p_product_id, p_unit_cost_cents, 0, 0, p_target_profit_bps, v_price_cents,
    (select auth.uid()), v_variable_rate_bps::integer, v_fixed_rate_bps::integer,
    v_fixed_monthly_cents::integer, v_expected_monthly_cents, v_custom_snapshot,
    v_fixed_snapshot, false
  );
  return v_price_cents;
end;
$$;

create or replace function public.save_product_pricing_at_desired_price(
  p_product_id uuid,
  p_unit_cost_cents integer,
  p_desired_price_cents integer
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_variable_rate_bps bigint;
  v_fixed_rate_bps bigint;
  v_fixed_monthly_cents bigint;
  v_expected_monthly_cents integer;
  v_expense_rate_bps bigint;
  v_minimum_price_cents bigint;
  v_target_profit_bps integer;
  v_custom_snapshot jsonb;
  v_fixed_snapshot jsonb;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  if not public.has_inventory_write_access() then raise exception 'Insufficient permissions'; end if;
  if p_product_id is null or p_unit_cost_cents is null or p_unit_cost_cents <= 0
    or p_desired_price_cents is null or p_desired_price_cents <= 0 then
    raise exception 'Invalid pricing input';
  end if;

  select coalesce(sum(rate_bps), 0),
    coalesce(jsonb_agg(jsonb_build_object('name', name, 'rate_bps', rate_bps)
      order by name), '[]'::jsonb)
  into v_variable_rate_bps, v_custom_snapshot
  from public.pricing_variable_fees where active;
  select coalesce(sum(rate_bps), 0),
    coalesce(jsonb_agg(jsonb_build_object('name', name, 'rate_bps', rate_bps)
      order by name), '[]'::jsonb)
  into v_fixed_rate_bps, v_fixed_snapshot
  from public.pricing_fixed_expenses where active;
  select coalesce(sum(monthly_amount_cents), 0)
  into v_fixed_monthly_cents
  from public.pricing_fixed_expenses where active;
  select expected_monthly_revenue_cents into v_expected_monthly_cents
  from public.pricing_settings where id = true;

  if v_variable_rate_bps + v_fixed_rate_bps >= 10000
    or v_fixed_monthly_cents > 2147483647
    or v_expected_monthly_cents is null then
    raise exception 'Invalid pricing configuration';
  end if;
  v_expense_rate_bps := v_variable_rate_bps + v_fixed_rate_bps;

  v_minimum_price_cents := ceil(p_unit_cost_cents::numeric * 10000
    / (10000 - v_expense_rate_bps));
  if p_desired_price_cents < v_minimum_price_cents then
    raise exception 'Desired price is below the zero-profit minimum';
  end if;
  v_target_profit_bps := greatest(0, round(
    10000 - v_expense_rate_bps
      - p_unit_cost_cents::numeric * 10000 / p_desired_price_cents
  )::integer);

  perform 1 from public.products where id = p_product_id and active for update;
  if not found then raise exception 'Product not found or inactive'; end if;
  update public.products set unit_price_cents = p_desired_price_cents where id = p_product_id;
  insert into public.product_costs (product_id, unit_cost_cents, updated_by)
  values (p_product_id, p_unit_cost_cents, (select auth.uid()))
  on conflict (product_id) do update set unit_cost_cents = excluded.unit_cost_cents,
    updated_by = excluded.updated_by, updated_at = now();
  insert into public.product_pricing_history (
    product_id, unit_cost_cents, variable_expense_bps, tax_bps, target_profit_bps,
    unit_price_cents, created_by, custom_variable_rate_bps, fixed_cost_rate_bps,
    fixed_monthly_cost_cents, expected_monthly_revenue_cents, custom_fees_snapshot,
    fixed_expenses_snapshot, desired_price_mode
  ) values (
    p_product_id, p_unit_cost_cents, 0, 0, v_target_profit_bps, p_desired_price_cents,
    (select auth.uid()), v_variable_rate_bps::integer, v_fixed_rate_bps::integer,
    v_fixed_monthly_cents::integer, v_expected_monthly_cents, v_custom_snapshot,
    v_fixed_snapshot, true
  );
  return p_desired_price_cents;
end;
$$;

revoke all on function public.save_product_pricing(uuid, integer, integer, integer, integer)
  from public, anon;
grant execute on function public.save_product_pricing(uuid, integer, integer, integer, integer)
  to authenticated;
revoke all on function public.save_product_pricing_at_desired_price(uuid, integer, integer)
  from public, anon;
grant execute on function public.save_product_pricing_at_desired_price(uuid, integer, integer)
  to authenticated;

notify pgrst, 'reload schema';
