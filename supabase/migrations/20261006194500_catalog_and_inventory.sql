create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  role text not null default 'cashier'
    check (role in ('admin', 'manager', 'cashier')),
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, display_name)
  values (
    new.id,
    nullif(left(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), 120), '')
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

revoke all on function public.handle_new_user() from public, anon, authenticated;

insert into public.profiles (user_id, display_name)
select
  id,
  nullif(left(trim(coalesce(raw_user_meta_data ->> 'full_name', '')), 120), '')
from auth.users
on conflict (user_id) do nothing;

create or replace function public.has_inventory_write_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles
    where user_id = (select auth.uid())
      and role in ('admin', 'manager')
  );
$$;

revoke all on function public.has_inventory_write_access() from public, anon;
grant execute on function public.has_inventory_write_access() to authenticated;

create table public.products (
  id uuid primary key default gen_random_uuid(),
  product_code text not null check (char_length(trim(product_code)) between 1 and 60),
  barcode text check (barcode is null or char_length(trim(barcode)) between 1 and 64),
  name text not null check (char_length(trim(name)) between 1 and 160),
  unit text not null default 'UN' check (char_length(trim(unit)) between 1 and 8),
  unit_price_cents integer not null check (unit_price_cents >= 0),
  stock_quantity numeric(14, 3) not null default 0 check (stock_quantity >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index products_code_ci_unique
  on public.products (lower(trim(product_code)));
create unique index products_barcode_ci_unique
  on public.products (lower(trim(barcode)))
  where barcode is not null;
create index products_name_ci_idx on public.products (lower(name));

create or replace function public.normalize_product_fields()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.product_code = upper(trim(new.product_code));
  new.barcode = nullif(trim(new.barcode), '');
  new.name = trim(new.name);
  new.unit = upper(trim(new.unit));
  return new;
end;
$$;

create trigger products_normalize_fields
  before insert or update on public.products
  for each row execute function public.normalize_product_fields();

create table public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete restrict,
  quantity_delta numeric(14, 3) not null check (quantity_delta <> 0),
  reason text not null check (reason in ('purchase', 'adjustment', 'return')),
  note text check (note is null or char_length(note) <= 500),
  actor_user_id uuid not null references auth.users (id),
  created_at timestamptz not null default now()
);

create index inventory_movements_product_created_idx
  on public.inventory_movements (product_id, created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger products_set_updated_at
  before update on public.products
  for each row execute function public.set_updated_at();

revoke all on function public.set_updated_at() from public, anon, authenticated;
revoke all on function public.normalize_product_fields() from public, anon, authenticated;

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
declare
  v_movement public.inventory_movements;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required';
  end if;

  if not public.has_inventory_write_access() then
    raise exception 'Insufficient permissions';
  end if;

  if p_quantity is null
    or p_quantity = 0
    or p_quantity <> round(p_quantity, 3)
    or abs(p_quantity) > 99999999999.999 then
    raise exception 'Invalid stock quantity';
  end if;

  if p_reason is null or p_reason not in ('purchase', 'adjustment', 'return') then
    raise exception 'Invalid stock movement reason';
  end if;

  if p_reason in ('purchase', 'return') and p_quantity < 0 then
    raise exception 'Purchase and return movements must add stock';
  end if;

  if p_note is not null and char_length(p_note) > 500 then
    raise exception 'Stock movement note is too long';
  end if;

  update public.products
  set stock_quantity = stock_quantity + p_quantity
  where id = p_product_id
    and active
    and stock_quantity + p_quantity >= 0;

  if not found then
    raise exception 'Product not found, inactive, or insufficient stock';
  end if;

  insert into public.inventory_movements (
    product_id, quantity_delta, reason, note, actor_user_id
  )
  values (
    p_product_id, p_quantity, p_reason, nullif(trim(p_note), ''), (select auth.uid())
  )
  returning * into v_movement;

  return v_movement;
end;
$$;

revoke all on function public.record_stock_movement(uuid, numeric, text, text)
  from public, anon;
grant execute on function public.record_stock_movement(uuid, numeric, text, text)
  to authenticated;

alter table public.profiles enable row level security;
alter table public.products enable row level security;
alter table public.inventory_movements enable row level security;

create policy "Users can read their own profile"
  on public.profiles for select to authenticated
  using (user_id = (select auth.uid()));

create policy "Authenticated users can read active products"
  on public.products for select to authenticated
  using (active or public.has_inventory_write_access());

create policy "Managers can add products"
  on public.products for insert to authenticated
  with check (public.has_inventory_write_access());

create policy "Managers can update products"
  on public.products for update to authenticated
  using (public.has_inventory_write_access())
  with check (public.has_inventory_write_access());

create policy "Managers can read inventory history"
  on public.inventory_movements for select to authenticated
  using (public.has_inventory_write_access());

grant select on public.profiles to authenticated;
grant select on public.products to authenticated;
grant insert (product_code, barcode, name, unit, unit_price_cents)
  on public.products to authenticated;
grant update (product_code, barcode, name, unit, unit_price_cents, active)
  on public.products to authenticated;
grant select on public.inventory_movements to authenticated;
