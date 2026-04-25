# secure-chat

End-to-end encrypted chat for two people. Built with Next.js, Supabase, and libsodium.

- Real-time messages via Supabase Postgres realtime
- Files encrypted client-side, uploaded to Supabase Storage
- Per-message auto-delete timer (Off / 1 min / 1 hour / 1 day / 7 days)
- Server only ever sees ciphertext — your password and plaintext never leave the browser

## How the encryption works

1. On signup, the browser generates a `crypto_box` keypair via libsodium.
2. The secret key is wrapped with `secretbox` using a key derived from your password (`crypto_pwhash`, Argon2id) and stored on the server in wrapped form.
3. When you log in, the secret key is unwrapped locally with your password.
4. Both clients independently derive the same shared symmetric key from their own secret + the other's public (`crypto_box_beforenm`).
5. Every message and file is encrypted with `secretbox` using that shared key.

The server (Supabase) sees only: who sent to whom, when, ciphertext, nonces, and ciphertext file blobs. It cannot read messages or files.

## Setup

### 1. Create a Supabase project
1. Sign up at [supabase.com](https://supabase.com), create a new project (free tier is fine).
2. In **Authentication → Providers → Email**, turn off "Confirm email" (faster for a 2-person app — re-enable later if you want).
3. In **Database → Extensions**, enable `pg_cron` (needed for server-side auto-delete).
4. Open **SQL Editor → New query**, paste the contents of `supabase/schema.sql`, and run.

### 2. Wire up the app
```bash
cp .env.local.example .env.local
```
Fill in `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` from **Project Settings → API**.

### 3. Run locally
```bash
npm install
npm run dev
```
Open http://localhost:3000 and sign up. Have the other person sign up too — the app pairs the first two accounts automatically.

### 4. Deploy

The whole app is a static Next.js site:

```bash
npm i -g vercel
vercel deploy
```

Add the same two `NEXT_PUBLIC_*` env vars in the Vercel dashboard. You'll get a URL like `your-app.vercel.app` — share it with the other person, sign up, chat.

## Security caveats

- This is a hobby-grade scaffold, not an audited messenger. Don't use it for adversarial threat models.
- Anyone with database access can see message metadata (sender, recipient, timestamps, sizes).
- The wrapped secret key is only as strong as the password used to derive its wrapping key. Use a long passphrase.
- The "auto-delete" feature deletes server rows + storage objects, but the recipient's browser may still have a decrypted copy in memory until they close the tab.
- There is no forward secrecy — a compromised secret key can decrypt all past ciphertexts. Adding a Double Ratchet (à la Signal) is the obvious upgrade.
- Storing the password in `sessionStorage` for the tab's lifetime is a usability concession; clearing it on every navigation would force constant re-prompting.

## Project layout

```
app/
  layout.tsx        root layout
  page.tsx          redirects to /chat
  login/page.tsx    sign in / sign up
  chat/
    page.tsx        server entry (just renders ChatClient)
    ChatClient.tsx  the actual UI: realtime, send, files, TTL
lib/
  crypto.ts         libsodium wrappers
  supabase.ts       Supabase browser client
supabase/
  schema.sql        run once in the SQL editor
```
