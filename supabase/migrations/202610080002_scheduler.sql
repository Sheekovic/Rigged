create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
-- Token is generated and retained entirely inside the database.
select vault.create_secret(encode(extensions.gen_random_bytes(32),'hex'),'rigged_scheduler_token');
create function public.rigged_authorize(token text) returns boolean
language sql security definer set search_path = '' as $$
  select exists(select 1 from vault.decrypted_secrets where name='rigged_scheduler_token' and decrypted_secret=token);
$$;
revoke all on function public.rigged_authorize(text) from public,anon,authenticated;
grant execute on function public.rigged_authorize(text) to service_role;
select cron.schedule('rigged-every-minute','* * * * *',$job$
  select net.http_post(
    url:='https://qpicjlawxgimjrkozbyr.supabase.co/functions/v1/rigged-tick',
    headers:=jsonb_build_object('Content-Type','application/json','x-rigged-token',
      (select decrypted_secret from vault.decrypted_secrets where name='rigged_scheduler_token')),
    body:='{}'::jsonb,timeout_milliseconds:=55000
  );
$job$);
