-- Run with an administrative SQL connection after applying migrations.
do $$
declare t text; r text;
begin
  foreach t in array array['rigged_runs','rigged_trades','rigged_samples','rigged_candles'] loop
    foreach r in array array['anon','authenticated'] loop
      if not has_table_privilege(r,'public.'||t,'SELECT') then raise exception '% cannot read %',r,t; end if;
      if has_table_privilege(r,'public.'||t,'INSERT,UPDATE,DELETE') then raise exception '% can write %',r,t; end if;
    end loop;
    if not (select relrowsecurity from pg_class where oid=('public.'||t)::regclass) then raise exception 'RLS missing on %',t; end if;
  end loop;
  foreach r in array array['anon','authenticated'] loop
    if has_function_privilege(r,'public.rigged_commit(bigint,jsonb,jsonb,jsonb)','EXECUTE') then raise exception '% can advance the experiment',r; end if;
    if has_function_privilege(r,'public.rigged_authorize(text)','EXECUTE') then raise exception '% can check scheduler credentials',r; end if;
    if has_function_privilege(r,'public.rigged_save_candles(jsonb,timestamptz)','EXECUTE') then raise exception '% can change chart candles',r; end if;
  end loop;
end $$;
