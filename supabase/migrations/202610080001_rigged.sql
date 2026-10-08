-- Rigged owns only these three tables. Existing applications are untouched.
create table public.rigged_runs (
  id text primary key check (id = 'main'),
  version bigint not null default 0,
  state jsonb not null,
  updated_at timestamptz not null default now()
);
create table public.rigged_trades (
  id text primary key,
  run_id text not null references public.rigged_runs(id),
  opened_at timestamptz not null, closed_at timestamptz not null,
  side text not null check(side in ('long','short')),
  entry double precision not null, exit double precision not null,
  margin double precision not null, net_pnl double precision not null,
  fees double precision not null, funding double precision not null,
  reason text not null
);
create index rigged_trades_time on public.rigged_trades(closed_at desc);
create table public.rigged_samples (
  run_id text not null references public.rigged_runs(id),
  observed_at timestamptz not null, equity double precision not null,
  price double precision not null,
  primary key (run_id,observed_at)
);
alter table public.rigged_runs enable row level security;
alter table public.rigged_trades enable row level security;
alter table public.rigged_samples enable row level security;
revoke all on public.rigged_runs, public.rigged_trades, public.rigged_samples from anon,authenticated;
grant select on public.rigged_runs, public.rigged_trades, public.rigged_samples to anon,authenticated;
grant all on public.rigged_runs, public.rigged_trades, public.rigged_samples to service_role;
create policy "Public experiment state" on public.rigged_runs for select to anon,authenticated using(true);
create policy "Public experiment trades" on public.rigged_trades for select to anon,authenticated using(true);
create policy "Public experiment samples" on public.rigged_samples for select to anon,authenticated using(true);

-- Atomic compare-and-swap: overlapping scheduler invocations cannot double-trade.
create function public.rigged_commit(expected_version bigint, next_state jsonb, trades jsonb, samples jsonb)
returns bigint language plpgsql set search_path = '' as $$
declare current_version bigint;
begin
  if expected_version = -1 then
    insert into public.rigged_runs(id,state) values('main',next_state) on conflict do nothing;
    if not found then raise exception 'Rigged state conflict'; end if;
    current_version := 0;
  else
    update public.rigged_runs set state=next_state,version=version+1,updated_at=now()
      where id='main' and version=expected_version returning version into current_version;
    if not found then raise exception 'Rigged state conflict'; end if;
  end if;
  insert into public.rigged_trades
    select * from jsonb_populate_recordset(null::public.rigged_trades,trades);
  insert into public.rigged_samples
    select * from jsonb_populate_recordset(null::public.rigged_samples,samples);
  return current_version;
end; $$;
revoke all on function public.rigged_commit(bigint,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.rigged_commit(bigint,jsonb,jsonb,jsonb) to service_role;
