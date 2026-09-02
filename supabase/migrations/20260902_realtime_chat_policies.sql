-- Realtime authorisation for the private chat channels used by the salon app.
--   user:<erp user id>          → only that user
--   chat:group:<chat group id>  → only members of that group
-- Server-side broadcasts use the service key (bypass RLS); clients subscribe
-- with their Supabase Auth token. SECURITY DEFINER helpers keep the policy
-- from needing table grants for the `authenticated` role (Data API stays off).

create or replace function public.current_erp_user_id()
returns bigint language sql stable security definer set search_path = public as $$
  select id from public.users where auth_user_id = auth.uid() limit 1
$$;
revoke all on function public.current_erp_user_id() from public;
grant execute on function public.current_erp_user_id() to authenticated;

create or replace function public.is_chat_member(gid bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.chat_group_members m
     where m.group_id = gid and m.user_id = public.current_erp_user_id())
$$;
revoke all on function public.is_chat_member(bigint) from public;
grant execute on function public.is_chat_member(bigint) to authenticated;

drop policy if exists "salon realtime receive" on realtime.messages;
create policy "salon realtime receive" on realtime.messages
  for select to authenticated
  using (
    (realtime.topic() like 'user:%'
      and split_part(realtime.topic(), ':', 2) ~ '^[0-9]+$'
      and split_part(realtime.topic(), ':', 2)::bigint = public.current_erp_user_id())
    or
    (realtime.topic() like 'chat:group:%'
      and split_part(realtime.topic(), ':', 3) ~ '^[0-9]+$'
      and public.is_chat_member(split_part(realtime.topic(), ':', 3)::bigint))
  );
-- Clients never send on these channels (the Edge Function broadcasts), so no
-- INSERT policy is granted.
