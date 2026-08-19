const axios = require('axios');
const cheerio = require('cheerio');
const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');

const { BASE_URL } = require('../config');

class MlbElMundoProvider extends BaseProvider {
  constructor({ circuitBreaker }) {
    super({ circuitBreaker });
    this.name = 'MlbElMundo';
    this.baseUrl = 'https://www.elmundodelasmayores.com/partidosmlb/';
    
    this.fetchData = this.circuitBreaker.wrap(`${this.name}_fetch`, async (url) => {
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
      };
      const res = await axios.get(url, { headers, timeout: 10000 });
      return res.data;
    });
  }

  async getMatches() {
    const matches = [];
    try {
      const html = await this.fetchData.fire(this.baseUrl);
      if (!html) return [];

      const $ = cheerio.load(html);
      const parsedItems = new Set();

      $('a.match-card-link').each((i, el) => {
        const href = $(el).attr('href');
        if (!href) return;

        const card = $(el).find('section.match-card');
        if (card.length === 0) return;

        const team1 = card.attr('data-team1') || card.find('.team-left').text().trim();
        const team2 = card.attr('data-team2') || card.find('.team-right').text().trim();
        const dateVal = card.attr('data-date');
        const timeVal = card.attr('data-time');

        if (!team1 || !team2) return;

        const title = `MLB: ${team1} vs ${team2}`;

        // Try to parse kickoff date. Default to EST (GMT-4) for MLB game times.
        let dateMs = Date.now();
        if (dateVal && timeVal) {
          try {
            const dateObj = new Date(`${dateVal}T${timeVal}:00-04:00`);
            if (!isNaN(dateObj.getTime())) {
              dateMs = dateObj.getTime();
            }
          } catch (e) {
            // fallback
          }
        }

        if (!parsedItems.has(href)) {
          parsedItems.add(href);
          
          matches.push(new MatchEntity({
            id: `mlbelmundo_${Buffer.from(title).toString('base64').substring(0, 16).replace(/[^a-zA-Z0-9]/g, '')}`,
            title: title,
            category: 'baseball',
            date: dateMs.toString(),
            popular: '0', // Will be boosted dynamically by MatchAggregator if live
            league: 'MLB',
            team1: { name: team1 },
            team2: { name: team2 },
            sources: [{ source: 'mlbelmundo', id: href, url: href }]
          }));
        }
      });

    } catch (error) {
      console.error(`[${this.name}] Error scraping MLB matches:`, error.message);
    }
    return matches;
  }

  async extractDirectM3u8(watchUrl) {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
    };

    try {
      // 1. Fetch match page
      const html = await axios.get(watchUrl, { headers, timeout: 8000 }).then(r => r.data).catch(() => null);
      if (!html) return null;

      const $ = cheerio.load(html);
      const iframeSrc = $('.player-container iframe').attr('src') || $('iframe').attr('src');
      if (!iframeSrc) return null;

      const playerUrl = iframeSrc.startsWith('//') ? `https:${iframeSrc}` : iframeSrc;

      // 2. Fetch player iframe page
      const playerHtml = await axios.get(playerUrl, {
        headers: { ...headers, Referer: watchUrl },
        timeout: 8000
      }).then(r => r.data).catch(() => null);

      if (!playerHtml) return { playerUrl };

      const $p = cheerio.load(playerHtml);
      const nestedIframe = $p('iframe').attr('src');
      const hlsEmbedUrl = nestedIframe
        ? (nestedIframe.startsWith('//') ? `https:${nestedIframe}` : nestedIframe.startsWith('http') ? nestedIframe : new URL(nestedIframe, playerUrl).toString())
        : playerUrl;

      // 3. Fetch HLS embed page if nested iframe exists
      let hlsHtml = playerHtml;
      if (hlsEmbedUrl !== playerUrl) {
        hlsHtml = await axios.get(hlsEmbedUrl, {
          headers: { ...headers, Referer: playerUrl },
          timeout: 8000
        }).then(r => r.data).catch(() => playerHtml);
      }

      // 4. Try to find m3u8 in hlsHtml directly
      let m3u8Match = hlsHtml.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i) ||
                      hlsHtml.match(/source:\s*["']([^"'\s]+\.m3u8[^"'\s]*)["']/i) ||
                      hlsHtml.match(/file:\s*["']([^"'\s]+\.m3u8[^"'\s]*)["']/i);

      if (m3u8Match && m3u8Match[1]) {
        return { playerUrl, hlsEmbedUrl, m3u8: m3u8Match[1] };
      }

      // 5. Try decrypt.php POST request if present
      const decryptMatch = hlsHtml.match(/input:\s*["']([^"']+)["']/i);
      if (decryptMatch && decryptMatch[1]) {
        const inputVal = decryptMatch[1];
        const decryptEndpoint = new URL('decrypt.php', hlsEmbedUrl).toString();

        const decryptRes = await axios.post(decryptEndpoint,
          new URLSearchParams({ input: inputVal }).toString(),
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Referer': hlsEmbedUrl,
              'User-Agent': headers['User-Agent']
            },
            timeout: 8000
          }
        ).then(r => r.data).catch(() => null);

        if (decryptRes && typeof decryptRes === 'string' && decryptRes.includes('.m3u8')) {
          return { playerUrl, hlsEmbedUrl, m3u8: decryptRes.trim() };
        }
      }

      return { playerUrl, hlsEmbedUrl };
    } catch (e) {
      console.warn(`[${this.name}] extractDirectM3u8 error for ${watchUrl}:`, e.message);
      return null;
    }
  }

  async resolveStream(sourceId, matchCategory, matchTitle) {
    const streams = [];
    const watchUrl = sourceId; // sourceId is the absolute game page URL (e.g. good.ltabasket.com)

    try {
      const extracted = await this.extractDirectM3u8(watchUrl);

      if (extracted && extracted.m3u8) {
        streams.push(new StreamEntity({
          name: 'Nuvio Direct',
          title: `MLB Live Stream ⚡`,
          url: extracted.m3u8,
          behaviorHints: {
            notWebReady: true,
            proxyHeaders: {
              request: {
                "Origin": "https://streame.center",
                "Referer": "https://streame.center/",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"
              }
            }
          },
          resolution: 'HD'
        }));
      }
    } catch (err) {
      console.warn(`[${this.name}] resolveStream failed:`, err.message);
    }

    return streams;
  }
}

module.exports = MlbElMundoProvider;
