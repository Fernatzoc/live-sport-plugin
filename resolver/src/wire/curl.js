import { fetchHeaders } from './headers.js'

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

export async function pullStream(url, slot) {
  const headers = hdrs(slot)
  // Increase timeout for streaming to 30s
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) })
  if (!res.ok) throw new Error(`upstream ${res.status}`)
  return res
}
