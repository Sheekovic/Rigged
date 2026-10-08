-- Exercise two workers holding the same version, then roll back the test entirely.
begin;
do $$
declare saved public.rigged_runs; committed_version bigint; conflict_detected boolean := false;
begin
  select * into strict saved from public.rigged_runs where id='main' for update;
  committed_version := public.rigged_commit(saved.version,saved.state,'[]'::jsonb,'[]'::jsonb);
  begin
    perform public.rigged_commit(saved.version,saved.state,'[]'::jsonb,'[]'::jsonb);
  exception when others then
    if sqlerrm <> 'Rigged state conflict' then raise; end if;
    conflict_detected := true;
  end;
  if not conflict_detected then raise exception 'Concurrent stale worker was accepted'; end if;
  if (select version from public.rigged_runs where id='main') <> committed_version then
    raise exception 'Rejected worker changed committed state';
  end if;
end $$;
rollback;
