create table public.payment_settings (
  id boolean primary key default true check (id),
  pix_payment_mode text not null default 'manual'
    check (pix_payment_mode in ('manual', 'mercadopago')),
  pix_key text not null default '' check (char_length(pix_key) <= 77),
  merchant_name text not null default 'AAC COMERCIAL'
    check (char_length(trim(merchant_name)) between 1 and 25),
  merchant_city text not null default 'BRASIL'
    check (char_length(trim(merchant_city)) between 1 and 15),
  updated_by uuid references auth.users (id),
  updated_at timestamptz not null default now()
);

insert into public.payment_settings (id) values (true)
on conflict (id) do nothing;

alter table public.payment_settings enable row level security;
revoke all on public.payment_settings from anon, authenticated;
grant select, update on public.payment_settings to authenticated;

create policy "Authenticated staff can read Pix payment settings"
  on public.payment_settings for select to authenticated
  using (exists (
    select 1 from public.profiles
    where user_id = (select auth.uid())
      and role in ('admin', 'manager', 'cashier')
  ));

create policy "Managers can update Pix payment settings"
  on public.payment_settings for update to authenticated
  using (exists (
    select 1 from public.profiles
    where user_id = (select auth.uid()) and role in ('admin', 'manager')
  ))
  with check (exists (
    select 1 from public.profiles
    where user_id = (select auth.uid()) and role in ('admin', 'manager')
  ));

create or replace function public.set_payment_settings_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  new.updated_by = (select auth.uid());
  return new;
end;
$$;

create trigger payment_settings_set_updated_at
  before update on public.payment_settings
  for each row execute function public.set_payment_settings_updated_at();

revoke all on function public.set_payment_settings_updated_at() from public, anon, authenticated;

notify pgrst, 'reload schema';
