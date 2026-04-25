"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase";

type Mode = "signin" | "signup";

export default function LoginPage() {
    const router = useRouter();
    const [mode, setMode] = useState<Mode>("signin");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    async function submit(e: React.FormEvent) {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        const supabase = getSupabase();
        try {
            if (mode === "signup") {
                const { data, error } = await supabase.auth.signUp({ email, password });
                if (error) throw error;
                if (!data.session) {
                    setErr("Account created. Check your email to confirm, then come back and sign in.");
                    return;
                }
            } else {
                const { error } = await supabase.auth.signInWithPassword({ email, password });
                if (error) throw error;
            }
            sessionStorage.setItem("sc_pw", password);
            router.replace("/chat");
        } catch (e: unknown) {
            setErr(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }

    return (
        <main className="min-h-screen flex items-center justify-center p-6">
            <form onSubmit={submit} className="w-full max-w-sm space-y-4 bg-neutral-900 p-6 rounded-2xl shadow-xl">
                <h1 className="text-xl font-semibold">
                    {mode === "signin" ? "Sign in" : "Create account"}
                </h1>
                <input
                    type="email"
                    required
                    placeholder="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-neutral-800 outline-none focus:ring-2 ring-blue-500"
                />
                <input
                    type="password"
                    required
                    placeholder="password (also unlocks your secret key)"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    minLength={8}
                    className="w-full px-3 py-2 rounded-lg bg-neutral-800 outline-none focus:ring-2 ring-blue-500"
                />
                {err && <p className="text-sm text-red-400">{err}</p>}
                <button
                    type="submit"
                    disabled={busy}
                    className="w-full py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50"
                >
                    {busy ? "…" : mode === "signin" ? "Sign in" : "Sign up"}
                </button>
                <button
                    type="button"
                    onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
                    className="w-full text-sm text-neutral-400 hover:text-neutral-200"
                >
                    {mode === "signin" ? "Need an account? Sign up" : "Already have an account? Sign in"}
                </button>
                <p className="text-xs text-neutral-500 leading-relaxed">
                    Your password unlocks a libsodium keypair stored encrypted on the server. The
                    server never sees your password or plaintext messages.
                </p>
            </form>
        </main>
    );
}
