const cheerio = require('cheerio');
const vm = require('vm');
const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { BASE_URL } = require('../config');

class RojadirectaProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.name = 'Rojadirecta';
    this.baseUrl = 'http://www.rojadirecta.eu/es';

    // Memory map to store streams found during getMatches execution
    this.streamsMap = new Map();

    // Wrap request with Opossum Circuit Breaker
    this.fetchHtml = this.circuitBreaker.wrap(`${this.name}_fetch`, async (url = this.baseUrl, customHeaders = {}) => {
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
        'Referer': 'http://www.rojadirecta.eu/',
        ...customHeaders
      };
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);

      const contentType = res.headers.get('content-type') || '';
      let charset = 'utf-8';
      const charsetMatch = contentType.match(/charset=([^;]+)/i);
      if (charsetMatch && charsetMatch[1]) {
        charset = charsetMatch[1].trim().toLowerCase();
      } else if (url.includes('rojadirecta')) {
        charset = 'iso-8859-1';
      }

      const buffer = await res.arrayBuffer();
      const decoder = new TextDecoder(charset);
      return decoder.decode(buffer);
    });
  }

  parseSpainDate(dateStr) {
    if (!dateStr) return Date.now();
    const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
    if (!m) return new Date(dateStr).getTime();

    const year = parseInt(m[1]);
    const month = parseInt(m[2]) - 1;
    const day = parseInt(m[3]);
    const hour = parseInt(m[4]);
    const minute = parseInt(m[5]);

    const d = new Date(Date.UTC(year, month, day, hour, minute));
    const tzString = d.toLocaleString('en-US', { timeZone: 'Europe/Madrid', timeZoneName: 'longOffset' });
    const offsetMatch = tzString.match(/GMT([+-]\d+)(?::(\d+))?/);
    let offsetMinutes = 0;
    if (offsetMatch) {
      const hours = parseInt(offsetMatch[1]);
      const mins = offsetMatch[2] ? parseInt(offsetMatch[2]) : 0;
      offsetMinutes = hours * 60 + (hours >= 0 ? mins : -mins);
    } else {
      offsetMinutes = 120; // default Europe/Madrid DST offset
    }

    return d.getTime() - offsetMinutes * 60 * 1000;
  }

  async getMatches() {
    const matches = [];
    this.streamsMap.clear();

    try {
      const html = await this.fetchHtml.fire();
      if (!html) return [];

      const $ = cheerio.load(html);
      const now = Date.now();

      $('span[itemtype="http://schema.org/SportsEvent"]').each((i, el) => {
        const matchSpan = $(el);
        const titleEl = matchSpan.find('.menutitle');
        if (titleEl.length === 0) return;

        // 1. Extract metadata
        const sport = titleEl.find('span.es').text().trim() || titleEl.find('span.en').text().trim() || 'Varios';
        const name = titleEl.find('[itemprop="name"]').text().trim();
        const dateStr = titleEl.find('meta[itemprop="startDate"]').attr('content');

        let dateMs = now;
        if (dateStr) {
          dateMs = this.parseSpainDate(dateStr);
        }

        const matchId = `roja_${i}`;
        const title = `${sport}: ${name}`;

        // Determine if match is currently live (starts in less than 15 mins or started less than 3 hours ago)
        const isLive = now >= (dateMs - 15 * 60 * 1000) && now <= (dateMs + 3 * 3600 * 1000);

        // 2. Extract associated streams
        const submenu = matchSpan.find('.submenu');
        const streamsList = [];

        submenu.find('table.taboastreams tr').each((j, trEl) => {
          if (j === 0) return; // skip table header
          const tds = $(trEl).find('td');
          if (tds.length < 6) return;

          const p2p = $(tds[0]).text().trim();
          const providerName = $(tds[1]).text().trim();
          const lang = $(tds[2]).text().trim();
          const type = $(tds[3]).text().trim();
          const kbps = $(tds[4]).text().trim();
          const href = $(tds[5]).find('a').attr('href');

          if (href) {
            streamsList.push({
              p2p,
              providerName,
              lang,
              type,
              kbps,
              href
            });
          }
        });

        // Store streams in memory map
        if (streamsList.length > 0) {
          this.streamsMap.set(matchId, streamsList);

          matches.push(new MatchEntity({
            id: matchId,
            title: title,
            category: this.normalizeCategory(sport),
            date: dateMs.toString(),
            popular: isLive ? '1' : '0',
            sources: [{ source: 'rojadirecta', id: matchId }]
          }));
        }
      });

    } catch (error) {
      console.error(`[${this.name}] Error scraping matches:`, error.message);
    }

    return matches;
  }

  /**
   * Helper to decrypt HLS streams from HTML string containing var_u/var_k variables
   */
  decryptFromHtml(html) {
    if (!html) return null;
    const scriptRegex = /<script>([\s\S]*?)<\/script>/g;
    let match;
    while ((match = scriptRegex.exec(html)) !== null) {
      const scriptContent = match[1];
      if (scriptContent.includes('var_u') && scriptContent.includes('var_k')) {
        const sandbox = {
          Element: { prototype: {} },
          HTMLElement: class HTMLElement { },
          localStorage: { getItem: () => null, setItem: () => { } },
          document: {
            getElementById: () => ({ style: {} }),
            querySelector: () => null
          },
          atob: (s) => Buffer.from(s, 'base64').toString('binary'),
          btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
          jwplayer: () => ({
            setup: () => { },
            on: () => { },
            addButton: () => { }
          }),
          setTimeout: () => { },
          setInterval: () => { },
          navigator: { userAgent: '' },
          location: { href: '', hostname: '' },
          console: { log: () => { } }
        };
        sandbox.window = sandbox;

        vm.createContext(sandbox);
        try {
          vm.runInContext(scriptContent, sandbox);
        } catch (e) {
          // Expected error
        }

        if (sandbox.var_u && sandbox.var_k) {
          const uArray = typeof sandbox.var_u === 'string' ? JSON.parse(sandbox.var_u) : sandbox.var_u;
          const kKey = sandbox.var_k;

          let decryptedUrl = "";
          for (let i = 0; i < uArray.length; i++) {
            decryptedUrl += String.fromCharCode(uArray[i] ^ kKey.charCodeAt(i % kKey.length));
          }
          return decryptedUrl;
        }
      }
    }
    return null;
  }

  /**
   * Helper to decrypt stream configurations from window._econfig encrypted strings
   */
  decryptEconfig(input) {
    if (!input) return null;
    try {
      const perm = [2, 0, 3, 1];
      const numChunks = 4;

      // 1. Base64 decode input to binary string
      let decoded = Buffer.from(input, 'base64').toString('binary');

      // 2. Divide into 4 chunks using Math.ceil
      const len = decoded.length;
      const chunkSize = Math.ceil(len / numChunks);

      const chunks = [];
      let offset = 0;
      for (let i = 0; i < numChunks; i++) {
        const chunk = decoded.substr(offset, chunkSize);
        chunks.push(chunk);
        offset += chunkSize;
      }

      // 3. Decode and permute
      const decodedChunks = [];
      for (let i = 0; i < perm.length; i++) {
        let chunk = chunks[i];
        if (!chunk) continue;

        // Slice off character at index 3
        chunk = chunk.slice(0, 3) + chunk.slice(4);

        const decodedChunk = Buffer.from(chunk, 'base64').toString('binary');
        decodedChunks[perm[i]] = decodedChunk;
      }

      // 4. Join and final decode
      const joined = decodedChunks.join('');
      const finalDecoded = Buffer.from(joined, 'base64').toString('utf8');

      const parsed = JSON.parse(finalDecoded);
      return parsed.stream_url_nop2p || parsed.stream_url || null;
    } catch (e) {
      console.warn(`[${this.name}] Econfig decryption failed:`, e.message);
    }
    return null;
  }

  /**
   * Helper to decrypt HLS streams from players like sudamericaplay.sbs
   */
  async decryptPlayerStream(url, referer) {
    try {
      const html = await this.fetchHtml.fire(url, { 'Referer': referer });
      if (html) {
        return this.decryptFromHtml(html);
      }
    } catch (e) {
      console.error(`[${this.name}] Player decryption failed for ${url}:`, e.message);
    }
    return null;
  }

  /**
   * Recursively crawls page and nested iframes to find player HLS stream details.
   */
  extractTargetUrl(url) {
    if (!url) return null;
    const gotoIdx = url.indexOf('/goto/');
    if (gotoIdx !== -1) {
      const target = url.substring(gotoIdx + 6);
      if (target.startsWith('http://') || target.startsWith('https://')) {
        return target;
      }
      try {
        return decodeURIComponent(target);
      } catch (e) {
        return target;
      }
    }
    return url;
  }

  async followRedirects(url, referer) {
    try {
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
        'Referer': referer
      };
      const res = await fetch(url, { headers, method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(4000) });
      return res.url;
    } catch (e) {
      return url;
    }
  }

  /**
   * Recursively crawls page and nested iframes to find player HLS stream details.
   */
  async findIframeStream(url, referer, depth = 0, state = { deepestUrl: null }) {
    if (depth > 3) return null;
    try {
      state.deepestUrl = url;
      const html = await this.fetchHtml.fire(url, { 'Referer': referer });
      if (!html) return null;

      // A. Check for window._econfig configuration
      const econfigMatch = html.match(/window\._econfig\s*=\s*['"]([^'"]+)['"]/);
      if (econfigMatch) {
        const streamUrl = this.decryptEconfig(econfigMatch[1]);
        if (streamUrl) {
          const parsed = new URL(url);
          return {
            url: streamUrl,
            referer: parsed.origin + '/',
            origin: parsed.origin
          };
        }
      }

      // B. Check for Clappr base64 encoded streams
      const atobMatch = html.match(/window\.atob\(['"]([A-Za-z0-9+/=]+)['"]\)/);
      if (atobMatch) {
        const streamUrl = Buffer.from(atobMatch[1], 'base64').toString('ascii');
        const parsed = new URL(url);
        return {
          url: streamUrl,
          referer: parsed.origin + '/',
          origin: parsed.origin
        };
      }

      // C. Check for direct .m3u8 links in player scripts
      const m3u8Matches = html.match(/https?:\/\/[^"'`\s>]+\.m3u8[^"'`\s>]*/gi);
      if (m3u8Matches && m3u8Matches.length > 0) {
        const cleanUrl = m3u8Matches[0].replace(/&amp;/g, '&').replace(/["'`]/g, '');
        const parsed = new URL(url);
        return {
          url: cleanUrl,
          referer: parsed.origin + '/',
          origin: parsed.origin
        };
      }

      // D. Check for var playbackURL definitions
      const playbackMatch = html.match(/var playbackURL\s*=\s*["']([^"']+)["']/i);
      if (playbackMatch) {
        const parsed = new URL(url);
        return {
          url: playbackMatch[1],
          referer: parsed.origin + '/',
          origin: parsed.origin
        };
      }

      // E. Check for sudamericaplay/streamtp encrypted streams
      const sudamericaUrl = this.decryptFromHtml(html);
      if (sudamericaUrl) {
        const parsed = new URL(url);
        return {
          url: sudamericaUrl,
          referer: parsed.origin + '/',
          origin: parsed.origin
        };
      }

      // F. Check if the page is xuperflow/canales template
      const matchCanales = html.match(/const canales\s*=\s*(\[[\s\S]*?\]);/);
      if (matchCanales) {
        const sandbox = {};
        vm.createContext(sandbox);
        vm.runInContext(matchCanales[0], sandbox);
        const channels = sandbox.canales || [];
        const pickedChannel = channels.find(c => c.url) || channels[0];
        if (pickedChannel && pickedChannel.url) {
          const streamUrl = await this.decryptPlayerStream(pickedChannel.url, url);
          if (streamUrl) {
            const parsed = new URL(pickedChannel.url);
            return {
              url: streamUrl,
              referer: parsed.origin + '/',
              origin: parsed.origin
            };
          }
        }
      }

      // G. Check for unescape percent-encoded script blocks (e.g. flowplayer/sebn.dad)
      const unescapeMatches = html.match(/unescape\(['"]([^'"]+)['"]/gi);
      if (unescapeMatches) {
        for (const match of unescapeMatches) {
          const innerMatch = match.match(/unescape\(['"]([^'"]+)['"]/i);
          if (innerMatch && innerMatch[1]) {
            try {
              const unescaped = decodeURIComponent(innerMatch[1]);
              const subM3u8Matches = unescaped.match(/https?:?\/\/[^"'`\s>]+\.m3u8[^"'`\s>]*/gi) ||
                unescaped.match(/\/\/[^"'`\s>]+\.m3u8[^"'`\s>]*/gi);
              if (subM3u8Matches && subM3u8Matches.length > 0) {
                let cleanUrl = subM3u8Matches[0].replace(/&amp;/g, '&').replace(/["'`]/g, '');
                if (cleanUrl.startsWith('//')) {
                  cleanUrl = 'https:' + cleanUrl;
                }
                const parsed = new URL(url);
                return {
                  url: cleanUrl,
                  referer: parsed.origin + '/',
                  origin: parsed.origin
                };
              }
            } catch (e) { }
          }
        }
      }

      // H. Find iframes and recursively scan them
      const $ = cheerio.load(html);
      const iframes = [];
      $('iframe').each((_, el) => {
        const src = $(el).attr('src');
        if (src) iframes.push(src);
      });

      for (let iframeSrc of iframes) {
        if (iframeSrc.startsWith('//')) {
          iframeSrc = 'https:' + iframeSrc;
        } else if (iframeSrc.startsWith('/')) {
          try {
            const parsedUrl = new URL(url);
            iframeSrc = parsedUrl.origin + iframeSrc;
          } catch (e) { }
        } else if (!iframeSrc.startsWith('http://') && !iframeSrc.startsWith('https://')) {
          try {
            iframeSrc = new URL(iframeSrc, url).href;
          } catch (e) { }
        }

        // Special case: ch.nexa.st requires API fetch
        if (iframeSrc.includes('ch.nexa.st')) {
          try {
            const nexaUrl = new URL(iframeSrc);
            const id = nexaUrl.searchParams.get('id');
            if (id) {
              const apiUrl = `${nexaUrl.origin}/api/player.php?id=${id}`;
              const apiRes = await fetch(apiUrl, {
                headers: {
                  'User-Agent': 'Mozilla/5.0',
                  'Referer': iframeSrc,
                  'X-Requested-With': 'XMLHttpRequest'
                },
                signal: AbortSignal.timeout(6000)
              });
              if (apiRes.ok) {
                const apiData = await apiRes.json();
                if (apiData && apiData.url) {
                  const resolved = await this.findIframeStream(apiData.url, iframeSrc, depth + 1, state);
                  if (resolved) return resolved;
                }
              }
            }
          } catch (e) { }
          continue;
        }

        const resolved = await this.findIframeStream(iframeSrc, url, depth + 1, state);
        if (resolved) return resolved;
      }
    } catch (e) {
      // ignore
    }
    return null;
  }

  async resolveStream(sourceId, matchCategory, matchTitle) {
    const cached = this.streamsMap.get(sourceId);
    if (!cached || cached.length === 0) {
      return [];
    }

    const resolveTasks = cached.map(async (s) => {
      const title = `${s.providerName} (${s.lang || 'es'}) [${s.type} - ${s.kbps}kbps]`;
      const isDirect = s.href.includes('.m3u8');

      if (isDirect) {
        return new StreamEntity({
          name: 'Nuvio Direct',
          title: title,
          url: s.href
        });
      }

      // 1. Extract target URL from Rojadirecta redirect if possible, otherwise follow redirects
      let cleanUrl = this.extractTargetUrl(s.href);
      if (cleanUrl === s.href) {
        cleanUrl = await this.followRedirects(s.href, 'http://www.rojadirecta.eu/');
      }

      const state = { deepestUrl: cleanUrl };

      try {
        const resolved = await this.findIframeStream(cleanUrl, 'http://www.rojadirecta.eu/', 0, state);
        if (resolved && resolved.url) {
          const localProxyUrl = `/api/hls?url=${encodeURIComponent(resolved.url)}&referer=${encodeURIComponent(resolved.referer)}&embed=rojadirecta/${encodeURIComponent(sourceId)}/1&embedOrigin=${encodeURIComponent(resolved.origin)}`;

          return new StreamEntity({
            name: 'Nuvio Direct',
            title: title + ' ⚡',
            url: localProxyUrl
          });
        }
      } catch (err) {
        console.warn(`[${this.name}] Dynamic resolver failed for ${s.href}:`, err.message);
      }

      // If we couldn't resolve the stream to an m3u8, but we found a cleaner embed/player URL,
      // use the deepestUrl reached rather than the raw redirect link.
      const fallbackUrl = state.deepestUrl || cleanUrl || s.href;

      return new StreamEntity({
        name: 'Nuvio Web Player',
        title: title,
        externalUrl: `${BASE_URL}/watch?url=${encodeURIComponent(fallbackUrl)}&title=${encodeURIComponent(matchTitle || 'Live Event')}`
      });
    });

    const results = await Promise.all(resolveTasks);
    return results.filter(Boolean);
  }
}

module.exports = RojadirectaProvider;
