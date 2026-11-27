// A small ZIP reader and writer for 3MF. The writer stores entries uncompressed (deterministic bytes, no library).
// The reader inflates with the platform's DecompressionStream and enforces limits against corrupt and hostile archives.
import { MeshError } from './errors'

export interface ZipEntry {
  name: string
  data: Uint8Array
}

let crcTable: Uint32Array | undefined
export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0 }
  }
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = (crcTable[(c ^ (data[i] as number)) & 0xff] as number) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const enc = new TextEncoder()

/** Store-only ZIP with a fixed timestamp, so the same input gives the same bytes. */
export function writeZip(entries: ZipEntry[]): Uint8Array {
  if (entries.length > 65534) throw new MeshError('export.too_large', { reason: 'too_many_entries' })
  const names = entries.map(e => enc.encode(e.name))
  let total = 22
  entries.forEach((e, i) => { total += 30 + (names[i] as Uint8Array).length + e.data.length + 46 + (names[i] as Uint8Array).length })
  if (total > 0xffffffff) throw new MeshError('export.too_large', { reason: 'over_4gb' })
  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  let p = 0
  const offsets: number[] = [], crcs: number[] = []
  entries.forEach((e, i) => {
    const nm = names[i] as Uint8Array, crc = crc32(e.data)
    offsets.push(p); crcs.push(crc)
    dv.setUint32(p, 0x04034b50, true); dv.setUint16(p + 4, 20, true); dv.setUint16(p + 6, 0x0800, true); dv.setUint16(p + 8, 0, true)
    dv.setUint16(p + 10, 0, true); dv.setUint16(p + 12, 0x21, true); dv.setUint32(p + 14, crc, true)
    dv.setUint32(p + 18, e.data.length, true); dv.setUint32(p + 22, e.data.length, true); dv.setUint16(p + 26, nm.length, true); dv.setUint16(p + 28, 0, true)
    out.set(nm, p + 30); out.set(e.data, p + 30 + nm.length)
    p += 30 + nm.length + e.data.length
  })
  const cdStart = p
  entries.forEach((e, i) => {
    const nm = names[i] as Uint8Array
    dv.setUint32(p, 0x02014b50, true); dv.setUint16(p + 4, 20, true); dv.setUint16(p + 6, 20, true); dv.setUint16(p + 8, 0x0800, true); dv.setUint16(p + 10, 0, true)
    dv.setUint16(p + 12, 0, true); dv.setUint16(p + 14, 0x21, true); dv.setUint32(p + 16, crcs[i] as number, true)
    dv.setUint32(p + 20, e.data.length, true); dv.setUint32(p + 24, e.data.length, true); dv.setUint16(p + 28, nm.length, true)
    dv.setUint32(p + 42, offsets[i] as number, true)
    out.set(nm, p + 46)
    p += 46 + nm.length
  })
  dv.setUint32(p, 0x06054b50, true); dv.setUint16(p + 8, entries.length, true); dv.setUint16(p + 10, entries.length, true)
  dv.setUint32(p + 12, p - cdStart, true); dv.setUint32(p + 16, cdStart, true)
  return out
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate-raw')
  const w = cs.writable.getWriter()
  void w.write(data as Uint8Array<ArrayBuffer>).then(() => w.close())
  const chunks: Uint8Array[] = []
  let n = 0
  const rd = cs.readable.getReader()
  for (;;) { const { value, done } = await rd.read(); if (done) break; chunks.push(value as Uint8Array); n += (value as Uint8Array).length }
  const out = new Uint8Array(n)
  let p = 0
  for (const c of chunks) { out.set(c, p); p += c.length }
  return out
}

/**
 * Like `writeZip`, but every entry is deflated (method 8), the way PrusaSlicer and most 3MF writers do it. The same input gives the same bytes on the same
 * platform. An entry that does not get smaller is stored. Needs `CompressionStream` (browsers, Node 18+).
 */
export async function writeZipDeflated(entries: ZipEntry[]): Promise<Uint8Array> {
  if (entries.length > 65534) throw new MeshError('export.too_large', { reason: 'too_many_entries' })
  const names = entries.map(e => enc.encode(e.name))
  const packed = await Promise.all(entries.map(async e => { const d = e.data.length > 64 ? await deflateRaw(e.data) : e.data; return d.length < e.data.length ? { d, method: 8 } : { d: e.data, method: 0 } }))
  let total = 22
  entries.forEach((_, i) => { total += 30 + (names[i] as Uint8Array).length + (packed[i] as { d: Uint8Array }).d.length + 46 + (names[i] as Uint8Array).length })
  if (total > 0xffffffff) throw new MeshError('export.too_large', { reason: 'over_4gb' })
  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  let p = 0
  const offsets: number[] = [], crcs: number[] = []
  entries.forEach((e, i) => {
    const nm = names[i] as Uint8Array, { d, method } = packed[i] as { d: Uint8Array; method: number }, crc = crc32(e.data)
    offsets.push(p); crcs.push(crc)
    dv.setUint32(p, 0x04034b50, true); dv.setUint16(p + 4, 20, true); dv.setUint16(p + 6, 0x0800, true); dv.setUint16(p + 8, method, true)
    dv.setUint16(p + 10, 0, true); dv.setUint16(p + 12, 0x21, true); dv.setUint32(p + 14, crc, true)
    dv.setUint32(p + 18, d.length, true); dv.setUint32(p + 22, e.data.length, true); dv.setUint16(p + 26, nm.length, true); dv.setUint16(p + 28, 0, true)
    out.set(nm, p + 30); out.set(d, p + 30 + nm.length)
    p += 30 + nm.length + d.length
  })
  const cdStart = p
  entries.forEach((e, i) => {
    const nm = names[i] as Uint8Array, { d, method } = packed[i] as { d: Uint8Array; method: number }
    dv.setUint32(p, 0x02014b50, true); dv.setUint16(p + 4, 20, true); dv.setUint16(p + 6, 20, true); dv.setUint16(p + 8, 0x0800, true); dv.setUint16(p + 10, method, true)
    dv.setUint16(p + 12, 0, true); dv.setUint16(p + 14, 0x21, true); dv.setUint32(p + 16, crcs[i] as number, true)
    dv.setUint32(p + 20, d.length, true); dv.setUint32(p + 24, e.data.length, true); dv.setUint16(p + 28, nm.length, true)
    dv.setUint32(p + 42, offsets[i] as number, true)
    out.set(nm, p + 46)
    p += 46 + nm.length
  })
  dv.setUint32(p, 0x06054b50, true); dv.setUint16(p + 8, entries.length, true); dv.setUint16(p + 10, entries.length, true)
  dv.setUint32(p + 12, p - cdStart, true); dv.setUint32(p + 16, cdStart, true)
  return out
}

export interface ZipLimits {
  maxEntries?: number
  /** Largest uncompressed size of one entry. */
  maxEntryBytes?: number
  /** Largest total uncompressed size of the entries read. */
  maxTotalBytes?: number
  /** Largest ratio of uncompressed to compressed size. */
  maxRatio?: number
}

export const DEFAULT_ZIP_LIMITS: Required<ZipLimits> = { maxEntries: 2000, maxEntryBytes: 512 * 1024 * 1024, maxTotalBytes: 1024 * 1024 * 1024, maxRatio: 2000 }

const bad = (reason: string, extra: Record<string, unknown> = {}): MeshError => new MeshError('import.invalid_zip', { reason, ...extra })

function safeName(name: string): boolean {
  if (name.length === 0 || name.length > 512) return false
  if (name.startsWith('/') || name.includes('\\') || name.includes('\0') || /^[a-zA-Z]:/.test(name)) return false
  return !name.split('/').some(seg => seg === '..')
}

async function inflateRaw(data: Uint8Array, expected: number): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw')
  const writer = ds.writable.getWriter()
  writer.write(data as unknown as Uint8Array<ArrayBuffer>).catch(() => undefined)
  writer.close().catch(() => undefined)
  const reader = ds.readable.getReader()
  const out = new Uint8Array(expected)
  let n = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (n + value.length > expected) throw bad('entry_larger_than_declared')
      out.set(value, n); n += value.length
    }
  } catch (e) {
    if (e instanceof MeshError) { await reader.cancel().catch(() => undefined); throw e }
    throw bad('corrupt_deflate_data')
  }
  if (n !== expected) throw bad('entry_smaller_than_declared')
  return out
}

/**
 * Read a ZIP. `filter` chooses which entries to inflate (others are skipped but still checked against the limits).
 * Refuses encryption, ZIP64, unsafe or duplicate names, wrong checksums, and entries that expand past their declared size.
 */
export async function readZip(bytes: Uint8Array, limits: ZipLimits = {}, filter: (name: string) => boolean = () => true): Promise<ZipEntry[]> {
  const L = { ...DEFAULT_ZIP_LIMITS, ...limits }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) throw bad('no_end_of_central_directory')
  const count = dv.getUint16(eocd + 10, true), cdSize = dv.getUint32(eocd + 12, true), cdOff = dv.getUint32(eocd + 16, true)
  if (count === 0xffff || cdOff === 0xffffffff) throw bad('zip64_not_supported')
  if (count > L.maxEntries) throw bad('too_many_entries', { count, max: L.maxEntries })
  if (cdOff + cdSize > eocd) throw bad('bad_central_directory')
  const dec = new TextDecoder('utf-8', { fatal: false })
  const seen = new Set<string>()
  const out: ZipEntry[] = []
  let p = cdOff, total = 0
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || dv.getUint32(p, true) !== 0x02014b50) throw bad('bad_central_directory_entry')
    const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true), crc = dv.getUint32(p + 16, true)
    const csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true)
    const nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lo = dv.getUint32(p + 42, true)
    if (p + 46 + nl > bytes.length) throw bad('bad_central_directory_entry')
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nl))
    p += 46 + nl + el + cl
    if (csize === 0xffffffff || usize === 0xffffffff || lo === 0xffffffff) throw bad('zip64_not_supported')
    if (flags & 1) throw bad('encrypted_entry', { name })
    if (name.endsWith('/')) continue
    if (!safeName(name)) throw bad('unsafe_name', { name })
    if (seen.has(name)) throw bad('duplicate_name', { name })
    seen.add(name)
    if (method !== 0 && method !== 8) throw bad('unsupported_method', { name, method })
    if (usize > L.maxEntryBytes) throw bad('entry_too_large', { name, size: usize, max: L.maxEntryBytes })
    if (csize > 0 && usize / csize > L.maxRatio) throw bad('compression_ratio_too_high', { name, ratio: Math.round(usize / csize) })
    total += usize
    if (total > L.maxTotalBytes) throw bad('archive_too_large', { max: L.maxTotalBytes })
    if (!filter(name)) continue
    if (lo + 30 > bytes.length || dv.getUint32(lo, true) !== 0x04034b50) throw bad('bad_local_header', { name })
    const start = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true)
    if (start + csize > bytes.length) throw bad('entry_past_end_of_file', { name })
    const raw = bytes.subarray(start, start + csize)
    const data = method === 0 ? raw.slice() : await inflateRaw(raw, usize)
    if (data.length !== usize) throw bad('size_mismatch', { name })
    if (crc32(data) !== crc) throw bad('checksum_mismatch', { name })
    out.push({ name, data })
  }
  return out
}
