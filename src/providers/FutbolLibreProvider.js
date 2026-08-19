const vm = require('vm');
const cheerio = require('cheerio');
const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { parseTimezone } = require('../timezone');

class FutbolLibreProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.name = 'FutbolLibre';
    this.baseUrl = 'https://futbollibretv.sx/';
    this.eventosUrl = 'https://futbollibretv.sx/eventos.js';
    this.configUrl = 'https://futbollibretv.sx/config.js';

    // In-memory map to hold streams found during getMatches execution
    this.streamsMap = new Map();

    // Circuit breaker wrapped fetchers
    this.fetchEventos = this.circuitBreaker.wrap(`${this.name}_fetchEventos`, async () => {
      return this.fetchText(this.eventosUrl, { 'Referer': this.baseUrl }, 10000);
    });

    this.fetchConfig = this.circuitBreaker.wrap(`${this.name}_fetchConfig`, async () => {
      return this.fetchText(this.configUrl, { 'Referer': this.baseUrl }, 8000);
    });

    this.fetchHtml = this.circuitBreaker.wrap(`${this.name}_fetchHtml`, async (url) => {
      return this.fetchText(url, { 'Referer': this.baseUrl }, 10000);
    });
  }

  async fetchText(url, customHeaders = {}, timeoutMs = 8000) {
    try {
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
        ...customHeaders
      };
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return null;
      return await res.text();
    } catch (e) {
      return null;
    }
  }

  parseEventDate(horaStr) {
    if (!horaStr || !horaStr.includes(':')) return Date.now();
    const parts = horaStr.split(':').map(n => parseInt(n, 10));
    const h = parts[0];
    const m = parts[1];
    if (isNaN(h) || isNaN(m)) return Date.now();

    const now = new Date();
    // Get current year, month, day in Europe/Madrid timezone
    const madridParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Madrid',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric'
    }).formatToParts(now);

    const partMap = {};
    madridParts.forEach(p => { partMap[p.type] = p.value; });

    const year = parseInt(partMap.year, 10);
    const month = parseInt(partMap.month, 10);
    const day = parseInt(partMap.day, 10);

    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
    const ts = parseTimezone(dateStr, 'Europe/Madrid');
    return ts || Date.now();
  }

  cleanStreamUrl(url) {
    if (!url) return '';
    let clean = url.replace(/\\\//g, '/').replace(/\\u0026/g, '&').replace(/&amp;/g, '&').replace(/["'`]/g, '').trim();
    if (clean.startsWith('//')) {
      clean = 'https:' + clean;
    }
    return clean;
  }

  decodeTargetUrl(rawUrl) {
    if (!rawUrl) return '';
    if (rawUrl.includes('?r=') || rawUrl.includes('&r=')) {
      const parts = rawUrl.split(/[?&]r=/);
      if (parts[1]) {
        try {
          const b64 = parts[1].split('&')[0];
          const decoded = Buffer.from(b64, 'base64').toString('utf8');
          if (decoded.startsWith('http://') || decoded.startsWith('https://')) {
            return decoded;
          }
        } catch (e) {
          // fallback to rawUrl
        }
      }
    }
    return rawUrl;
  }

  async getMatches() {
    const matches = [];
    this.streamsMap.clear();

    const now = Date.now();

    // 1. Fetch Agenda Events (eventos.js)
    try {
      const eventosScript = await this.fetchEventos.fire();
      if (eventosScript) {
        const sandbox = {};
        vm.createContext(sandbox);
        let eventosData = [];
        try {
          eventosData = vm.runInContext(eventosScript + '\nEVENTOS_DATA;', sandbox) || [];
        } catch (err) {
          console.warn(`[${this.name}] Error running eventos script context:`, err.message);
        }

        if (Array.isArray(eventosData)) {
          eventosData.forEach((evento, idx) => {
            const rawTitle = evento.titulo || `Partido ${evento.id || idx + 1}`;
            const matchId = `fl_${evento.id || idx + 1}`;
            const dateMs = this.parseEventDate(evento.hora);

            const isLive = now >= (dateMs - 15 * 60 * 1000) && now <= (dateMs + 3 * 3600 * 1000);

            // Extract team names and league
            let league = '';
            let teamsTitle = rawTitle;
            if (rawTitle.includes(':')) {
              const colonParts = rawTitle.split(':');
              league = colonParts[0].trim();
              teamsTitle = colonParts.slice(1).join(':').trim();
            }

            let team1Name = null;
            let team2Name = null;
            if (teamsTitle.includes(' vs ')) {
              const parts = teamsTitle.split(' vs ');
              team1Name = parts[0].trim();
              team2Name = parts[1].trim();
            } else if (teamsTitle.includes(' - ')) {
              const parts = teamsTitle.split(' - ');
              team1Name = parts[0].trim();
              team2Name = parts[1].trim();
            } else if (teamsTitle.includes(' v ')) {
              const parts = teamsTitle.split(' v ');
              team1Name = parts[0].trim();
              team2Name = parts[1].trim();
            }

            // Extract channels / streams
            const channelsList = [];
            if (Array.isArray(evento.canales)) {
              evento.canales.forEach((canal, cIdx) => {
                const targetUrl = this.decodeTargetUrl(canal.url);
                if (targetUrl) {
                  channelsList.push({
                    name: canal.nombre || `Opción ${cIdx + 1}`,
                    quality: canal.calidad || '720p',
                    url: targetUrl
                  });
                }
              });
            }

            if (channelsList.length > 0) {
              this.streamsMap.set(matchId, channelsList);

              matches.push(new MatchEntity({
                id: matchId,
                title: rawTitle,
                category: this.normalizeCategory(evento.clase || 'football'),
                date: dateMs.toString(),
                popular: isLive ? '1' : '0',
                league: league,
                team1: team1Name ? { name: team1Name } : null,
                team2: team2Name ? { name: team2Name } : null,
                sources: [{ source: 'futbollibre', id: matchId }]
              }));
            }
          });
        }
      }
    } catch (e) {
      console.error(`[${this.name}] Error scraping agenda events:`, e.message);
    }

    // 2. Fetch 24/7 Channels
    try {
      let activeDomain = 'streamtp99a.sbs';
      let basePath = '/global1.php?stream=';

      const configScript = await this.fetchConfig.fire();
      if (configScript) {
        const domainMatch = configScript.match(/activeDomain\s*:\s*["']([^"']+)["']/);
        const pathMatch = configScript.match(/basePath\s*:\s*["']([^"']+)["']/);
        if (domainMatch && domainMatch[1]) activeDomain = domainMatch[1];
        if (pathMatch && pathMatch[1]) basePath = pathMatch[1];
      }

      const default247Channels = [
        { id: 'dsports', name: 'DSPORTS' },
        { id: 'dsports2', name: 'DSPORTS 2' },
        { id: 'dsportsplus', name: 'DSPORTS +' },
        { id: 'espn', name: 'ESPN 1' },
        { id: 'espn2', name: 'ESPN 2' },
        { id: 'espn3', name: 'ESPN 3' },
        { id: 'espnpremium', name: 'ESPN Premium' },
        { id: 'fox1ar', name: 'Fox Sports 1' },
        { id: 'foxar2', name: 'Fox Sports 2' },
        { id: 'foxar3', name: 'Fox Sports 3' },
        { id: 'liga1max', name: 'Liga 1 MAX' },
        { id: 'tntsports', name: 'TNT Sports' },
        { id: 'tyc', name: 'TyC Sports' },
        { id: 'winsports', name: 'Win Sports' },
        { id: 'winplus', name: 'Win Sports +' },
        { id: 'tudnmx', name: 'TUDN MX' },
        { id: 'espndeportes', name: 'ESPN Deportes' },
        { id: 'fox_deportes_usa', name: 'FOX Deportes USA' }
      ];

      default247Channels.forEach((ch) => {
        const channelSourceId = `ch_${ch.id}`;
        const streamUrl = `https://${activeDomain}${basePath}${ch.id}`;

        this.streamsMap.set(channelSourceId, [
          {
            name: ch.name,
            quality: 'HD',
            url: streamUrl
          }
        ]);

        matches.push(new MatchEntity({
          id: `fl_${channelSourceId}`,
          title: `${ch.name}`,
          category: 'networks',
          date: '0',
          popular: '0',
          sources: [{ source: 'futbollibre', id: channelSourceId }]
        }));
      });
    } catch (e) {
      console.error(`[${this.name}] Error building 24/7 channels:`, e.message);
    }

    return matches;
  }

  /**
   * Helper to extract direct m3u8 link from an embed HTML page
   */
  extractM3u8FromHtml(html) {
    if (!html) return null;

    // 1. Check for var playbackURL = "..."
    const playbackMatch = html.match(/(?:var\s+playbackURL|source|src|file)\s*[:=]\s*["']([^"']+\.m3u8[^"']*)["']/i);
    if (playbackMatch) {
      return this.cleanStreamUrl(playbackMatch[1]);
    }

    // 2. Direct regex search for m3u8
    const m3u8Match = html.match(/https?:?(?:\\\/\\\/|\/\/)[^"'`\s<>]+\.m3u8[^"'`\s<>]*/i);
    if (m3u8Match) {
      return this.cleanStreamUrl(m3u8Match[0]);
    }

    // 3. Check for Clappr base64 encoded streams
    const atobMatch = html.match(/window\.atob\(['"]([A-Za-z0-9+/=]+)['"]\)/);
    if (atobMatch) {
      try {
        const decoded = Buffer.from(atobMatch[1], 'base64').toString('ascii');
        if (decoded.includes('.m3u8')) {
          return this.cleanStreamUrl(decoded);
        }
      } catch (e) { }
    }

    return null;
  }

  async resolveStream(sourceId, matchCategory, matchTitle, src) {
    const cached = this.streamsMap.get(sourceId);
    let channelsToResolve = cached || [];

    if (channelsToResolve.length === 0 && src && src.url) {
      channelsToResolve = [{ name: 'Stream', quality: 'HD', url: src.url }];
    }

    if (channelsToResolve.length === 0) {
      return [];
    }

    const resolveTasks = channelsToResolve.map(async (canal) => {
      const channelName = canal.name || 'FutbolLibre';
      const channelQuality = canal.quality || 'HD';
      const targetUrl = canal.url;

      if (!targetUrl) return [];

      // If it's already an m3u8 link
      if (targetUrl.includes('.m3u8')) {
        const reqHeaders = {
          'Origin': this.baseUrl.replace(/\/$/, ''),
          'Referer': this.baseUrl,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
        };

        const isLive = await this.verifyStream(targetUrl, reqHeaders);
        if (!isLive) return [];

        return [
          new StreamEntity({
            name: 'Nuvio Direct',
            title: `FutbolLibre: ${channelName} (${channelQuality}) ⚡`,
            url: targetUrl,
            behaviorHints: {
              notWebReady: true,
              proxyHeaders: {
                request: reqHeaders
              }
            },
            resolution: channelQuality
          })
        ];
      }

      // Fetch embed page to extract direct m3u8
      try {
        const html = await this.fetchText(targetUrl, { 'Referer': this.baseUrl }, 7000);
        if (html) {
          const directM3u8 = this.extractM3u8FromHtml(html);
          if (directM3u8) {
            let streamOrigin = this.baseUrl.replace(/\/$/, '');
            let streamReferer = this.baseUrl;

            try {
              const parsedTarget = new URL(targetUrl);
              streamOrigin = parsedTarget.origin;
              streamReferer = parsedTarget.origin + '/';
            } catch (e) { }

            const reqHeaders = {
              'Origin': streamOrigin,
              'Referer': streamReferer,
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
            };

            const isLive = await this.verifyStream(directM3u8, reqHeaders);
            if (isLive) {
              return [
                new StreamEntity({
                  name: 'Nuvio Direct',
                  title: `FutbolLibre: ${channelName} (${channelQuality}) ⚡`,
                  url: directM3u8,
                  behaviorHints: {
                    notWebReady: true,
                    proxyHeaders: {
                      request: reqHeaders
                    }
                  },
                  resolution: channelQuality
                })
              ];
            }
          }
        }
      } catch (err) {
        console.warn(`[${this.name}] Failed to resolve direct stream for ${targetUrl}:`, err.message);
      }

      // Fallback: Web player embed
      return [
        new StreamEntity({
          name: 'Nuvio Web Player',
          title: `FutbolLibre: ${channelName} (${channelQuality}) [Web]`,
          externalUrl: `/watch?url=${encodeURIComponent(targetUrl)}&title=${encodeURIComponent(matchTitle || channelName)}`
        })
      ];
    });

    const results = await Promise.all(resolveTasks);
    return results.flat().filter(Boolean);
  }
}

module.exports = FutbolLibreProvider;
