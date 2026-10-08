create table public.rigged_candles (
  time bigint primary key check(time % 3600000 = 0),
  open double precision not null, high double precision not null,
  low double precision not null, close double precision not null,
  volume double precision not null, is_closed boolean not null,
  updated_at timestamptz not null,
  check(low>0 and low<=open and low<=close and high>=open and high>=close and volume>=0)
);
alter table public.rigged_candles enable row level security;
revoke all on public.rigged_candles from anon,authenticated;
grant select on public.rigged_candles to anon,authenticated;
grant all on public.rigged_candles to service_role;
create policy "Public hourly market candles" on public.rigged_candles for select to anon,authenticated using(true);
create function public.rigged_save_candles(candles jsonb,source_observed_at timestamptz)
returns void language sql set search_path='' as $$
  insert into public.rigged_candles(time,open,high,low,close,volume,is_closed,updated_at)
    select time,open,high,low,close,volume,is_closed,source_observed_at
    from jsonb_to_recordset(candles) as c(time bigint,open double precision,high double precision,
      low double precision,close double precision,volume double precision,is_closed boolean)
  on conflict(time) do update set open=excluded.open,high=excluded.high,low=excluded.low,
    close=excluded.close,volume=excluded.volume,is_closed=excluded.is_closed,updated_at=excluded.updated_at
  where public.rigged_candles.updated_at<=excluded.updated_at;
$$;
revoke all on function public.rigged_save_candles(jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.rigged_save_candles(jsonb,timestamptz) to service_role;
alter table public.rigged_trades add column strategy_version integer default 2;
alter table public.rigged_trades add column fib jsonb;
-- Preserve the current account and ledger. This is an explicitly versioned rule change.
update public.rigged_runs
set state=jsonb_set(jsonb_set(jsonb_set(state,'{config,version}','3'::jsonb),
  '{config,fib_enabled}','true'::jsonb),'{config,fib_stop_buffer}','0.001'::jsonb)
  || jsonb_build_object('strategy_changes',coalesce(state->'strategy_changes','[]'::jsonb)
    || jsonb_build_array(jsonb_build_object('version',3,'changed_at',now(),'effective_after_candle',state->'last_candle'))),
  version=version+1,updated_at=now()
where id='main';
