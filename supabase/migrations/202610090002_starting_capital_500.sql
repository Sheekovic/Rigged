-- Requested capital increase before the run's first trade. Keep the range and history.
do $$
begin
  perform 1 from public.rigged_runs where id='main'
    and (state->>'closed')::int=0 and state->'position'='null'::jsonb
    and (state->>'balance')::numeric=100 for update;
  if not found then
    raise exception 'Capital update requires the verified untouched $100 account';
  end if;
  update public.rigged_runs
  set state=jsonb_set(state,'{config,starting_capital}','500'::jsonb)
    || jsonb_build_object('balance',500,'equity',500,'peak',500,'max_drawdown',0,
      'capital_started_at',now(),'capital_changes',coalesce(state->'capital_changes','[]'::jsonb)
        || jsonb_build_array(jsonb_build_object('changed_at',now(),'previous_capital',100,
          'new_capital',500,'reason','Requested increase before first trade'))),
    version=version+1,updated_at=now()
  where id='main';
end $$;
