# Supabase setup

This project's database schema, auth config, RLS policies, and realtime authorization are codified in `supabase/`. Anyone cloning the repo should be able to reproduce a working backend without touching the Supabase dashboard.

## What's in the repo

| Path | Purpose |
|---|---|
| `supabase/config.toml` | Local stack config: ports, auth providers, storage, realtime, edge runtime |
| `supabase/migrations/*.sql` | Schema, triggers, RLS policies, realtime publication. Append-only once shared. |
| `supabase/seed.sql` | Optional deterministic seed data for local dev (not committed yet) |
| `chat-poc/.env.example` | Template for the Expo app's Supabase URL + anon key |

What is **not** in the repo (and shouldn't be):

- `supabase/.temp/` — local CLI cache
- `.env`, `.env.local` — real keys
- Anything you clicked in the dashboard. If you must click, capture it with `supabase db diff` (see [Day-2 workflows](#day-2-workflows)).

## Prerequisites

- **Docker Desktop** running (the local stack is a set of containers).
- **Supabase CLI** ≥ 1.200 — `brew install supabase/tap/supabase` on macOS, or see [supabase CLI install](https://supabase.com/docs/guides/local-development/cli/getting-started).
- **Node** ≥ 20 and the project's package manager (the Expo app uses npm).

Verify:

```bash
docker info >/dev/null && echo "docker ok"
supabase --version
node --version
```

## Path A — local-only stack (recommended for day-to-day dev)

Spins up Postgres + Auth + Realtime + Storage + Studio in Docker on your machine. No cloud account needed.

```bash
# from repo root
supabase start          # first run pulls images; subsequent starts are fast
supabase db reset       # applies every migration in order; runs seed.sql if present
supabase status         # prints the URLs and keys you need
```

Take the `API URL` and `anon key` from `supabase status` and put them in `chat-poc/.env`:

```bash
cp chat-poc/.env.example chat-poc/.env
# edit chat-poc/.env:
#   EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
#   EXPO_PUBLIC_SUPABASE_ANON_KEY=<anon key from `supabase status`>
```

Then run the app:

```bash
cd chat-poc && npm install && npm run start
```

Open Studio at `http://127.0.0.1:54323` to inspect tables, run SQL, or watch realtime.

When you're done for the day:

```bash
supabase stop           # preserves data
# or
supabase stop --no-backup  # discards data
```

## Path B — link to your own Supabase cloud project

Use this when you want a hosted backend (sharing with testers, running on a real device without local network setup, etc.).

1. Create a new project at [supabase.com/dashboard](https://supabase.com/dashboard). Note the **project ref** (the subdomain, e.g. `abcdxyz` from `abcdxyz.supabase.co`).
2. Link this repo to it:

   ```bash
   supabase login
   supabase link --project-ref <your-ref>
   ```

3. Push the schema:

   ```bash
   supabase db push        # applies migrations to the remote project
   ```

4. Copy your project's URL and anon key from **Project Settings → API** in the dashboard into `chat-poc/.env`:

   ```
   EXPO_PUBLIC_SUPABASE_URL=https://<your-ref>.supabase.co
   EXPO_PUBLIC_SUPABASE_ANON_KEY=<anon key>
   ```

> **Never commit a real anon key or service role key.** The anon key is safe to ship in a client app, but committing it into git makes rotation harder.

## Day-2 workflows

### Create a new schema change

```bash
supabase migration new add_message_reactions
# edit the new file in supabase/migrations/
supabase db reset       # rebuilds local db from scratch with all migrations
```

Once you're happy locally, commit the file. To apply to a linked cloud project: `supabase db push`.

### Captured a change in the dashboard by accident

```bash
supabase db diff -f captured_change   # writes a new migration file from the diff
```

Review the generated SQL, edit if needed, commit. Now it's reproducible.

### Regenerate TypeScript types from the schema

```bash
supabase gen types typescript --local > chat-poc/types/supabase.ts
# or against your linked cloud project:
supabase gen types typescript --linked > chat-poc/types/supabase.ts
```

(Add `chat-poc/types/` and run this whenever you change the schema.)

### Reset to a clean state

```bash
supabase db reset        # local: drops, recreates, reapplies migrations + seed
```

### Stop everything and free disk

```bash
supabase stop --no-backup
docker volume prune       # last resort if volumes get corrupted
```

## Onboarding checklist (for a new dev cloning the repo)

1. Install Docker Desktop, Supabase CLI, Node.
2. `git clone` and `cd realtime-chat`.
3. `supabase start && supabase db reset`.
4. `cp chat-poc/.env.example chat-poc/.env` and fill in values from `supabase status`.
5. `cd chat-poc && npm install && npm run start`.
6. Sign up a test user via the app or Studio's auth panel — the `handle_new_user` trigger should auto-create a `profiles` row.

If any step above fails, see [Troubleshooting](#troubleshooting).

## Troubleshooting

**`supabase start` hangs or times out.**
Docker isn't running, or you're low on disk. Check `docker info`. Try `supabase stop --no-backup && supabase start`.

**Port already in use (54321 / 54322 / 54323).**
Another `supabase` instance from a different project is running. `supabase stop` from that project's directory, or change the ports in `supabase/config.toml`.

**Migrations fail on `supabase db reset` but worked yesterday.**
Someone edited an existing migration file. Migrations are append-only once shared — revert the edit and create a new migration instead. If you need to squash, do it on a feature branch before merging.

**`supabase db push` says "migration history mismatch".**
Local migration files don't match what's already applied to the cloud project. Inspect with `supabase migration list`. Usually means someone ran SQL in the dashboard. Resolve by capturing the drift with `supabase db diff` or by running `supabase migration repair` (read the docs first — it edits migration history).

**Realtime channel rejects subscriptions with 401 / "permission denied".**
The `realtime.messages` RLS policies in the init migration only allow members of the conversation. Verify (a) the user is authenticated, (b) there's a row in `conversation_members` for them, (c) the channel topic matches `conversation:<uuid>` exactly.

**App can't reach the local stack from a physical device.**
`127.0.0.1` resolves to the device, not your laptop. Use your laptop's LAN IP (e.g. `http://192.168.1.42:54321`) in `EXPO_PUBLIC_SUPABASE_URL` and make sure your firewall allows it. Easier alternative: use Path B (cloud project) for device testing.

**Auth emails (signup confirm, magic link) don't arrive locally.**
The local stack ships with [Inbucket](http://127.0.0.1:54324) — all outbound mail lands there, not in real inboxes.

## References

- Supabase CLI commands: <https://supabase.com/docs/reference/cli>
- Local development guide: <https://supabase.com/docs/guides/local-development>
- Migrations & schema management: <https://supabase.com/docs/guides/deployment/database-migrations>
- Realtime authorization: <https://supabase.com/docs/guides/realtime/authorization>
