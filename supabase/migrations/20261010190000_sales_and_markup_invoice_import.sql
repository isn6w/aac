alter table public.inventory_movements
  drop constraint if exists inventory_movements_reason_check;
alter table public.inventory_movements
  add constraint inventory_movements_reason_check
  check (reason in ('purchase', 'adjustment', 'return', 'sale'));

create table public.sales (
  id uuid primary key default gen_random_uuid(),
  total_cents integer not null check (total_cents > 0),
  payment_method text not null check (payment_method in ('cash', 'pix', 'credit', 'debit')),
  amount_received_cents integer not null check (amount_received_cents >= total_cents),
  change_cents integer not null check (change_cents >= 0),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  check (
    (payment_method = 'cash' and amount_received_cents - total_cents = change_cents)
    or (payment_method <> 'cash' and amount_received_cents = total_cents and change_cents = 0)
  )
);

create index sales_created_at_idx on public.sales (created_at desc);

create table public.sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales (id) on delete restrict,
  product_id uuid not null references public.products (id) on delete restrict,
  product_code text not null,
  product_name text not null,
  quantity numeric(14, 3) not null check (quantity > 0),
  unit_price_cents integer not null check (unit_price_cents > 0),
  discount_bps integer not null check (discount_bps between 0 and 10000),
  subtotal_cents integer not null check (subtotal_cents >= 0),
  discount_cents integer not null check (discount_cents >= 0),
  total_cents integer not null check (total_cents >= 0),
  created_at timestamptz not null default now()
);

create index sale_items_sale_idx on public.sale_items (sale_id, created_at);
alter table public.sales enable row level security;
alter table public.sale_items enable row level security;
revoke all on public.sales, public.sale_items from anon, authenticated;

create or replace function public.record_sale(
  p_lines jsonb,
  p_payment_method text,
  p_amount_received_cents integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sale_id uuid;
  v_actor uuid := (select auth.uid());
  v_total bigint := 0;
  v_subtotal bigint;
  v_discount bigint;
  v_line_total bigint;
  v_line record;
  v_product record;
  v_role text;
  v_batch record;
  v_batch_remaining numeric;
  v_batch_take numeric;
  v_count integer := 0;
  v_distinct_count integer;
  v_change integer;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  select role into v_role from public.profiles where user_id = v_actor for share;
  if not found or v_role not in ('admin', 'manager', 'cashier') then
    raise exception 'Insufficient permissions';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array'
    or jsonb_array_length(p_lines) not between 1 and 100
    or p_payment_method is null or p_payment_method not in ('cash', 'pix', 'credit', 'debit')
    or p_amount_received_cents is null or p_amount_received_cents < 0 then
    raise exception 'Invalid sale';
  end if;

  select count(distinct product_id) into v_distinct_count
  from jsonb_to_recordset(p_lines) as lines(product_id uuid);
  if v_distinct_count <> jsonb_array_length(p_lines) then
    raise exception 'Duplicate products are not allowed in a sale';
  end if;

  for v_line in
    select * from jsonb_to_recordset(p_lines)
      as lines(product_id uuid, quantity numeric, unit_price_cents integer, discount_bps integer)
    order by product_id
  loop
    v_count := v_count + 1;
    if v_line.product_id is null or v_line.quantity is null
      or v_line.quantity <= 0 or v_line.quantity <> round(v_line.quantity, 3)
      or v_line.quantity > 99999999999.999
      or v_line.unit_price_cents is null or v_line.unit_price_cents <= 0
      or v_line.discount_bps is null or v_line.discount_bps not between 0 and 10000 then
      raise exception 'Invalid sale line';
    end if;

    select id, product_code, name, stock_quantity, unit_price_cents
      into v_product
      from public.products
      where id = v_line.product_id and active
      for update;
    if not found then raise exception 'Product not found or inactive'; end if;
    if v_role = 'cashier' and (
      v_line.unit_price_cents <> v_product.unit_price_cents or v_line.discount_bps <> 0
    ) then
      raise exception using errcode = '42501', message = 'Only managers can change sale prices or discounts';
    end if;
    if v_product.stock_quantity < v_line.quantity then
      raise exception 'Insufficient stock for product %', v_product.name;
    end if;

    v_subtotal := round(v_line.quantity * v_line.unit_price_cents);
    v_discount := round(v_subtotal * v_line.discount_bps / 10000);
    v_line_total := v_subtotal - v_discount;
    if v_subtotal > 2147483647 or v_total + v_line_total > 2147483647 then
      raise exception 'Sale total exceeds the supported limit';
    end if;
    v_total := v_total + v_line_total;
  end loop;

  if v_total <= 0 then raise exception 'Sale total must be greater than zero'; end if;
  if (p_payment_method = 'cash' and p_amount_received_cents < v_total)
    or (p_payment_method <> 'cash' and p_amount_received_cents <> v_total) then
    raise exception 'Invalid payment amount';
  end if;
  v_change := case when p_payment_method = 'cash'
    then (p_amount_received_cents - v_total)::integer else 0 end;

  insert into public.sales (
    total_cents, payment_method, amount_received_cents, change_cents, created_by
  ) values (
    v_total::integer, p_payment_method, p_amount_received_cents, v_change, v_actor
  ) returning id into v_sale_id;

  for v_line in
    select * from jsonb_to_recordset(p_lines)
      as lines(product_id uuid, quantity numeric, unit_price_cents integer, discount_bps integer)
    order by product_id
  loop
    select id, product_code, name into v_product
      from public.products where id = v_line.product_id;
    v_subtotal := round(v_line.quantity * v_line.unit_price_cents);
    v_discount := round(v_subtotal * v_line.discount_bps / 10000);
    v_line_total := v_subtotal - v_discount;

    update public.products
      set stock_quantity = stock_quantity - v_line.quantity
      where id = v_line.product_id;
    insert into public.inventory_movements (
      product_id, quantity_delta, reason, note, actor_user_id
    ) values (
      v_line.product_id, -v_line.quantity, 'sale', 'Venda ' || v_sale_id::text, v_actor
    );
    insert into public.sale_items (
      sale_id, product_id, product_code, product_name, quantity, unit_price_cents,
      discount_bps, subtotal_cents, discount_cents, total_cents
    ) values (
      v_sale_id, v_line.product_id, v_product.product_code, v_product.name, v_line.quantity,
      v_line.unit_price_cents, v_line.discount_bps, v_subtotal::integer,
      v_discount::integer, v_line_total::integer
    );

    v_batch_remaining := v_line.quantity;
    for v_batch in
      select id, remaining_quantity
        from public.product_batches
        where product_id = v_line.product_id and remaining_quantity > 0
        order by expiration_date asc nulls last, created_at, id
        for update
    loop
      exit when v_batch_remaining <= 0;
      v_batch_take := least(v_batch.remaining_quantity, v_batch_remaining);
      update public.product_batches
        set remaining_quantity = remaining_quantity - v_batch_take
        where id = v_batch.id;
      v_batch_remaining := v_batch_remaining - v_batch_take;
    end loop;
  end loop;

  return jsonb_build_object(
    'sale_id', v_sale_id,
    'total_cents', v_total,
    'change_cents', v_change
  );
end;
$$;

revoke all on function public.record_sale(jsonb, text, integer) from public, anon;
grant execute on function public.record_sale(jsonb, text, integer) to authenticated;

create or replace function public.record_purchase_invoice_with_markup(
  p_supplier_name text,
  p_invoice_number text,
  p_issue_date date,
  p_lines jsonb,
  p_apply_suggested_prices boolean,
  p_target_profit_bps integer
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
  v_pricing record;
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
    or jsonb_array_length(p_lines) not between 1 and 200
    or p_apply_suggested_prices is null
    or p_target_profit_bps is null or p_target_profit_bps not between 0 and 10000 then
    raise exception 'Invalid purchase invoice';
  end if;

  for v_line in select * from jsonb_to_recordset(p_lines)
    as lines(product_id uuid, quantity numeric, unit_cost_cents integer, expiration_date date)
    order by product_id
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
    if v_line_total <= 0 or v_line_total > 2147483647 then
      raise exception 'Invalid purchase line total';
    end if;
    v_invoice_total := v_invoice_total + v_line_total;
    if v_invoice_total > 2147483647 then
      raise exception 'Invoice total exceeds the supported limit';
    end if;
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
    select product_code, name into v_product from public.products
      where id = v_line.product_id and active;
    v_line_total := round(v_line.quantity * v_line.unit_cost_cents);
    insert into public.purchase_invoice_items (
      invoice_id, product_id, product_code, product_name, quantity,
      unit_cost_cents, line_total_cents, expiration_date
    ) values (
      v_invoice_id, v_line.product_id, v_product.product_code, v_product.name, v_line.quantity,
      v_line.unit_cost_cents, v_line_total::integer, v_line.expiration_date
    ) returning id into v_item_id;
    perform public.record_stock_movement_with_expiry(
      v_line.product_id, v_line.quantity, 'purchase',
      'Entrada da nota ' || trim(p_invoice_number) || ' · ' || trim(p_supplier_name),
      v_line.expiration_date, v_item_id
    );
  end loop;

  if p_apply_suggested_prices then
    for v_pricing in
      select product_id,
        round(sum(quantity * unit_cost_cents) / sum(quantity))::integer as unit_cost_cents
      from jsonb_to_recordset(p_lines)
        as lines(product_id uuid, quantity numeric, unit_cost_cents integer, expiration_date date)
      group by product_id
    loop
      perform public.save_product_pricing(
        v_pricing.product_id, v_pricing.unit_cost_cents, 0, 0, p_target_profit_bps
      );
    end loop;
  end if;

  return v_invoice_id;
end;
$$;

revoke all on function public.record_purchase_invoice_with_markup(text, text, date, jsonb, boolean, integer)
  from public, anon;
grant execute on function public.record_purchase_invoice_with_markup(text, text, date, jsonb, boolean, integer)
  to authenticated;

notify pgrst, 'reload schema';
