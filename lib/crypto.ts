"use client";

import sodium from "libsodium-wrappers";

let ready: Promise<void> | null = null;
export function sodiumReady() {
    if (!ready) ready = sodium.ready;
    return ready;
}

const b64 = (bytes: Uint8Array) =>
    sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
const fromB64 = (s: string) =>
    sodium.from_base64(s, sodium.base64_variants.ORIGINAL);

export type WrappedKeypair = {
    public_key: string;
    wrapped_secret: string;
    wrap_salt: string;
    wrap_nonce: string;
};

// Generate a new box keypair, wrap the secret with a password-derived key.
// The wrapped form can be stored on the server safely — the password never leaves
// the client.
//
// Wrap uses Web Crypto (PBKDF2-SHA256 200k → AES-GCM-256) instead of libsodium
// pwhash because the standard `libsodium-wrappers` build doesn't reliably expose
// the pwhash constants in browsers.
export async function createWrappedKeypair(password: string): Promise<WrappedKeypair> {
    await sodiumReady();
    const kp = sodium.crypto_box_keypair();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const wrapKey = await deriveWrapKey(password, salt);
    const wrapped = new Uint8Array(
        await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wrapKey, kp.privateKey as BufferSource),
    );
    return {
        public_key: b64(kp.publicKey),
        wrapped_secret: b64(wrapped),
        wrap_salt: b64(salt),
        wrap_nonce: b64(iv),
    };
}

async function deriveWrapKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
    const baseKey = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(password),
        "PBKDF2",
        false,
        ["deriveKey"],
    );
    return crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: salt as BufferSource, iterations: 200_000, hash: "SHA-256" },
        baseKey,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
    );
}

// Recover the secret key from its wrapped form using the password.
export async function unwrapSecretKey(
    w: WrappedKeypair,
    password: string,
): Promise<Uint8Array> {
    await sodiumReady();
    const salt = fromB64(w.wrap_salt);
    const iv = fromB64(w.wrap_nonce);
    const wrapKey = await deriveWrapKey(password, salt);
    const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv as BufferSource },
        wrapKey,
        fromB64(w.wrapped_secret) as BufferSource,
    );
    return new Uint8Array(pt);
}

// Pre-compute the shared symmetric key between two box keypairs. Both ends
// derive the same 32-byte key, so we can use simple secretbox for messages.
export async function deriveSharedKey(
    mySecret: Uint8Array,
    theirPublicB64: string,
): Promise<Uint8Array> {
    await sodiumReady();
    return sodium.crypto_box_beforenm(fromB64(theirPublicB64), mySecret);
}

export type SealedPayload = { ciphertext: string; nonce: string };

export async function encryptText(text: string, sharedKey: Uint8Array): Promise<SealedPayload> {
    await sodiumReady();
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const ct = sodium.crypto_secretbox_easy(
        sodium.from_string(text),
        nonce,
        sharedKey,
    );
    return { ciphertext: b64(ct), nonce: b64(nonce) };
}

export async function decryptText(p: SealedPayload, sharedKey: Uint8Array): Promise<string> {
    await sodiumReady();
    const pt = sodium.crypto_secretbox_open_easy(
        fromB64(p.ciphertext),
        fromB64(p.nonce),
        sharedKey,
    );
    return sodium.to_string(pt);
}

export type SealedFile = {
    blob: Blob;             // ciphertext to upload to storage
    nonce: string;          // base64
    metaCiphertext: string; // base64 (encrypted JSON {name, type, size})
    metaNonce: string;      // base64
};

export async function encryptFile(file: File, sharedKey: Uint8Array): Promise<SealedFile> {
    await sodiumReady();
    const buf = new Uint8Array(await file.arrayBuffer());
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const ct = sodium.crypto_secretbox_easy(buf, nonce, sharedKey);

    const meta = JSON.stringify({ name: file.name, type: file.type, size: file.size });
    const metaNonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const metaCt = sodium.crypto_secretbox_easy(
        sodium.from_string(meta),
        metaNonce,
        sharedKey,
    );

    return {
        blob: new Blob([ct as BlobPart], { type: "application/octet-stream" }),
        nonce: b64(nonce),
        metaCiphertext: b64(metaCt),
        metaNonce: b64(metaNonce),
    };
}

export async function decryptFile(
    bytes: Uint8Array,
    nonceB64: string,
    sharedKey: Uint8Array,
): Promise<Uint8Array> {
    await sodiumReady();
    return sodium.crypto_secretbox_open_easy(bytes, fromB64(nonceB64), sharedKey);
}

export type FileMeta = { name: string; type: string; size: number };

export async function decryptFileMeta(
    metaCipherB64: string,
    metaNonceB64: string,
    sharedKey: Uint8Array,
): Promise<FileMeta> {
    await sodiumReady();
    const pt = sodium.crypto_secretbox_open_easy(
        fromB64(metaCipherB64),
        fromB64(metaNonceB64),
        sharedKey,
    );
    return JSON.parse(sodium.to_string(pt));
}
