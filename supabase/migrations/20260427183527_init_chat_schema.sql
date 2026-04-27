-- ───────────────────────────────────────────────
-- Profiles: 1:1 with auth.users
-- ───────────────────────────────────────────────
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  username     text unique not null,
  display_name text,
  avatar_url   text,
  created_at   timestamptz default now()
);

-- Auto-create a profile row when a new auth user signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, username, display_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1))
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ───────────────────────────────────────────────
-- Conversations + members
-- ───────────────────────────────────────────────
create table public.conversations (
  id              uuid primary key default gen_random_uuid(),
  is_group        boolean default false,
  title           text,
  created_by      uuid references public.profiles(id),
  created_at      timestamptz default now(),
  last_message_at timestamptz default now()
);

create table public.conversation_members (
  conversation_id uuid references public.conversations(id) on delete cascade,
  user_id         uuid references public.profiles(id) on delete cascade,
  joined_at       timestamptz default now(),
  primary key (conversation_id, user_id)
);

create index on public.conversation_members(user_id);

-- ───────────────────────────────────────────────
-- Messages
-- ───────────────────────────────────────────────
create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.conversations(id) on delete cascade not null,
  sender_id       uuid references public.profiles(id) on delete cascade not null,
  content         text not null check (length(content) between 1 and 4000),
  created_at      timestamptz default now()
);

create index on public.messages(conversation_id, created_at desc);

-- Bump conversations.last_message_at on insert (for inbox sort)
create or replace function public.bump_conversation_last_message()
returns trigger language plpgsql as $$
begin
  update public.conversations
     set last_message_at = new.created_at
   where id = new.conversation_id;
  return new;
end;
$$;

create trigger bump_last_message
  after insert on public.messages
  for each row execute function public.bump_conversation_last_message();

-- ───────────────────────────────────────────────
-- Helper: avoids RLS recursion on conversation_members
-- ───────────────────────────────────────────────
create or replace function public.is_conversation_member(conv_id uuid, uid uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists(
    select 1 from public.conversation_members
    where conversation_id = conv_id and user_id = uid
  );
$$;

-- ───────────────────────────────────────────────
-- Row Level Security
-- ───────────────────────────────────────────────
alter table public.profiles             enable row level security;
alter table public.conversations        enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages             enable row level security;

-- Profiles: anyone authenticated can read; only self can update.
create policy "profiles read all" on public.profiles
  for select to authenticated using (true);

create policy "profiles update self" on public.profiles
  for update to authenticated using (auth.uid() = id);

-- Conversations: visible to members; any authed user can create.
create policy "conversations read members" on public.conversations
  for select to authenticated
  using (public.is_conversation_member(id, auth.uid()));

create policy "conversations insert any" on public.conversations
  for insert to authenticated
  with check (auth.uid() = created_by);

-- Members: a row is visible if you're a member of that conversation.
-- Insert: you can add yourself, OR the conversation creator can add anyone.
create policy "members read own conv" on public.conversation_members
  for select to authenticated
  using (public.is_conversation_member(conversation_id, auth.uid()));

create policy "members self-add" on public.conversation_members
  for insert to authenticated
  with check (
    user_id = auth.uid()
    or exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.created_by = auth.uid()
    )
  );

-- Messages: members can read; senders who are members can write.
create policy "messages read members" on public.messages
  for select to authenticated
  using (public.is_conversation_member(conversation_id, auth.uid()));

create policy "messages insert sender" on public.messages
  for insert to authenticated
  with check (
    sender_id = auth.uid()
    and public.is_conversation_member(conversation_id, auth.uid())
  );

-- ───────────────────────────────────────────────
-- Realtime: stream INSERTs on public.messages
-- ───────────────────────────────────────────────
alter publication supabase_realtime add table public.messages;

-- ───────────────────────────────────────────────
-- Realtime Authorization: private Broadcast channels
-- Topic format: conversation:<uuid>
-- ───────────────────────────────────────────────
create policy "realtime read for members" on realtime.messages
  for select to authenticated
  using (
    exists (
      select 1 from public.conversation_members cm
      where cm.user_id = auth.uid()
        and ('conversation:' || cm.conversation_id::text) = (
          select realtime.topic()
        )
    )
  );

create policy "realtime write for members" on realtime.messages
  for insert to authenticated
  with check (
    exists (
      select 1 from public.conversation_members cm
      where cm.user_id = auth.uid()
        and ('conversation:' || cm.conversation_id::text) = (
          select realtime.topic()
        )
    )
  );
