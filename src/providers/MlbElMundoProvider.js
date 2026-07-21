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
            sources: [{ source: 'mlbelmundo', id: href, url: href }]
          }));
        }
      });

    } catch (error) {
      console.error(`[${this.name}] Error scraping MLB matches:`, error.message);
    }
    return matches;
  }

  async resolveStream(sourceId, matchCategory, matchTitle) {
    const streams = [];
    const watchUrl = sourceId; // sourceId is the absolute game page URL (e.g. good.ltabasket.com)

    try {
      // 1. Fetch the match page (e.g., good.ltabasket.com)
      const html = await this.fetchData.fire(watchUrl);
      if (html) {
        const $ = cheerio.load(html);
        const iframeSrc = $('.player-container iframe').attr('src');
        
        if (iframeSrc) {
          const playerUrl = iframeSrc.startsWith('//') ? `https:${iframeSrc}` : iframeSrc;
          
          streams.push(new StreamEntity({
            name: 'Nuvio Web Player',
            title: `MLB Live Stream ⚾`,
            externalUrl: `${BASE_URL}/watch?url=${encodeURIComponent(playerUrl)}&title=${encodeURIComponent(matchTitle || 'MLB Live Game')}`
          }));
          
          return streams;
        }
      }
    } catch (err) {
      console.warn(`[${this.name}] resolveStream iframe extraction failed:`, err.message);
    }

    // Fallback: If extraction fails, point to the top-level match page inside /watch
    streams.push(new StreamEntity({
      name: 'Nuvio Web Player',
      title: `MLB Live Stream ⚾`,
      externalUrl: `${BASE_URL}/watch?url=${encodeURIComponent(watchUrl)}&title=${encodeURIComponent(matchTitle || 'MLB Live Game')}`
    }));

    return streams;
  }
}

module.exports = MlbElMundoProvider;
