-- Requested six-entry daily limit. Preserve capital, position, history, and all other rules.
update public.rigged_runs r
set state=jsonb_set(
  jsonb_set(jsonb_set(r.state,'{config,max_daily_entries}','6'::jsonb),'{config,version}','2'::jsonb),
  '{entries_today}',to_jsonb(
    (select count(*) from public.rigged_trades t
     where t.run_id=r.id and to_char(t.opened_at at time zone 'UTC','YYYY-MM-DD')=r.state->>'day')
    + case when r.state->'position' <> 'null'::jsonb
      and to_char(to_timestamp((r.state->'position'->>'opened_at')::double precision/1000) at time zone 'UTC','YYYY-MM-DD')=r.state->>'day'
      then 1 else 0 end
  )
),version=version+1,updated_at=now()
where r.id='main';
