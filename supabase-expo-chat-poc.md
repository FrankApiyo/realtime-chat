# Real-Time Chat PoC: Supabase + Expo

A complete, follow-along guide for building a 1:1 chat app where:

1. Users authenticate with email/password.
2. They can start a conversation with another user.
3. Messages send and arrive in real time.
4. **Live typing**: every keystroke (before "Send") is mirrored on the other user's screen — the proof-of-concept feature you actually care about.

Backend: Supabase (Postgres + Auth + Realtime). Frontend: Expo (React Native).

---

## Architecture at a glance

```
┌────────────┐                   ┌────────────────────────┐
│ Expo app A │ ── PostgREST ───▶ │ Postgres (messages,    │
│            │ ◀── WebSocket ── │  conversations, RLS)   │
└────────────┘                   │                        │
       ▲                         │ Realtime (Elixir)      │
       │ broadcast              │  - Postgres Changes    │
       │ (typing)               │  - Broadcast (typing)  │
       ▼                         │  - Presence (online)   │
┌────────────┐                   │                        │
│ Expo app B │ ◀──────────────── │                        │
└────────────┘                   └────────────────────────┘
```

Two transport paths matter here:

| What | Mechanism | Why |
|------|-----------|-----|
| Sent messages (persisted) | `INSERT` to `public.messages` → Postgres Changes over WebSocket | Reliable, persisted, replayable |
| Live typing draft | Realtime **Broadcast** (ephemeral, never hits DB) | Low-latency, high-frequency, throwaway |
| Online status | Realtime **Presence** | CRDT-backed, no DB writes |

This split is the whole point. Don't write keystrokes to the DB — broadcast them.

---

## Prerequisites

- A Supabase account (free tier is fine for PoC)
- Node 20+ and npm/pnpm
- Expo CLI: `npm install -g expo-cli` (optional, `npx` works too)
- Two test devices to actually see the live-typing magic. Easiest: one iOS simulator + one Android emulator, or one simulator + Expo Go on your physical phone.
- `psql` or the Supabase SQL editor in the dashboard

---

# Part 1 — Supabase Backend

## 1.1 Create the project

1. Go to [supabase.com/dashboard](https://supabase.com/dashboard) → New Project.
2. Pick a region close to you (Frankfurt is usually best for Nairobi, lower RTT than us-east).
3. Save the **Project URL** and **anon/publishable key** — you'll paste these into the Expo app later.

## 1.2 Database schema

Open the SQL editor and run this whole block. It creates four tables and the helper function we need to break RLS recursion.

```sql
-- ───────────────────────────────────────────────
-- Profiles: 1:1 with auth.users
-- ───────────────────────────────────────────────
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    text unique not null,
  display_name text,
  avatar_url  text,
  created_at  timestamptz default now()
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
```

## 1.3 Row Level Security

Enable RLS on every table and add policies. Run as one block:

```sql
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
```

## 1.4 Enable Realtime on the messages table

Postgres Changes need the table added to the `supabase_realtime` publication:

```sql
alter publication supabase_realtime add table public.messages;
```

You can confirm in the dashboard under **Database → Publications**.

## 1.5 Realtime Authorization for private Broadcast channels

For Broadcast (typing), we use **private channels**. That means RLS policies on the `realtime.messages` table — separate from your `public.messages` table, confusingly named.

We'll use a channel topic per conversation: `conversation:<uuid>`.

```sql
-- Allow listening to broadcasts on a conversation channel if member.
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

-- Allow broadcasting to a conversation channel if member.
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
```

That's the entire backend. You now have: schema, auth-driven profile creation, RLS, Postgres-Changes streaming for messages, and authorized Broadcast channels for live typing.

---

# Part 2 — Expo App

## 2.1 Initialize

```bash
npx create-expo-app@latest chat-poc
cd chat-poc
```

Pick the **default** template (TypeScript, file-based routing via expo-router).

## 2.2 Dependencies

```bash
npx expo install @supabase/supabase-js \
                 @react-native-async-storage/async-storage \
                 react-native-url-polyfill \
                 expo-secure-store
```

## 2.3 Environment variables

Create `.env` at the project root:

```
EXPO_PUBLIC_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=eyJhbG...
```

`EXPO_PUBLIC_*` vars are exposed to the client — fine for the anon key, which is meant to be public.

## 2.4 Supabase client

`lib/supabase.ts`:

```typescript
import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(url, anonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false, // not a web app
  },
});
```

The `react-native-url-polyfill` import is non-negotiable — `@supabase/supabase-js` uses `URL` internals that RN doesn't ship.

## 2.5 Session context

`lib/auth.tsx`:

```tsx
import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';

const Ctx = createContext<{ session: Session | null; loading: boolean }>({
  session: null,
  loading: true,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  return <Ctx.Provider value={{ session, loading }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
```

Wrap `app/_layout.tsx` with `<AuthProvider>`.

---

# Part 3 — Auth screen

`app/(auth)/sign-in.tsx` (minimal, replace with your design later):

```tsx
import { useState } from 'react';
import { View, TextInput, Button, Text, Alert } from 'react-native';
import { supabase } from '@/lib/supabase';

export default function SignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function signIn() {
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) Alert.alert('Sign in failed', error.message);
  }

  async function signUp() {
    setBusy(true);
    const { error } = await supabase.auth.signUp({ email, password });
    setBusy(false);
    if (error) Alert.alert('Sign up failed', error.message);
    else Alert.alert('Check email', 'Confirm your account, then sign in.');
  }

  return (
    <View style={{ padding: 24, gap: 12, marginTop: 80 }}>
      <Text style={{ fontSize: 24, fontWeight: '600' }}>Chat PoC</Text>
      <TextInput placeholder="email" autoCapitalize="none" value={email}
        onChangeText={setEmail} style={input} />
      <TextInput placeholder="password" secureTextEntry value={password}
        onChangeText={setPassword} style={input} />
      <Button title="Sign in" onPress={signIn} disabled={busy} />
      <Button title="Create account" onPress={signUp} disabled={busy} />
    </View>
  );
}

const input = { borderWidth: 1, borderColor: '#ccc', padding: 12, borderRadius: 8 };
```

For the PoC, **disable email confirmation** in Supabase Dashboard → Authentication → Providers → Email → "Confirm email" off. You'll create two test accounts faster.

---

# Part 4 — Conversations list

This is the inbox. You'll need a way to start a new conversation with another user. For brevity, I'll show the list; "new conversation" is left as a small exercise (query `profiles`, pick one, insert into `conversations` and two rows in `conversation_members`).

`app/(app)/index.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { View, Text, FlatList, Pressable } from 'react-native';
import { Link } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';

type Conv = {
  id: string;
  title: string | null;
  last_message_at: string;
  other: { username: string; display_name: string | null } | null;
};

export default function Inbox() {
  const { session } = useAuth();
  const [convs, setConvs] = useState<Conv[]>([]);

  useEffect(() => {
    if (!session) return;
    (async () => {
      // Get my conversations + the "other" member's profile (for 1:1)
      const { data } = await supabase
        .from('conversations')
        .select(`
          id, title, last_message_at,
          conversation_members!inner ( user_id, profiles ( username, display_name ) )
        `)
        .order('last_message_at', { ascending: false });

      // Strip myself out of the members to find "other"
      const cleaned = (data ?? []).map((c: any) => {
        const others = c.conversation_members.filter(
          (m: any) => m.user_id !== session.user.id
        );
        return { ...c, other: others[0]?.profiles ?? null };
      });
      setConvs(cleaned);
    })();
  }, [session]);

  return (
    <FlatList
      data={convs}
      keyExtractor={(c) => c.id}
      renderItem={({ item }) => (
        <Link href={`/chat/${item.id}`} asChild>
          <Pressable style={{ padding: 16, borderBottomWidth: 1, borderColor: '#eee' }}>
            <Text style={{ fontWeight: '600' }}>
              {item.title ?? item.other?.display_name ?? item.other?.username ?? 'Chat'}
            </Text>
            <Text style={{ color: '#666', fontSize: 12 }}>
              {new Date(item.last_message_at).toLocaleString()}
            </Text>
          </Pressable>
        </Link>
      )}
    />
  );
}
```

---

# Part 5 — The chat screen (the core PoC)

This is where it all comes together. One screen. One channel. Three things on it:

1. **Postgres Changes** — receive new messages from the DB.
2. **Broadcast** — send/receive live keystrokes (the typing draft).
3. **Presence** — who's currently in this chat.

`app/(app)/chat/[id].tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { View, Text, FlatList, TextInput, Button, KeyboardAvoidingView, Platform } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';

type Message = {
  id: string;
  conversation_id: string;
  sender_id: string;
  content: string;
  created_at: string;
};

type TypingState = {
  user_id: string;
  draft: string;
  updated_at: number;
};

const TYPING_TTL_MS = 4000; // forget a peer's draft after 4s of silence

export default function ChatScreen() {
  const { id: conversationId } = useLocalSearchParams<{ id: string }>();
  const { session } = useAuth();
  const me = session!.user.id;

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [peerTyping, setPeerTyping] = useState<Record<string, TypingState>>({});

  const channelRef = useRef<RealtimeChannel | null>(null);
  const lastBroadcastRef = useRef(0);

  // ───────────── Initial load + realtime subscription ─────────────
  useEffect(() => {
    if (!conversationId) return;

    let cancelled = false;

    (async () => {
      // 1. Fetch history
      const { data } = await supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true })
        .limit(100);
      if (!cancelled && data) setMessages(data);
    })();

    // 2. Open realtime channel
    const channel = supabase.channel(`conversation:${conversationId}`, {
      config: {
        private: true,           // RLS-checked
        broadcast: { self: false }, // don't echo my own typing back to me
        presence: { key: me },
      },
    });

    // 2a. Postgres Changes — sent messages
    channel.on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `conversation_id=eq.${conversationId}`,
      },
      (payload) => {
        setMessages((prev) => {
          const m = payload.new as Message;
          if (prev.some((x) => x.id === m.id)) return prev; // de-dupe
          return [...prev, m];
        });
      }
    );

    // 2b. Broadcast — live typing
    channel.on('broadcast', { event: 'typing' }, ({ payload }) => {
      const t = payload as TypingState;
      if (t.user_id === me) return;
      setPeerTyping((prev) => ({ ...prev, [t.user_id]: t }));
    });

    // 2c. Presence — who's here right now
    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState();
      // Optional: derive online peers from `state`
      console.log('presence', state);
    });

    channel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await channel.track({ online_at: new Date().toISOString() });
      }
    });

    channelRef.current = channel;

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [conversationId]);

  // ───────────── TTL: clear stale typing ─────────────
  useEffect(() => {
    const interval = setInterval(() => {
      setPeerTyping((prev) => {
        const now = Date.now();
        const next: typeof prev = {};
        for (const [uid, t] of Object.entries(prev)) {
          if (now - t.updated_at < TYPING_TTL_MS && t.draft.length > 0) {
            next[uid] = t;
          }
        }
        return next;
      });
    }, 500);
    return () => clearInterval(interval);
  }, []);

  // ───────────── Live typing broadcast ─────────────
  function onChangeText(next: string) {
    setInput(next);

    // Throttle: at most one broadcast every 50ms
    const now = Date.now();
    if (now - lastBroadcastRef.current < 50) return;
    lastBroadcastRef.current = now;

    channelRef.current?.send({
      type: 'broadcast',
      event: 'typing',
      payload: {
        user_id: me,
        draft: next,
        updated_at: now,
      } satisfies TypingState,
    });
  }

  // ───────────── Send (persist) ─────────────
  async function send() {
    const content = input.trim();
    if (!content) return;
    setInput('');

    // Clear my draft on peers' screens immediately
    channelRef.current?.send({
      type: 'broadcast',
      event: 'typing',
      payload: { user_id: me, draft: '', updated_at: Date.now() },
    });

    const { error } = await supabase.from('messages').insert({
      conversation_id: conversationId,
      sender_id: me,
      content,
    });
    if (error) console.error('send failed', error);
    // The Postgres Changes subscription will deliver the row back to me too.
  }

  // ───────────── Render ─────────────
  const typingPeers = Object.values(peerTyping).filter((t) => t.draft.length > 0);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1 }}
    >
      <FlatList
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ padding: 12 }}
        renderItem={({ item }) => (
          <View
            style={{
              alignSelf: item.sender_id === me ? 'flex-end' : 'flex-start',
              backgroundColor: item.sender_id === me ? '#3478f6' : '#e5e5ea',
              padding: 10, borderRadius: 14, marginVertical: 3, maxWidth: '80%',
            }}
          >
            <Text style={{ color: item.sender_id === me ? '#fff' : '#000' }}>
              {item.content}
            </Text>
          </View>
        )}
      />

      {/* Live draft from peers — the PoC payoff */}
      {typingPeers.map((t) => (
        <View
          key={t.user_id}
          style={{
            alignSelf: 'flex-start',
            backgroundColor: '#f0f0f0',
            padding: 10, borderRadius: 14, marginHorizontal: 12, marginBottom: 4,
            opacity: 0.7, borderStyle: 'dashed', borderWidth: 1, borderColor: '#bbb',
          }}
        >
          <Text style={{ color: '#444', fontStyle: 'italic' }}>{t.draft}</Text>
        </View>
      ))}

      <View style={{ flexDirection: 'row', padding: 8, gap: 8 }}>
        <TextInput
          value={input}
          onChangeText={onChangeText}
          placeholder="Message…"
          style={{
            flex: 1, borderWidth: 1, borderColor: '#ccc',
            borderRadius: 20, paddingHorizontal: 14, paddingVertical: 10,
          }}
        />
        <Button title="Send" onPress={send} />
      </View>
    </KeyboardAvoidingView>
  );
}
```

### What's happening, in plain language

- One `RealtimeChannel` per conversation. Topic: `conversation:<uuid>`. Set `private: true` so RLS on `realtime.messages` applies.
- `broadcast: { self: false }` so my own keystrokes don't bounce back to me.
- On every keystroke I send a `typing` broadcast with my current full draft. Throttled to 20Hz max.
- Peers receive the broadcast and render the draft inline above the composer. A 4-second TTL clears it if I go idle.
- On send, I (a) clear my draft for peers, (b) `INSERT` into `public.messages`. The row arrives via Postgres Changes for everyone — including me — and gets appended.

### Why send the **full draft** instead of deltas

For a PoC, full-string replace is simpler and the payloads are tiny (a chat message is rarely > 1KB). Deltas (CRDT or operational transform) only matter at scale or for collaborative editing where multiple people type the same text simultaneously — not your case.

---

# Part 6 — Run two clients and watch the magic

1. Create two test users. The fastest path:
   - Sign up `alice@test.com` on Simulator A
   - Sign up `bob@test.com` on Simulator B (or Expo Go on your phone)
2. In the SQL editor, manually create a conversation linking them (you'll build a real "new conversation" UI later):

   ```sql
   with conv as (
     insert into public.conversations (created_by)
     values ((select id from auth.users where email = 'alice@test.com'))
     returning id
   )
   insert into public.conversation_members (conversation_id, user_id)
   select conv.id, u.id
   from conv, auth.users u
   where u.email in ('alice@test.com', 'bob@test.com');
   ```

3. Both clients open the chat. Start typing on Alice's device — you should see characters appear live on Bob's screen, then become a "real" message bubble when she hits Send.

To run:

```bash
npx expo start
```

Press `i` for iOS simulator, `a` for Android emulator. For a physical device, install Expo Go and scan the QR.

---

# Gotchas you'll hit

- **"401 / unauthorized" on the channel.** Your Realtime Authorization RLS policies on `realtime.messages` are wrong, OR you forgot `private: true`. Check the topic string matches `conversation:<uuid>` exactly.
- **Postgres Changes silent.** You forgot `alter publication supabase_realtime add table public.messages;`.
- **`URL is not defined` at startup.** Missing `react-native-url-polyfill/auto` in `lib/supabase.ts`.
- **Session not persisting between launches.** AsyncStorage isn't installed, or `persistSession: true` is missing.
- **My own typing echoes back to me.** Set `broadcast: { self: false }` in channel config.
- **Typing payload doesn't clear when peer goes idle.** That's the TTL job — the 500ms interval that prunes stale entries. Don't skip it; without it the last keystroke "sticks" forever.
- **Latency feels bad on the first keystroke.** That's the WebSocket handshake, not the broadcast. Subsequent keystrokes ride the open socket and should be sub-100ms in-region.

---

# Where to take this next

- **Move sent-message delivery from Postgres Changes to Broadcast-from-database.** Supabase is steering people that direction for scale. You'd add an `AFTER INSERT` trigger on `public.messages` that calls `realtime.broadcast_changes(...)`. Postgres Changes opens a logical replication slot per listener path; broadcast-from-DB uses one slot for everyone.
- **Read receipts and "seen" state.** Add a `message_reads (message_id, user_id, read_at)` table; clients update on viewport visibility.
- **Typing indicator instead of full draft preview.** Most production chat apps don't show keystrokes (privacy + accidental-send anxiety). A simple "Bob is typing…" with a 3s debounced reset is one boolean broadcast, not a string. Your PoC happens to be the more aggressive variant — useful if the "something else" you're prototyping is collaborative writing or a co-pilot UI.
- **Push notifications when offline.** Hook into Expo Notifications + a Postgres trigger calling an Edge Function that talks to Expo's push service.
- **End-to-end encryption.** If you ever need it, encrypt `content` client-side before insert. Supabase only sees ciphertext. Broadcast payloads (typing) should also be encrypted, which gets fiddly because key exchange is on you.
- **Search.** Add `tsvector` column to `messages` with a generated index — full-text search comes free with Postgres.

---

# Quick sanity checklist before you start coding

- [ ] Project created, region chosen
- [ ] Schema + RLS + helper function applied
- [ ] `messages` added to `supabase_realtime` publication
- [ ] `realtime.messages` policies for the `conversation:*` topic
- [ ] Email confirmation disabled (PoC only)
- [ ] Expo project initialized with the four packages
- [ ] `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` in `.env`
- [ ] Two test users created and a conversation manually linking them
