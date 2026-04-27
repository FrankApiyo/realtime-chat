# realtime-chat

A proof-of-concept realtime chat app: an [Expo](https://expo.dev) (React Native) client backed by [Supabase](https://supabase.com) for auth, Postgres, and realtime messaging.

## Repo layout

```
.
├── chat-poc/          # Expo (React Native) client
├── supabase/          # Backend-as-code: config, migrations, RLS, realtime auth
├── docs/              # Project documentation
└── README.md
```

## Getting started

You'll need [Docker Desktop](https://www.docker.com/products/docker-desktop), the [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started), and Node ≥ 20.

```bash
# 1. Bring up the local Supabase stack
supabase start
supabase db reset

# 2. Configure the app
cp chat-poc/.env.example chat-poc/.env
# fill in EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY
# from `supabase status`

# 3. Run the Expo client
cd chat-poc
npm install
npm run start
```

For the full setup walkthrough — including linking to your own cloud Supabase project, day-2 workflows (new migrations, type generation, dashboard drift capture), and troubleshooting — see [`docs/SUPABASE.md`](docs/SUPABASE.md).

## Documentation

- [`docs/SUPABASE.md`](docs/SUPABASE.md) — Supabase setup, migrations workflow, troubleshooting
- [`chat-poc/README.md`](chat-poc/README.md) — Expo app specifics
