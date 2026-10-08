-- Requested: retain the initial stop until total net profit reaches initial margin.
-- A stop placed exactly at its activation level is an immediate profit exit.
-- Preserve the account, ledger, and frozen plans of any already open position.
update public.rigged_runs
set state=jsonb_set(jsonb_set(state,'{config,version}','6'::jsonb),
    '{config,profit_lock_roi}','1'::jsonb)
  || jsonb_build_object('strategy_changes',coalesce(state->'strategy_changes','[]'::jsonb)
    || jsonb_build_array(jsonb_build_object('version',6,'changed_at',now(),
      'effective_after_candle',state->'last_candle',
      'change','Keep initial stop; close remaining quantity at 100% net initial-margin profit'))),
  version=version+1,updated_at=now()
where id='main';
