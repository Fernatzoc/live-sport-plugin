# Bug Hunt Swarm Report

This report compiles the latent bugs and structural flaws discovered by the parallel read-only AI agents during the codebase audit on the Nuvio Live Sports Plugin.

## 1. `TypeError` Crashing the Stream Resolver (High Risk)
* **Hypothesis:** If the `iptv-org` API returns an integer for stream quality (e.g., `1080` instead of `"1080p"`), the `streams.js` file blindly calls `.includes('x')` on it. This throws a `TypeError` and crashes the entire `/stream/` endpoint for that match.
* **Evidence:** In `streams.js` (line 183), the code assumes `quality` is always a string: `if (quality.includes('x')) { ... }`. If an integer is returned, `.includes()` throws a `TypeError`, taking down the request.
* **Recommended Fix Path:** Coerce the quality to a string before checking it: `if (String(quality).includes('x'))`.

## 2. Cron Job Wiping the Catalog on Network Outages (High Risk)
* **Hypothesis:** If your server experiences a brief network outage and the providers fail to fetch, the active catalog will be completely wiped out for all users instead of gracefully serving stale matches.
* **Evidence:** In `MatchAggregator.js`, the cron unconditionally runs `this.cacheService.setMatches(activeMatches)`. If `activeMatches` is `[]` due to network failures, the cache is overwritten with an empty array.
* **Recommended Fix Path:** Add a safety check in the aggregator: `if (activeMatches.length > 0) { this.cacheService.setMatches(activeMatches); }` to preserve stale data during outages.

## 3. Masked Network Failures (Medium Risk)
* **Hypothesis:** When a provider (like `Strims24Provider`) fails 3 times and trips the circuit breaker, it logs a misleading `TypeError` instead of an actual network or circuit breaker error.
* **Evidence:** `CircuitBreakerService` explicitly returns `null` on fallback. However, many providers assume they always get a valid `Response` object and blindly call `await res.json()` or `await res.text()`. This throws `Cannot read properties of null`, masking the true error.
* **Recommended Fix Path:** Refactor providers to explicitly check `if (!res) return [];` immediately after fetching.

## 4. Silent Failures in the Proxy Interceptor (Medium Risk)
* **Hypothesis:** If a stream provider returns malformed external URLs, the Express proxy in `src/index.js` silently fails to rewrite the URLs. It breaks playback for remote Stremio users with absolutely zero errors logged to the console, making it a nightmare to debug.
* **Evidence:** The JSON interception logic in `src/index.js` (lines 134-167) is wrapped in an empty `try...catch (e) { }`. If a `.startsWith()` check fails on a non-string object, the proxy bails silently.
* **Recommended Fix Path:** Add `console.error('[Proxy Error]', e.message)` inside the empty `catch` block on line 167 of `src/index.js`.

## 5. Fragile State in the Match Aggregator (Medium Risk)
* **Hypothesis:** The `MatchAggregator.syncMatches()` loop assumes every match object has a `.sources` array. If one scraper returns a malformed object without `.sources`, calling `.forEach()` on it throws a `TypeError` and crashes the entire 5-minute sync loop for *all* providers.
* **Evidence:** `MatchAggregator.js` blindly calls `match.sources.forEach(...)`. The error is caught by `CronService` but the stack trace is destroyed (logging only `e.message`), making it incredibly difficult to find which provider caused the crash.
* **Recommended Fix Path:** Add a defensive check `if (!match.sources || !Array.isArray(match.sources)) continue;` when merging matches.
