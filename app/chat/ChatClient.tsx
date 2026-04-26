"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase";
import {
    createWrappedKeypair,
    decryptFile,
    decryptFileMeta,
    decryptText,
    deriveSharedKey,
    encryptFile,
    encryptText,
    type FileMeta,
    sodiumReady,
    unwrapSecretKey,
} from "@/lib/crypto";

type DbMessage = {
    id: string;
    sender: string;
    recipient: string;
    ciphertext: string;
    nonce: string;
    kind: "text" | "file";
    file_path: string | null;
    created_at: string;
    expires_at: string | null;
};

type DecryptedMessage = {
    id: string;
    mine: boolean;
    text?: string;
    file?: FileMeta & { path: string; fileNonce: string };
    createdAt: number;
    expiresAt: number | null;
};

const TTL_OPTIONS: { label: string; seconds: number | null }[] = [
    { label: "Off", seconds: null },
    { label: "1 min", seconds: 60 },
    { label: "1 hour", seconds: 60 * 60 },
    { label: "1 day", seconds: 60 * 60 * 24 },
    { label: "7 days", seconds: 60 * 60 * 24 * 7 },
];

// Translation runs entirely on-device via Transformers.js loading our
// quantized Helsinki-NLP Opus-MT models from /public/models/. Plaintext
// never leaves the browser. Each direction is ~131 MB on first use, then
// cached in IndexedDB by the runtime.
const TRANSLATE_OPTIONS: { label: string; code: string | null }[] = [
    { label: "Off", code: null },
    { label: "→ English", code: "en" },
    { label: "→ Filipino", code: "fil" },
];
// target language -> model id under /public/models/
const TRANSLATE_MODELS: Record<string, string> = {
    en: "opus-mt-tl-en",
    fil: "opus-mt-en-tl",
};
type TranslationPipe = (text: string, opts?: Record<string, unknown>) => Promise<Array<{ translation_text: string }>>;

export default function ChatClient() {
    const router = useRouter();
    const [phase, setPhase] = useState<"loading" | "needs-password" | "ready" | "no-peer">("loading");
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const [me, setMe] = useState<string | null>(null);
    const [peerId, setPeerId] = useState<string | null>(null);
    const [peerEmail, setPeerEmail] = useState<string | null>(null);
    const [peerLastSeen, setPeerLastSeen] = useState<number | null>(null);
    const [messages, setMessages] = useState<DecryptedMessage[]>([]);
    const [input, setInput] = useState("");
    const [ttlSeconds, setTtlSeconds] = useState<number | null>(null);
    const [pwPrompt, setPwPrompt] = useState("");
    const [now, setNow] = useState(Date.now());
    const [translateTo, setTranslateTo] = useState<string | null>(null);
    const [translations, setTranslations] = useState<Record<string, string>>({});
    const [translatorState, setTranslatorState] = useState<"idle" | "loading" | "ready" | "error">("idle");
    const [loadProgress, setLoadProgress] = useState<number | null>(null);
    const sharedKeyRef = useRef<Uint8Array | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const scrollerRef = useRef<HTMLDivElement | null>(null);
    const translatorsRef = useRef<Map<string, TranslationPipe>>(new Map());

    // Tick once a second so TTL countdowns + auto-hide work without a re-render storm.
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, []);

    // Restore the user's last translation preference.
    useEffect(() => {
        const stored = localStorage.getItem("mychat_translate_to");
        if (stored) setTranslateTo(stored);
    }, []);

    useEffect(() => {
        if (translateTo) localStorage.setItem("mychat_translate_to", translateTo);
        else localStorage.removeItem("mychat_translate_to");
    }, [translateTo]);

    // Translate any new peer messages into the user's preferred language using
    // an on-device Transformers.js pipeline. The model is fetched from
    // /public/models/ on first use (~131 MB) and cached in IndexedDB by the
    // runtime, so subsequent loads are instant. Plaintext never leaves the tab.
    useEffect(() => {
        if (!translateTo) { setTranslatorState("idle"); setLoadProgress(null); return; }
        const modelId = TRANSLATE_MODELS[translateTo];
        if (!modelId) return;
        const pending = messages.filter((m) => !m.mine && m.text && !(m.id in translations));
        if (pending.length === 0 && translatorsRef.current.has(modelId)) return;
        let cancelled = false;
        (async () => {
            let pipe = translatorsRef.current.get(modelId);
            if (!pipe) {
                try {
                    setTranslatorState("loading");
                    setLoadProgress(0);
                    const tjs = await import("@huggingface/transformers");
                    tjs.env.allowLocalModels = true;
                    tjs.env.allowRemoteModels = false;
                    tjs.env.localModelPath = "/models/";
                    pipe = (await tjs.pipeline("translation", modelId, {
                        dtype: "q8",
                        progress_callback: (p: { status?: string; progress?: number }) => {
                            if (cancelled) return;
                            if (p.status === "progress" && typeof p.progress === "number") {
                                setLoadProgress(Math.round(p.progress));
                            }
                        },
                    })) as unknown as TranslationPipe;
                    if (cancelled) return;
                    translatorsRef.current.set(modelId, pipe);
                    setTranslatorState("ready");
                    setLoadProgress(null);
                } catch (e) {
                    console.error("[translator] load failed:", e);
                    if (!cancelled) { setTranslatorState("error"); setLoadProgress(null); }
                    return;
                }
            }
            const next: Record<string, string> = {};
            for (const m of pending) {
                if (cancelled) return;
                try {
                    const out = await pipe(m.text!, { max_new_tokens: 256 });
                    next[m.id] = out[0]?.translation_text ?? "";
                } catch { /* skip individual failures */ }
            }
            if (!cancelled && Object.keys(next).length) {
                setTranslations((prev) => ({ ...prev, ...next }));
            }
        })();
        return () => { cancelled = true; };
    }, [messages, translateTo, translations]);

    // Heartbeat: stamp our profile.last_seen_at every 25s while the chat is open
    // so the peer sees us as Online. On tab close the heartbeat stops and we drift
    // out to "Last seen X ago".
    useEffect(() => {
        if (phase !== "ready" || !me) return;
        const supabase = getSupabase();
        const beat = () =>
            supabase.from("profiles").update({ last_seen_at: new Date().toISOString() }).eq("id", me).then(() => {});
        beat();
        const id = setInterval(beat, 25_000);
        return () => clearInterval(id);
    }, [phase, me]);

    const decryptDbRow = useCallback(async (row: DbMessage, sharedKey: Uint8Array, myId: string): Promise<DecryptedMessage | null> => {
        try {
            const base = {
                id: row.id,
                mine: row.sender === myId,
                createdAt: new Date(row.created_at).getTime(),
                expiresAt: row.expires_at ? new Date(row.expires_at).getTime() : null,
            };
            if (row.kind === "text") {
                const text = await decryptText({ ciphertext: row.ciphertext, nonce: row.nonce }, sharedKey);
                return { ...base, text };
            }
            // file: ciphertext column carries encrypted JSON metadata; nonce decrypts it.
            // The encrypted blob lives in storage at row.file_path with a nonce stored
            // inside the metadata JSON.
            const metaRaw = await decryptText({ ciphertext: row.ciphertext, nonce: row.nonce }, sharedKey);
            const parsed = JSON.parse(metaRaw) as FileMeta & { fileNonce: string };
            return {
                ...base,
                file: {
                    name: parsed.name,
                    type: parsed.type,
                    size: parsed.size,
                    fileNonce: parsed.fileNonce,
                    path: row.file_path ?? "",
                },
            };
        } catch {
            return null;
        }
    }, []);

    const bootstrap = useCallback(async (password: string) => {
        const supabase = getSupabase();
        await sodiumReady();
        const { data: sess } = await supabase.auth.getUser();
        if (!sess.user) {
            router.replace("/login");
            return;
        }
        const myId = sess.user.id;
        setMe(myId);

        const { data: profiles, error: pErr } = await supabase
            .from("profiles")
            .select("id, public_key, wrapped_secret, wrap_salt, wrap_nonce, last_seen_at");
        if (pErr) throw pErr;

        let myProfile = profiles?.find((p) => p.id === myId);
        if (!myProfile) {
            // First sign-in after signup (or signup happened before a session was
            // active) — create the profile now that we are authenticated.
            const wrapped = await createWrappedKeypair(password);
            const { error: insErr } = await supabase.from("profiles").insert({
                id: myId,
                public_key: wrapped.public_key,
                wrapped_secret: wrapped.wrapped_secret,
                wrap_salt: wrapped.wrap_salt,
                wrap_nonce: wrapped.wrap_nonce,
            });
            if (insErr) throw insErr;
            myProfile = { id: myId, ...wrapped };
        }
        const peer = profiles?.find((p) => p.id !== myId);
        if (!peer) {
            setPhase("no-peer");
            return;
        }

        const mySecret = await unwrapSecretKey(
            {
                public_key: myProfile.public_key,
                wrapped_secret: myProfile.wrapped_secret,
                wrap_salt: myProfile.wrap_salt,
                wrap_nonce: myProfile.wrap_nonce,
            },
            password,
        );
        const sharedKey = await deriveSharedKey(mySecret, peer.public_key);
        sharedKeyRef.current = sharedKey;
        setPeerId(peer.id);

        // Look up peer's email via a Supabase Edge fn? Simpler: skip — we only know their id.
        // We'll show a short id label.
        setPeerEmail(peer.id.slice(0, 8));
        if (peer.last_seen_at) setPeerLastSeen(new Date(peer.last_seen_at).getTime());

        const { data: rows } = await supabase
            .from("messages")
            .select("*")
            .order("created_at", { ascending: true })
            .limit(500);
        const decrypted: DecryptedMessage[] = [];
        for (const r of (rows ?? []) as DbMessage[]) {
            const m = await decryptDbRow(r, sharedKey, myId);
            if (m) decrypted.push(m);
        }
        setMessages(decrypted);

        const channel = supabase
            .channel("messages-stream")
            .on(
                "postgres_changes",
                { event: "INSERT", schema: "public", table: "messages" },
                async (payload) => {
                    const row = payload.new as DbMessage;
                    const m = await decryptDbRow(row, sharedKey, myId);
                    if (m) setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
                },
            )
            .on(
                "postgres_changes",
                { event: "DELETE", schema: "public", table: "messages" },
                (payload) => {
                    const id = (payload.old as { id?: string }).id;
                    if (id) setMessages((prev) => prev.filter((m) => m.id !== id));
                },
            )
            .on(
                "postgres_changes",
                { event: "UPDATE", schema: "public", table: "profiles", filter: `id=eq.${peer.id}` },
                (payload) => {
                    const row = payload.new as { last_seen_at?: string };
                    if (row.last_seen_at) setPeerLastSeen(new Date(row.last_seen_at).getTime());
                },
            )
            .subscribe();

        setPhase("ready");
        return () => {
            supabase.removeChannel(channel);
        };
    }, [decryptDbRow, router]);

    useEffect(() => {
        let cleanup: (() => void) | undefined;
        (async () => {
            try {
                const supabase = getSupabase();
                const { data } = await supabase.auth.getUser();
                if (!data.user) {
                    router.replace("/login");
                    return;
                }
                const cached = sessionStorage.getItem("sc_pw");
                if (!cached) {
                    setPhase("needs-password");
                    return;
                }
                const cleanupMaybe = await bootstrap(cached);
                if (typeof cleanupMaybe === "function") cleanup = cleanupMaybe;
            } catch (err: unknown) {
                console.error("[bootstrap] failed:", err);
                const msg = err instanceof Error
                    ? `${err.name}: ${err.message}`
                    : (typeof err === "object" && err !== null
                        ? JSON.stringify(err)
                        : String(err));
                setErrorMsg(msg || "Unknown error — see browser console for details.");
            }
        })();
        return () => { cleanup?.(); };
    }, [bootstrap, router]);

    // Scroll to bottom on new messages.
    useEffect(() => {
        scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight, behavior: "smooth" });
    }, [messages.length]);

    // Locally hide messages whose timer has already elapsed; also fire a server-side
    // delete so the row is gone for the other party even if they're offline.
    useEffect(() => {
        const expired = messages.filter((m) => m.expiresAt && m.expiresAt <= now);
        if (expired.length === 0) return;
        const supabase = getSupabase();
        for (const m of expired) {
            supabase.from("messages").delete().eq("id", m.id).then(() => {});
        }
        setMessages((prev) => prev.filter((m) => !m.expiresAt || m.expiresAt > now));
    }, [now, messages]);

    async function handleUnlock(e: React.FormEvent) {
        e.preventDefault();
        try {
            await bootstrap(pwPrompt);
            sessionStorage.setItem("sc_pw", pwPrompt);
            setPwPrompt("");
        } catch (err: unknown) {
            console.error("[unlock] bootstrap failed:", err);
            const msg = err instanceof Error
                ? `${err.name}: ${err.message}`
                : (typeof err === "object" && err !== null
                    ? JSON.stringify(err)
                    : String(err));
            setErrorMsg(msg || "Unknown error — see browser console for details.");
        }
    }

    async function sendText() {
        if (!input.trim() || !sharedKeyRef.current || !me || !peerId) return;
        const supabase = getSupabase();
        const { ciphertext, nonce } = await encryptText(input, sharedKeyRef.current);
        const expires_at = ttlSeconds
            ? new Date(Date.now() + ttlSeconds * 1000).toISOString()
            : null;
        setInput("");
        const { error } = await supabase.from("messages").insert({
            sender: me,
            recipient: peerId,
            ciphertext,
            nonce,
            kind: "text",
            expires_at,
        });
        if (error) setErrorMsg(error.message);
    }

    async function sendFile(file: File) {
        if (!sharedKeyRef.current || !me || !peerId) return;
        const supabase = getSupabase();
        const sealed = await encryptFile(file, sharedKeyRef.current);
        const path = `${me}/${crypto.randomUUID()}`;
        const { error: upErr } = await supabase.storage.from("chat-files").upload(path, sealed.blob);
        if (upErr) { setErrorMsg(upErr.message); return; }

        // We piggyback file metadata + the file's nonce on the message ciphertext column.
        const meta = JSON.stringify({
            name: file.name,
            type: file.type,
            size: file.size,
            fileNonce: sealed.nonce,
        });
        const { ciphertext, nonce } = await encryptText(meta, sharedKeyRef.current);
        const expires_at = ttlSeconds
            ? new Date(Date.now() + ttlSeconds * 1000).toISOString()
            : null;
        const { error } = await supabase.from("messages").insert({
            sender: me,
            recipient: peerId,
            ciphertext,
            nonce,
            kind: "file",
            file_path: path,
            expires_at,
        });
        if (error) setErrorMsg(error.message);
    }

    async function downloadFile(m: DecryptedMessage) {
        if (!m.file || !sharedKeyRef.current) return;
        const supabase = getSupabase();
        const { data, error } = await supabase.storage.from("chat-files").download(m.file.path);
        if (error || !data) { setErrorMsg(error?.message ?? "download failed"); return; }
        const ct = new Uint8Array(await data.arrayBuffer());
        const pt = await decryptFile(ct, m.file.fileNonce, sharedKeyRef.current);
        const url = URL.createObjectURL(new Blob([pt as BlobPart], { type: m.file.type || "application/octet-stream" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = m.file.name;
        a.click();
        URL.revokeObjectURL(url);
    }

    async function signOut() {
        sessionStorage.removeItem("sc_pw");
        await getSupabase().auth.signOut();
        router.replace("/login");
    }

    if (phase === "loading") {
        return (
            <Center>
                <div className="text-center space-y-3">
                    <p>Loading…</p>
                    {errorMsg && (
                        <div className="bg-red-950 border border-red-800 text-red-200 p-4 rounded-lg max-w-md text-sm">
                            <p className="font-semibold mb-1">Error</p>
                            <p className="break-words">{errorMsg}</p>
                            <button
                                onClick={signOut}
                                className="mt-3 underline text-red-100"
                            >Sign out and try again</button>
                        </div>
                    )}
                </div>
            </Center>
        );
    }
    if (phase === "needs-password") {
        return (
            <Center>
                <form onSubmit={handleUnlock} className="space-y-3 bg-neutral-900 p-6 rounded-2xl w-full max-w-sm">
                    <h2 className="text-lg font-semibold">Unlock your key</h2>
                    <p className="text-sm text-neutral-400">Re-enter your password to decrypt your secret key for this session.</p>
                    <input
                        type="password"
                        autoFocus
                        value={pwPrompt}
                        onChange={(e) => setPwPrompt(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg bg-neutral-800 outline-none focus:ring-2 ring-blue-500"
                    />
                    {errorMsg && (
                        <div className="text-sm text-red-300 bg-red-950/40 border border-red-900 p-2 rounded break-words">
                            {errorMsg}
                        </div>
                    )}
                    <button className="w-full py-2 rounded-lg bg-blue-600 hover:bg-blue-500">Unlock</button>
                    <button
                        type="button"
                        onClick={signOut}
                        className="w-full text-xs text-neutral-500 hover:text-neutral-300"
                    >Sign out and start over</button>
                </form>
            </Center>
        );
    }
    if (phase === "no-peer") {
        return (
            <Center>
                <div className="bg-neutral-900 p-6 rounded-2xl max-w-sm space-y-2">
                    <h2 className="text-lg font-semibold">Waiting for your partner</h2>
                    <p className="text-sm text-neutral-400">
                        This app pairs with the next signed-up account. Have the other person create an
                        account, then refresh.
                    </p>
                    <button onClick={signOut} className="text-sm underline text-neutral-300">Sign out</button>
                </div>
            </Center>
        );
    }

    const peerOnline = peerLastSeen !== null && now - peerLastSeen < 60_000;
    const peerStatus = peerOnline
        ? "Online"
        : peerLastSeen
            ? `Offline · last seen ${formatLastSeen(peerLastSeen, now)}`
            : "Unavailable";

    return (
        <main className="flex flex-col h-[100dvh]">
            <header className="flex-shrink-0 flex items-center justify-between px-3 py-2 border-b border-neutral-800 gap-2">
                <div className="min-w-0">
                    <div className="font-medium truncate">{peerEmail}</div>
                    <div className="flex items-center gap-1.5 text-xs">
                        <span className={`inline-block w-2 h-2 rounded-full ${peerOnline ? "bg-green-500" : "bg-neutral-600"}`} />
                        <span className="text-neutral-400 truncate">{peerStatus}</span>
                    </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                    <select
                        value={translateTo ?? ""}
                        onChange={(e) => setTranslateTo(e.target.value || null)}
                        title="Translate incoming messages on-device (Chrome 138+)"
                        className="bg-neutral-800 text-xs rounded-lg px-2 py-1"
                    >
                        {TRANSLATE_OPTIONS.map((o) => (
                            <option key={o.label} value={o.code ?? ""}>🌐 {o.label}</option>
                        ))}
                    </select>
                    <select
                        value={ttlSeconds ?? ""}
                        onChange={(e) => setTtlSeconds(e.target.value === "" ? null : Number(e.target.value))}
                        title="Auto-delete messages after"
                        className="bg-neutral-800 text-xs rounded-lg px-2 py-1"
                    >
                        {TTL_OPTIONS.map((o) => (
                            <option key={o.label} value={o.seconds ?? ""}>⏱ {o.label}</option>
                        ))}
                    </select>
                    <button onClick={signOut} className="text-xs text-neutral-400 hover:text-neutral-100">Sign out</button>
                </div>
            </header>
            {translateTo && translatorState === "loading" && (
                <div className="flex-shrink-0 text-[11px] text-blue-200 bg-blue-950/40 border-b border-blue-900 px-3 py-1">
                    Loading translation model{loadProgress !== null ? ` (${loadProgress}%)` : ""}… first time downloads ~131&nbsp;MB, then cached.
                </div>
            )}
            {translateTo && translatorState === "error" && (
                <div className="flex-shrink-0 text-[11px] text-amber-300 bg-amber-950/40 border-b border-amber-900 px-3 py-1">
                    Translation model failed to load. Check the browser console, or set translation to Off.
                </div>
            )}

            <div ref={scrollerRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
                {messages.map((m, i) => {
                    const prev = messages[i - 1];
                    const showDay = !prev || !sameDay(prev.createdAt, m.createdAt);
                    return (
                        <Fragment key={m.id}>
                            {showDay && <DaySeparator timestamp={m.createdAt} />}
                            <Bubble m={m} now={now} translation={translations[m.id]} onDownload={() => downloadFile(m)} />
                        </Fragment>
                    );
                })}
                {errorMsg && <p className="text-sm text-red-400">{errorMsg}</p>}
            </div>

            <form
                onSubmit={(e) => { e.preventDefault(); void sendText(); }}
                className="flex-shrink-0 border-t border-neutral-800 p-2 flex items-center gap-2 pb-[max(env(safe-area-inset-bottom),0.5rem)]"
            >
                <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="px-3 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 flex-shrink-0"
                    title="Attach file"
                >📎</button>
                <input
                    ref={fileInputRef}
                    type="file"
                    className="hidden"
                    onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void sendFile(f);
                        e.target.value = "";
                    }}
                />
                <input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Type a message 😊"
                    className="min-w-0 flex-1 px-3 py-2 rounded-lg bg-neutral-800 outline-none focus:ring-2 ring-blue-500"
                />
                <button className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 flex-shrink-0">Send</button>
            </form>
        </main>
    );
}

function Bubble({ m, now, translation, onDownload }: { m: DecryptedMessage; now: number; translation?: string; onDownload: () => void }) {
    const align = m.mine ? "justify-end" : "justify-start";
    const bg = m.mine ? "bg-blue-600" : "bg-neutral-800";
    const ttl = m.expiresAt ? Math.max(0, Math.floor((m.expiresAt - now) / 1000)) : null;
    return (
        <div className={`flex ${align}`}>
            <div className={`max-w-[75%] ${bg} px-3 py-2 rounded-2xl`}>
                {m.text && <div className="whitespace-pre-wrap break-words">{m.text}</div>}
                {translation && (
                    <div className="mt-1 pt-1 border-t border-white/10 text-xs italic opacity-80 whitespace-pre-wrap break-words">
                        🌐 {translation}
                    </div>
                )}
                {m.file && (
                    <button onClick={onDownload} className="flex items-center gap-2 underline">
                        📄 {m.file.name}
                        <span className="text-xs opacity-70">({Math.round(m.file.size / 1024)} KB)</span>
                    </button>
                )}
                <div className="flex items-center justify-end gap-2 mt-1 text-[10px] opacity-70">
                    {ttl !== null && <span>disappears in {formatTtl(ttl)}</span>}
                    <span>{formatTime(m.createdAt)}</span>
                </div>
            </div>
        </div>
    );
}

function DaySeparator({ timestamp }: { timestamp: number }) {
    return (
        <div className="flex items-center justify-center my-3">
            <span className="text-[11px] uppercase tracking-wider text-neutral-500 bg-neutral-900 px-2 py-1 rounded-full">
                {formatDay(timestamp)}
            </span>
        </div>
    );
}

function formatTtl(s: number) {
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
}

function formatTime(ts: number) {
    return new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function formatDay(ts: number) {
    const d = new Date(ts);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (sameDay(d.getTime(), today.getTime())) return "Today";
    if (sameDay(d.getTime(), yesterday.getTime())) return "Yesterday";
    return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

function sameDay(a: number, b: number) {
    const da = new Date(a);
    const db = new Date(b);
    return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

function formatRelative(ms: number) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    const d = Math.floor(h / 24);
    return `${d}d`;
}

// Status text uses an absolute date/time after a few minutes so the user has
// concrete context (vs. a vague "3h ago"). Within the first minute we still
// show seconds so they see the heartbeat lapse in real time.
function formatLastSeen(ts: number, now: number) {
    const ms = now - ts;
    if (ms < 60_000) return `${Math.max(0, Math.floor(ms / 1000))}s ago`;
    if (ms < 5 * 60_000) return `${Math.floor(ms / 60_000)}m ago`;
    const d = new Date(ts);
    const today = new Date(now);
    const yesterday = new Date(now);
    yesterday.setDate(today.getDate() - 1);
    const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    if (sameDay(ts, today.getTime())) return `today at ${time}`;
    if (sameDay(ts, yesterday.getTime())) return `yesterday at ${time}`;
    const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return `${date} at ${time}`;
}

function Center({ children }: { children: React.ReactNode }) {
    return <main className="min-h-[100dvh] flex items-center justify-center p-6">{children}</main>;
}
