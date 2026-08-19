const axios = require('axios');
const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const { parseTimezone } = require('../timezone');
const { BASE_URL } = require('../config');

class TimStreamsProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.name = 'TimStreams';
    this.apiUrl = 'https://timstreams.st/api/live-upcoming';
    
    this.fetchData = this.circuitBreaker.wrap(`${this.name}_fetch`, async () => {
      const res = await axios.get(this.apiUrl, { timeout: 7000 });
      return res.data;
    });
  }

  async getMatches() {
    const matches = [];
    try {
      const data = await this.fetchData.fire();
      if (!data || !Array.isArray(data.events)) return [];

      const genres = data.genres || {};
      
      data.events.forEach((s, index) => {
        const title = s.name || `TimStreams Event ${index}`;
        let rawGenre = s.genre;
        let genreLabel = 'other';
        if (Array.isArray(genres)) {
          const matchedGenre = genres.find(g => g.id === rawGenre);
          if (matchedGenre && matchedGenre.name) {
            genreLabel = matchedGenre.name;
          }
        } else if (typeof rawGenre === 'object' && rawGenre !== null && !Array.isArray(rawGenre)) {
          genreLabel = rawGenre.name || rawGenre.title || 'other';
        } else {
          genreLabel = String(genres[String(rawGenre)]?.name || genres[String(rawGenre)] || rawGenre || 'other');
        }
        
        const category = this.normalizeCategory(genreLabel);
        
        let dateMs = Date.now();
        if (s.time) {
          const parsed = parseTimezone(s.time, 'America/New_York');
          if (parsed) dateMs = parsed;
        }

        const sources = (s.streams || [])
          .filter(st => !st.vip)
          .map(st => ({
            source: 'timstreams',
            id: st.name || 'Stream',
            url: st.url
          }));

        if (sources.length > 0) {
          matches.push(new MatchEntity({
            id: `ts_${s.url || index}`,
            title: title,
            category: category,
            date: dateMs.toString(),
            popular: s.featured ? '1' : '0',
            sources: sources,
            thumbnail_url: s.logo || ''
          }));
        }
      });
    } catch (error) {
      console.error(`[${this.name}] Error fetching matches:`, error.stack);
    }
    return matches;
  }

  /**
   * Decode a XOR-obfuscated script block from TimStreams embed pages.
   * Pattern: var XXXX=[nums],YYYY=key1,ZZZZ=key2 → decoded via (char ^ key1 - key2 + 256) % 256
   */
  decodeObfuscatedScript(html) {
    const match = html.match(/var\s+(\w+)\s*=\s*\[([\d,]+)\]\s*,\s*(\w+)\s*=\s*(\d+)\s*,\s*(\w+)\s*=\s*(\d+)/);
    if (!match) return null;

    const arr = match[2].split(',').map(Number);
    const xor = parseInt(match[4]);
    const sub = parseInt(match[6]);

    let decoded = '';
    for (let i = 0; i < arr.length; i++) {
      decoded += String.fromCharCode(((arr[i] ^ xor) - sub + 256) % 256);
    }
    return decoded;
  }

  /**
   * Extract the signed m3u8 URL from a TimStreams embed page.
   */
  async extractM3u8(embedUrl) {
    try {
      const res = await fetch(embedUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
          'Referer': 'https://timstreams.st/'
        },
        signal: AbortSignal.timeout(10000)
      });

      if (!res.ok) return null;
      const html = await res.text();

      const decoded = this.decodeObfuscatedScript(html);
      if (!decoded) return null;

      const urlMatch = decoded.match(/https?:\/\/[^"]+\.m3u8/);
      if (!urlMatch) return null;

      // Extract the referer domain from the embed URL for proxyHeaders
      const embedDomain = new URL(embedUrl).origin;

      return { m3u8: urlMatch[0], referer: embedDomain };
    } catch (e) {
      console.warn(`[${this.name}] m3u8 extraction failed for ${embedUrl}:`, e.message);
      return null;
    }
  }

  async resolveStream(sourceId, matchCategory, matchTitle, streamNoParam = null, sourceName = 'timstreams') {
    const streams = [];
    const StreamEntity = require('../domain/StreamEntity');

    try {
      const matches = await this.getMatches();
      const match = matches.find(m => m.id === `ts_${sourceId}` || m.sources.some(s => s.id === sourceId));

      // Collect all embed URLs for this match
      let embedUrls = [];
      if (match) {
        embedUrls = match.sources
          .filter(s => s.url)
          .map(s => ({ name: s.id, url: s.url }));
      }

      if (embedUrls.length === 0) {
        embedUrls = [{ name: sourceId, url: `https://logic.icelanders.st/embed/${sourceId}` }];
      }

      // Try to extract m3u8 from each embed URL
      for (const embed of embedUrls) {
        const result = await this.extractM3u8(embed.url);

        if (result) {
          const { getCfProxyUrl } = require('./BaseProvider');
          const cfProxyUrl = getCfProxyUrl();

          let proxyUrl;
          if (cfProxyUrl) {
            console.log(`[Proxy] Using CF edge proxy for TimStreams match: ${embed.name}`);
            const proxyUri = new URL(cfProxyUrl);
            proxyUri.searchParams.set('url', result.m3u8);
            proxyUri.searchParams.set('referer', result.referer + '/');
            proxyUri.searchParams.set('origin', result.referer);
            proxyUrl = proxyUri.toString();
          } else {
            console.log(`[Proxy] Using internal fallback for TimStreams match: ${embed.name}`);
            // Route through Nuvio's internal HLS proxy to enforce User-Agent
            proxyUrl = `/api/hls/playlist.m3u8?url=${encodeURIComponent(result.m3u8)}&referer=${encodeURIComponent(result.referer + '/')}&origin=${encodeURIComponent(result.referer)}`;
          }
          
          streams.push(new StreamEntity({
            name: cfProxyUrl ? `TimStreams (CF Edge)` : `TimStreams`,
            title: embed.name || `TimStreams Stream`,
            url: proxyUrl,
            resolution: 'HD'
          }));
        } else {
          // Fallback to web player
          streams.push(new StreamEntity({
            name: `Nuvio Web Player`,
            title: `TimStreams (${embed.name}) (Web)`,
            externalUrl: `/watch?url=${encodeURIComponent(embed.url)}&title=${encodeURIComponent(matchTitle || 'Live Event')}`
          }));
        }
      }
    } catch (err) {
      console.error(`[${this.name}] resolveStream failed for ${sourceId}:`, err.message);
    }
    return streams;
  }
}

module.exports = TimStreamsProvider;
