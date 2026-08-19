import { fetchHeaders } from './headers.js'
// Node v22+ ships with built-in fetch & connection pooling — no external undici needed

function hdrs(slot) {
  const referer = slot.referer || `${slot.origin}/`
  return {
    ...fetchHeaders(referer),
    Origin: slot.referer ? new URL(referer).origin : slot.origin,
    Accept: '*/*',
  }
}

export async function pull(url, slot) {
  const headers = hdrs(slot)
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`upstream ${res.status}`)
  const arrayBuffer = await res.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

export async function pullStream(url, slot, signal) {
  const headers = hdrs(slot)
  // Removed hard 30s timeout so live streams don't randomly abort
  const res = await fetch(url, { headers, signal })
  if (!res.ok) throw new Error(`upstream ${res.status}`)
  return res
}
