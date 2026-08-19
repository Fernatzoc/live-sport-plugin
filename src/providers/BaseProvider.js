// Hardcoded CF proxy pool — add more URLs to multiply free-tier limits
const CF_PROXY_POOL = [
  'https://nuvio-proxy.odedararaj456.workers.dev',
  'https://nuvio-proxy2.rajodedara360.workers.dev',
  'https://nuvio-proxy3.raj-odedara.workers.dev',
];

// Pick a random proxy from the pool
function getCfProxyUrl() {
  if (process.env.NODE_ENV === 'test') return null;
  if (CF_PROXY_POOL.length === 0) return null;
  return CF_PROXY_POOL[Math.floor(Math.random() * CF_PROXY_POOL.length)];
}

class BaseProvider {
  constructor({ circuitBreaker }) {
    this.circuitBreaker = circuitBreaker;
    this.name = 'BaseProvider';
  }

  /**
   * Fetch matches from the provider.
   * Should return an array of MatchEntity objects.
   */
  async getMatches() {
    throw new Error('getMatches() must be implemented by subclasses');
  }

  /**
   * Resolve a specific stream source.
   * Should return an array of StreamEntity objects.
   */
  async resolveStream(sourceId, matchCategory, matchTitle) {
    return [];
  }

  /**
   * Helper to normalize category strings across all providers
   */
  normalizeCategory(cat) {
    if (!cat) return 'other';
    if (typeof cat === 'object' && !Array.isArray(cat)) {
      cat = cat.name || cat.title || 'other';
    }
    cat = String(cat).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (cat.includes('americanfootball') || cat.includes('nfl') || cat.includes('afl') || cat.includes('gridiron')) return 'american_football';
    if (cat.includes('soccer') || cat.includes('football')) return 'football';
    if (cat.includes('motor') || cat.includes('racing') || cat.includes('cycling') || cat.includes('f1')) return 'motorsport';
    if (cat.includes('fight') || cat.includes('mma') || cat.includes('boxing') || cat.includes('wrestling') || cat.includes('knuckle') || cat.includes('ufc')) return 'mma';
    if (cat.includes('basketball') || cat.includes('nba')) return 'basketball';
    if (cat.includes('golf')) return 'golf';
    if (cat.includes('rugby')) return 'rugby';
    if (cat.includes('cricket')) return 'cricket';
    if (cat.includes('tennis')) return 'tennis';
    if (cat.includes('hockey') || cat.includes('nhl')) return 'hockey';
    if (cat.includes('baseball') || cat.includes('mlb')) return 'baseball';
    if (cat.includes('darts')) return 'darts';
    if (cat.includes('liveshow') || cat.includes('uncategorized')) return 'other';
    return cat;
  }

  /**
   * Fetch wrapper that routes through Cloudflare proxy if configured
   */
  async proxyFetch(url, options = {}) {
    const cfProxyUrl = getCfProxyUrl();
    if (cfProxyUrl) {
      const proxyUrl = new URL(cfProxyUrl);
      proxyUrl.searchParams.set('url', url);
      
      if (options.headers) {
        let referer, origin;
        if (options.headers instanceof Headers) {
          referer = options.headers.get('referer') || options.headers.get('Referer');
          origin = options.headers.get('origin') || options.headers.get('Origin');
        } else {
          referer = options.headers.referer || options.headers.Referer;
          origin = options.headers.origin || options.headers.Origin;
        }
        
        if (referer) proxyUrl.searchParams.set('referer', referer);
        if (origin) proxyUrl.searchParams.set('origin', origin);
      }
      
      url = proxyUrl.toString();
    }
    
    return fetch(url, options);
  }

  /**
   * Get the proxy URL for a stream
   */
  getStreamProxyUrl(streamUrl, referer, origin) {
    const cfProxyUrl = getCfProxyUrl();
    if (cfProxyUrl) {
      const proxyUrl = new URL(cfProxyUrl);
      proxyUrl.searchParams.set('url', streamUrl);
      if (referer) proxyUrl.searchParams.set('referer', referer);
      if (origin) proxyUrl.searchParams.set('origin', origin);
      // Append .m3u8 to the end of the URL so mobile players recognize it as an HLS stream
      return proxyUrl.toString() + '&ext=.m3u8';
    }
    
    // Fallback to internal relay
    let internalProxy = `/api/hls/${encodeURIComponent(streamUrl)}/stream.m3u8`;
    const q = new URLSearchParams();
    q.set('url', streamUrl);
    if (referer) q.set('referer', referer);
    if (origin) q.set('embedOrigin', origin);
    return `/api/hls/playlist.m3u8?${q.toString()}`;
  }

  /**
   * Helper to normalize strings for fuzzy matching
   */
  normalizeStr(str) {
    if (!str) return '';
    return str.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

module.exports = BaseProvider;
module.exports.getCfProxyUrl = getCfProxyUrl;
