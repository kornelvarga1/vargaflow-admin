-- Push notification subscriptions
create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid references public.businesses(id) on delete cascade,
  subscription jsonb not null,
  created_at  timestamptz not null default now(),
  unique (business_id)   -- one active sub per business (latest overwrites)
);

alter table public.push_subscriptions enable row level security;

-- Service role has full access (edge functions use service role)
create policy "service role full access"
  on public.push_subscriptions
  using (true)
  with check (true);

-- Add direction + push_notified columns to message_queue for inbound SMS tracking
alter table public.message_queue
  add column if not exists direction text not null default 'outbound',
  add column if not exists push_notified boolean not null default false;

create index if not exists message_queue_inbound_idx
  on public.message_queue (business_id, direction, push_notified, created_at)
  where direction = 'inbound' and push_notified = false;
