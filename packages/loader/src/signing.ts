// Ed25519 signatures with WebCrypto (browsers and Node 24). The user imports the public keys they trust; there is no central authority.
import { MeshError } from '@ateliermesh/core'

export interface TrustedKey {
  /** A name the user gave the key, shown in the approval dialog. */
  name: string
  /** The 32-byte public key, base64. */
  publicKey: string
}

const b64 = (bytes: Uint8Array): string => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s) }
const unb64 = (text: string): Uint8Array => { const s = atob(text.trim()); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out }
const subtle = (): SubtleCrypto => { const s = globalThis.crypto?.subtle; if (!s) throw new MeshError('loader.no_webcrypto'); return s }
const buf = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer

export async function generateKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
  const kp = await subtle().generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair
  const pub = new Uint8Array(await subtle().exportKey('raw', kp.publicKey))
  const priv = new Uint8Array(await subtle().exportKey('pkcs8', kp.privateKey))
  return { publicKey: b64(pub), privateKey: b64(priv) }
}

export async function sign(privateKey: string, data: Uint8Array): Promise<string> {
  const key = await subtle().importKey('pkcs8', buf(unb64(privateKey)), 'Ed25519', false, ['sign'])
  return b64(new Uint8Array(await subtle().sign('Ed25519', key, buf(data))))
}

/** The name of the first trusted key that made this signature, or null. */
export async function verifyWithAny(keys: TrustedKey[], signature: string, data: Uint8Array): Promise<string | null> {
  const sig = unb64(signature)
  for (const k of keys) {
    try {
      const key = await subtle().importKey('raw', buf(unb64(k.publicKey)), 'Ed25519', false, ['verify'])
      if (await subtle().verify('Ed25519', key, buf(sig), buf(data))) return k.name
    } catch { /* a bad key or signature never verifies */ }
  }
  return null
}
