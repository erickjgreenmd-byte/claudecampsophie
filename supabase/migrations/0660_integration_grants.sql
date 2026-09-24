-- 0660_integration_grants.sql
-- Lead-integrated schema requests from the feature verticals (docs/ECC_Runs.md).

-- SR-FAMILY-1: guardian invitations must compare the accepting adult's VERIFIED auth email with the
-- invitation. Supabase does not grant service_role SELECT on auth.users, so a least-privilege
-- SECURITY DEFINER lookup is exposed to service_role only (the API calls it after its own checks).
create or replace function app.adult_auth_email(p_user uuid)
returns table (email text, email_verified boolean)
language sql stable security definer
set search_path = ''
as $$
  select u.email::text, u.email_confirmed_at is not null from auth.users u where u.id = p_user
$$;
revoke execute on function app.adult_auth_email(uuid) from public, anon, authenticated, pl_child;
grant execute on function app.adult_auth_email(uuid) to service_role;

-- Homework child view: a child may see a parent's override of their own result and the corrected
-- transcription of their own question/answer (never solutions). Row access stays under the
-- existing child RLS policies; these are column grants only (lesson L-003).
grant select (parent_override_verdict) on public.question_results to pl_child;
grant select (corrected_prompt_text, corrected_student_answer_text) on public.extracted_questions to pl_child;
