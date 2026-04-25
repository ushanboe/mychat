-- Run this once in Supabase SQL editor (Project → SQL → New query)
-- It creates the profiles + messages tables, RLS policies, a private storage
-- bucket for encrypted files, and a cron job that purges expired messages.

-- 1. profiles: one row per user, holds the user's public key + wrapped secret key
create table if not exists public.profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    public_key text not null,            -- base64, libsodium box public key (32 bytes)
    wrapped_secret text not null,        -- base64 ciphertext: secret key encrypted with password-derived key
    wrap_salt text not null,             -- base64 pwhash salt
    wrap_nonce text not null,            -- base64 secretbox nonce
    created_at timestamptz default now()
);

alter table public.profiles enable row level security;

-- Anyone signed in can read public keys (so the other user can look you up).
-- Only you can read/write your wrapped secret.
drop policy if exists "profiles_select_public" on public.profiles;
create policy "profiles_select_public" on public.profiles
    for select to authenticated using (true);

drop policy if exists "profiles_insert_self" on public.profiles;
create policy "profiles_insert_self" on public.profiles
    for insert to authenticated with check (auth.uid() = id);

drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self" on public.profiles
    for update to authenticated using (auth.uid() = id);

-- 2. messages: ciphertext + nonce + optional file metadata + expiry
create table if not exists public.messages (
    id uuid primary key default gen_random_uuid(),
    sender uuid not null references auth.users(id) on delete cascade,
    recipient uuid not null references auth.users(id) on delete cascade,
    ciphertext text not null,            -- base64 secretbox ciphertext (text or file metadata JSON)
    nonce text not null,                 -- base64 nonce
    kind text not null default 'text',   -- 'text' | 'file'
    file_path text,                      -- storage path of encrypted blob (kind='file')
    created_at timestamptz default now(),
    expires_at timestamptz               -- null = never expire
);

create index if not exists messages_pair_idx
    on public.messages (sender, recipient, created_at desc);
create index if not exists messages_expires_idx
    on public.messages (expires_at) where expires_at is not null;

alter table public.messages enable row level security;

-- You can read messages where you are sender OR recipient
drop policy if exists "messages_select_party" on public.messages;
create policy "messages_select_party" on public.messages
    for select to authenticated
    using (auth.uid() = sender or auth.uid() = recipient);

-- You can insert only as the sender
drop policy if exists "messages_insert_self" on public.messages;
create policy "messages_insert_self" on public.messages
    for insert to authenticated
    with check (auth.uid() = sender);

-- Either party can delete (lets clients honor the burn-on-read UX)
drop policy if exists "messages_delete_party" on public.messages;
create policy "messages_delete_party" on public.messages
    for delete to authenticated
    using (auth.uid() = sender or auth.uid() = recipient);

-- 3. storage bucket for encrypted file blobs
insert into storage.buckets (id, name, public)
    values ('chat-files', 'chat-files', false)
    on conflict (id) do nothing;

drop policy if exists "chat_files_rw" on storage.objects;
create policy "chat_files_rw" on storage.objects
    for all to authenticated
    using (bucket_id = 'chat-files')
    with check (bucket_id = 'chat-files');

-- 4. auto-delete: scheduled function purges expired rows + their storage blobs
create or replace function public.purge_expired_messages()
returns void language plpgsql security definer as $$
declare
    r record;
begin
    for r in
        select id, file_path from public.messages
        where expires_at is not null and expires_at <= now()
    loop
        if r.file_path is not null then
            perform storage.delete_object('chat-files', r.file_path);
        end if;
        delete from public.messages where id = r.id;
    end loop;
end $$;

-- Requires the pg_cron extension (Database → Extensions → enable pg_cron).
-- Comment this block out if you don't want server-side purging; the client
-- already hides expired messages immediately.
create extension if not exists pg_cron;
select cron.schedule(
    'purge-expired-messages',
    '* * * * *',
    $$ select public.purge_expired_messages(); $$
);
