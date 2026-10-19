alter table public.product_pricing_history
  add column desired_price_mode boolean not null default false;

create table public.purchase_invoices (
  id uuid primary key default gen_random_uuid(),
  supplier_name text not null check (char_length(trim(supplier_name)) between 1 and 160),
  invoice_number text not null check (char_length(trim(invoice_number)) between 1 and 80),
  issue_date date not null,
  total_cents integer not null check (total_cents > 0),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now()
);

create unique index purchase_invoices_supplier_number_unique
  on public.purchase_invoices (lower(trim(supplier_name)), lower(trim(invoice_number)));
create index purchase_invoices_created_idx on public.purchase_invoices (created_at desc);

create table public.purchase_invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.purchase_invoices (id) on delete restrict,
  product_id uuid not null references public.products (id) on delete restrict,
  product_code text not null,
  product_name text not null,
  quantity numeric(14, 3) not null check (quantity > 0),
  unit_cost_cents integer not null check (unit_cost_cents > 0),
  line_total_cents integer not null check (line_total_cents > 0),
  expiration_date date,
  created_at timestamptz not null default now()
);

create index purchase_invoice_items_invoice_idx
  on public.purchase_invoice_items (invoice_id, created_at);

create table public.product_batches (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete restrict,
  source_invoice_item_id uuid unique references public.purchase_invoice_items (id) on delete restrict,
  expiration_date date,
  received_quantity numeric(14, 3) not null check (received_quantity > 0),
  remaining_quantity numeric(14, 3) not null check (remaining_quantity >= 0),
  created_at timestamptz not null default now(),
  check (remaining_quantity <= received_quantity)
);

create index product_batches_product_expiry_idx
  on public.product_batches (product_id, expiration_date, created_at)
  where remaining_quantity > 0;

insert into public.product_batches (
  product_id, expiration_date, received_quantity, remaining_quantity
)
select id, null, stock_quantity, stock_quantity
from public.products
where stock_quantity > 0;

alter table public.purchase_invoices enable row level security;
alter table public.purchase_invoice_items enable row level security;
alter table public.product_batches enable row level security;
revoke all on public.purchase_invoices, public.purchase_invoice_items,
  public.product_batches from anon, authenticated;

create policy "Managers can read purchase invoices"
  on public.purchase_invoices for select to authenticated
  using (public.has_inventory_write_access());
create policy "Managers can read purchase invoice items"
  on public.purchase_invoice_items for select to authenticated
  using (public.has_inventory_write_access());
create policy "Managers can read product batches"
  on public.product_batches for select to authenticated
  using (public.has_inventory_write_access());

grant select on public.purchase_invoices, public.purchase_invoice_items,
  public.product_batches to authenticated;

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
  v_fixed_rate_bps integer;
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

  select coalesce(sum(monthly_amount_cents), 0),
    coalesce(jsonb_agg(jsonb_build_object('name', name, 'monthly_amount_cents', monthly_amount_cents)
      order by name), '[]'::jsonb)
  into v_fixed_monthly_cents, v_fixed_snapshot
  from public.pricing_fixed_expenses where active;

  select expected_monthly_revenue_cents into v_expected_monthly_cents
  from public.pricing_settings where id = true;

  if v_variable_rate_bps >= 10000 or v_fixed_monthly_cents > 2147483647
    or v_expected_monthly_cents is null then raise exception 'Invalid pricing configuration'; end if;
  if v_fixed_monthly_cents > 0 and v_expected_monthly_cents <= 0 then
    raise exception 'Expected monthly revenue must be configured';
  end if;
  v_fixed_rate_bps := case when v_fixed_monthly_cents = 0 then 0
    else ceil(v_fixed_monthly_cents * 10000::numeric / v_expected_monthly_cents)::integer end;
  v_total_rate_bps := v_variable_rate_bps + v_fixed_rate_bps + p_target_profit_bps;
  if v_total_rate_bps >= 10000 then raise exception 'Combined rates must be below 100 percent'; end if;
  if p_unit_cost_cents::numeric * 10000 / (10000 - v_total_rate_bps) > 2147483647 then
    raise exception 'Calculated price exceeds the supported limit';
  end if;
  v_price_cents := round(p_unit_cost_cents::numeric * 10000 / (10000 - v_total_rate_bps))::integer;

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
    (select auth.uid()), v_variable_rate_bps::integer, v_fixed_rate_bps,
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
  v_fixed_rate_bps integer;
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
  select coalesce(sum(monthly_amount_cents), 0),
    coalesce(jsonb_agg(jsonb_build_object('name', name, 'monthly_amount_cents', monthly_amount_cents)
      order by name), '[]'::jsonb)
  into v_fixed_monthly_cents, v_fixed_snapshot
  from public.pricing_fixed_expenses where active;
  select expected_monthly_revenue_cents into v_expected_monthly_cents
  from public.pricing_settings where id = true;

  if v_variable_rate_bps >= 10000 or v_fixed_monthly_cents > 2147483647
    or v_expected_monthly_cents is null then raise exception 'Invalid pricing configuration'; end if;
  if v_fixed_monthly_cents > 0 and v_expected_monthly_cents <= 0 then
    raise exception 'Expected monthly revenue must be configured';
  end if;
  v_fixed_rate_bps := case when v_fixed_monthly_cents = 0 then 0
    else ceil(v_fixed_monthly_cents * 10000::numeric / v_expected_monthly_cents)::integer end;
  v_expense_rate_bps := v_variable_rate_bps + v_fixed_rate_bps;
  if v_expense_rate_bps >= 10000 then raise exception 'Combined expenses must be below 100 percent'; end if;

  v_minimum_price_cents := ceil(p_unit_cost_cents::numeric * 10000
    / (10000 - v_expense_rate_bps));
  if p_desired_price_cents < v_minimum_price_cents then
    raise exception 'Desired price is below the zero-profit minimum';
  end if;
  v_target_profit_bps := greatest(0, round((
    p_desired_price_cents::numeric * (10000 - v_expense_rate_bps)
    - p_unit_cost_cents::numeric * 10000
  ) / p_desired_price_cents)::integer);

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
    (select auth.uid()), v_variable_rate_bps::integer, v_fixed_rate_bps,
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

create or replace function public.record_stock_movement_with_expiry(
  p_product_id uuid,
  p_quantity numeric,
  p_reason text,
  p_note text default null,
  p_expiration_date date default null,
  p_source_invoice_item_id uuid default null
)
returns public.inventory_movements
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_movement public.inventory_movements;
  v_batch record;
  v_batch_id uuid;
  v_remaining numeric;
  v_allocated numeric;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  if not public.has_inventory_write_access() then raise exception 'Insufficient permissions'; end if;
  if p_product_id is null or p_quantity is null or p_quantity = 0
    or p_quantity <> round(p_quantity, 3) or abs(p_quantity) > 99999999999.999 then
    raise exception 'Invalid stock quantity';
  end if;
  if p_reason is null or p_reason not in ('purchase', 'adjustment', 'return') then
    raise exception 'Invalid stock movement reason';
  end if;
  if p_reason in ('purchase', 'return') and p_quantity < 0 then raise exception 'Invalid stock movement direction'; end if;
  if p_note is not null and char_length(p_note) > 500 then raise exception 'Stock movement note is too long'; end if;
  if p_source_invoice_item_id is not null and not exists (
    select 1 from public.purchase_invoice_items
    where id = p_source_invoice_item_id and product_id = p_product_id
  ) then
    raise exception 'Invoice item does not match the product';
  end if;

  update public.products set stock_quantity = stock_quantity + p_quantity
  where id = p_product_id and active and stock_quantity + p_quantity >= 0;
  if not found then raise exception 'Product not found, inactive, or insufficient stock'; end if;

  if p_quantity > 0 then
    insert into public.product_batches (
      product_id, source_invoice_item_id, expiration_date, received_quantity, remaining_quantity
    ) values (
      p_product_id, p_source_invoice_item_id, p_expiration_date, p_quantity, p_quantity
    ) returning id into v_batch_id;
  else
    v_remaining := abs(p_quantity);
    for v_batch in
      select id, remaining_quantity from public.product_batches
      where product_id = p_product_id and remaining_quantity > 0
      order by expiration_date nulls last, created_at, id for update
    loop
      exit when v_remaining <= 0;
      v_allocated := least(v_batch.remaining_quantity, v_remaining);
      update public.product_batches set remaining_quantity = remaining_quantity - v_allocated
      where id = v_batch.id;
      v_remaining := v_remaining - v_allocated;
    end loop;
  end if;

  insert into public.inventory_movements (product_id, quantity_delta, reason, note, actor_user_id)
  values (p_product_id, p_quantity, p_reason, nullif(trim(p_note), ''), (select auth.uid()))
  returning * into v_movement;
  return v_movement;
end;
$$;

revoke all on function public.record_stock_movement_with_expiry(uuid, numeric, text, text, date, uuid)
  from public, anon;
grant execute on function public.record_stock_movement_with_expiry(uuid, numeric, text, text, date, uuid)
  to authenticated;

create or replace function public.record_stock_movement(
  p_product_id uuid,
  p_quantity numeric,
  p_reason text,
  p_note text default null
)
returns public.inventory_movements
language plpgsql
security definer
set search_path = ''
as $$
begin
  return public.record_stock_movement_with_expiry(
    p_product_id, p_quantity, p_reason, p_note, null, null
  );
end;
$$;

revoke all on function public.record_stock_movement(uuid, numeric, text, text)
  from public, anon;
grant execute on function public.record_stock_movement(uuid, numeric, text, text)
  to authenticated;

create or replace function public.record_purchase_invoice(
  p_supplier_name text,
  p_invoice_number text,
  p_issue_date date,
  p_lines jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice_id uuid;
  v_invoice_total bigint := 0;
  v_line record;
  v_product record;
  v_line_total bigint;
  v_item_id uuid;
  v_count integer := 0;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  if not public.has_inventory_write_access() then raise exception 'Insufficient permissions'; end if;
  if p_supplier_name is null or char_length(trim(p_supplier_name)) not between 1 and 160
    or p_invoice_number is null or char_length(trim(p_invoice_number)) not between 1 and 80
    or p_issue_date is null or p_issue_date > current_date
    or p_lines is null or jsonb_typeof(p_lines) <> 'array'
    or jsonb_array_length(p_lines) not between 1 and 200 then
    raise exception 'Invalid purchase invoice';
  end if;

  for v_line in select * from jsonb_to_recordset(p_lines)
    as lines(product_id uuid, quantity numeric, unit_cost_cents integer, expiration_date date)
  loop
    v_count := v_count + 1;
    if v_line.product_id is null or v_line.quantity is null or v_line.quantity <= 0
      or v_line.quantity <> round(v_line.quantity, 3) or v_line.quantity > 99999999999.999
      or v_line.unit_cost_cents is null or v_line.unit_cost_cents <= 0 then
      raise exception 'Invalid purchase invoice line';
    end if;
    select id, product_code, name, unit into v_product from public.products
    where id = v_line.product_id and active for update;
    if not found then raise exception 'Product not found or inactive'; end if;
    v_line_total := round(v_line.quantity * v_line.unit_cost_cents);
    if v_line_total <= 0 or v_line_total > 2147483647 then raise exception 'Invalid purchase line total'; end if;
    v_invoice_total := v_invoice_total + v_line_total;
    if v_invoice_total > 2147483647 then raise exception 'Invoice total exceeds the supported limit'; end if;
  end loop;

  insert into public.purchase_invoices (
    supplier_name, invoice_number, issue_date, total_cents, created_by
  ) values (
    trim(p_supplier_name), trim(p_invoice_number), p_issue_date,
    v_invoice_total::integer, (select auth.uid())
  ) returning id into v_invoice_id;

  for v_line in select * from jsonb_to_recordset(p_lines)
    as lines(product_id uuid, quantity numeric, unit_cost_cents integer, expiration_date date)
  loop
    select product_code, name, unit into v_product from public.products
    where id = v_line.product_id and active;
    v_line_total := round(v_line.quantity * v_line.unit_cost_cents);
    insert into public.purchase_invoice_items (
      invoice_id, product_id, product_code, product_name, quantity,
      unit_cost_cents, line_total_cents, expiration_date
    ) values (
      v_invoice_id, v_line.product_id, v_product.product_code, v_product.name,
      v_line.quantity, v_line.unit_cost_cents, v_line_total::integer, v_line.expiration_date
    ) returning id into v_item_id;
    perform public.record_stock_movement_with_expiry(
      v_line.product_id, v_line.quantity, 'purchase',
      'Entrada da nota ' || trim(p_invoice_number) || ' · ' || trim(p_supplier_name),
      v_line.expiration_date, v_item_id
    );
  end loop;

  return v_invoice_id;
end;
$$;

revoke all on function public.record_purchase_invoice(text, text, date, jsonb)
  from public, anon;
grant execute on function public.record_purchase_invoice(text, text, date, jsonb)
  to authenticated;

notify pgrst, 'reload schema';
