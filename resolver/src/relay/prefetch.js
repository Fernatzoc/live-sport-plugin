import { pullStream } from '../wire/curl.js'

const cache = new Map()
const nextMap = new Map()

export function setNextSegment(url, nextUrl) {
  nextMap.set(url, nextUrl)
  if (nextMap.size > 1000) {
    const firstKey = nextMap.keys().next().value
    nextMap.delete(firstKey)
  }
}

export function getNextSegment(url) {
  const nextUrl = nextMap.get(url)
  nextMap.delete(url)
  return nextUrl
}

export function prefetchSegment(url, slot) {
  if (cache.has(url)) return

  const controller = new AbortController()
  const promise = pullStream(url, slot, controller.signal).catch((err) => {
    cache.delete(url)
    throw err
  })

  cache.set(url, { promise, controller })

  if (cache.size > 5) {
    const firstKey = cache.keys().next().value
    const entry = cache.get(firstKey)
    cache.delete(firstKey)
    if (entry) {
      entry.promise.catch(() => {})
      entry.controller.abort()
    }
  }
}

export function getPrefetched(url) {
  const entry = cache.get(url)
  if (entry) {
    cache.delete(url)
    return entry.promise
  }
  return null
}
