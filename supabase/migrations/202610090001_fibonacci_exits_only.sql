-- Requested correction: Fibonacci exits only, 25% staged fills and a stepped stop.
alter table public.rigged_trades add column fills jsonb;
-- Preserve the account and ledger. Open positions retain their frozen exit plans.
update public.rigged_runs
set state=jsonb_set(jsonb_set(jsonb_set(state,'{config,version}','5'::jsonb),
  '{config,fib_entry_filter}','false'::jsonb),'{config,fib_partial_exits}','true'::jsonb)
  || jsonb_build_object('strategy_changes',coalesce(state->'strategy_changes','[]'::jsonb)
    || jsonb_build_array(jsonb_build_object('version',5,'changed_at',now(),
       'effective_after_candle',state->'last_candle','change','Range entries; Fibonacci staged exits and stepped stop'))),
  version=version+1,updated_at=now()
where id='main';
