const container = require('./container');
const { BASE_URL } = require('./config');

async function handleStream(type, id, config) {
  if (type !== 'tv' || !id.startsWith('nuvio_sport_')) {
    return { streams: [] };
  }

  const matchId = id.replace('nuvio_sport_', '');
  
  const cacheService = container.resolve('cacheService');
  const matches = cacheService.getMatches();
  const match = matches.find(m => m.id === matchId);

  if (!match || !match.sources || match.sources.length === 0) {
    return { streams: [] };
  }

  const streams = [];

  const SOURCE_PRIORITY = { admin: 1, echo: 1, golf: 1, delta: 1, 'watchfooty': 2, 'cdnlive': 3, 'streamsports99': 4, 'streamic': 5, 'ppvdomains': 6, 'strims24': 7, 'streamfree': 8, 'timstreams': 9, 'bintv': 10, 'ntv': 11, 'sportyhunter': 12, 'streamsports': 13, 'iptv-org': 14 };
  const sortedSources = [...match.sources].sort((a, b) => {
    // If a source isn't in the list, but it's not one of our known fallback providers, 
    // it's likely a new Streamed.pk source. Give it priority 1.5 so it stays near the top.
    const getPriority = (src) => SOURCE_PRIORITY[src] ?? (['watchfooty', 'cdnlive', 'streamsports99', 'streamic', 'ppvdomains', 'strims24', 'streamfree', 'timstreams', 'bintv', 'ntv', 'sportyhunter', 'streamsports', 'iptv-org'].includes(src) ? 99 : 1.5);
    const pa = getPriority(a.source);
    const pb = getPriority(b.source);
    if (pa !== pb) return pa - pb;
    if (a.source === 'bintv' && b.source === 'bintv') {
      const aIsDirect = a.url && (a.url.includes('.m3u8') || (a.url.includes('noooooads/?src=') && a.url.includes('.m3u8')));
      const bIsDirect = b.url && (b.url.includes('.m3u8') || (b.url.includes('noooooads/?src=') && b.url.includes('.m3u8')));
      if (aIsDirect && !bIsDirect) return -1;
      if (!aIsDirect && bIsDirect) return 1;
    }
    return 0;
  });

  const m3u8Parser = container.resolve('m3u8Parser');
  const streamScorer = container.resolve('streamScorer');

  const registeredJSProviders = (container.resolve('jsProvidersList') || []).map(k => k.replace('Provider', '').toLowerCase());
  const KNOWN_FALLBACKS = [...registeredJSProviders, 'iptv-org', 'iptv-org'.replace('-', '')];

  let activeSources = sortedSources;
  if (config && config.sources && config.sources !== 'none') {
    const enabled = config.sources.split(',');
    activeSources = sortedSources.filter(src => {
      if (src.source.startsWith('yaml_')) return true;
      const isFallback = KNOWN_FALLBACKS.includes(src.source.replace(/[^a-zA-Z0-9]/g, ''));
      if (isFallback) {
        return enabled.includes(src.source);
      }
      return false;
    });
  } else {
    activeSources = sortedSources.filter(src => {
      if (src.source.startsWith('yaml_')) return true;
      return KNOWN_FALLBACKS.includes(src.source.replace(/[^a-zA-Z0-9]/g, ''));
    });
  }

  const resolvePromises = activeSources.map(async (src) => {
    const sourceName = src.source;
    let resStreams = [];

    try {
      const registeredKeys = container.resolve('jsProvidersList') || [];
      const matchKey = registeredKeys.find(k => k.toLowerCase() === `${sourceName.replace(/[^a-zA-Z0-9]/g, '')}provider`);

      if (matchKey) {
        const provider = container.resolve(matchKey);
        const category = src.original_category || match.category;
        resStreams = await provider.resolveStream(src.id, category, match.title, src);
        for (const s of resStreams) {
          if (s.url && s.url.startsWith('/api/hls') && !s.url.startsWith('http')) {
            s.url = `${BASE_URL}${s.url}`;
          }
        }
      } else if (sourceName === 'iptv-org') {
        resStreams = [{
          name: 'Nuvio Direct',
          title: `24/7 TV (${src.quality || 'Auto'})`,
          url: src.url,
          resolution: src.quality
        }];
      } else {
        resStreams = [];
      }

      for (const s of resStreams) {
        s.score = streamScorer.calculateScore(s, sourceName);
        s._source = sourceName;
      }
    } catch (e) {
      console.warn(`[streams.js] Error resolving ${sourceName} for ${src.id}:`, e.message);
    }
    
    return resStreams;
  });

  const results = await Promise.allSettled(resolvePromises);
  for (const result of results) {
    if (result.status === 'fulfilled' && Array.isArray(result.value)) {
      streams.push(...result.value);
    }
  }

  // --- Inject relevant 24/7 channels based on category ---
  const isStreamFreeEnabled = !config || !config.sources || config.sources === 'none' || config.sources.split(',').includes('streamfree');
  if (match.category === 'cricket' && isStreamFreeEnabled) {
    const sfProvider = container.resolve('streamFreeProvider');
    try {
      const extraChannels = [
        { id: 'willow', title: 'Willow TV' },
        { id: 'skycricket', title: 'Sky Sports Cricket' }
      ];
      
      for (const channel of extraChannels) {
        // Only add if not already present somehow
        const resolved = await sfProvider.resolveStream(channel.id, 'cricket', channel.title);
        for (const s of resolved) {
          if (s.url && s.url.startsWith('/api/hls')) {
            s.url = `${BASE_URL}${s.url}`;
          }
          s.score = streamScorer.calculateScore(s, 'streamfree');
          s._source = 'streamfree';
          streams.push(s);
        }
      }
    } catch (e) {
      console.warn('[streams.js] Error injecting 24/7 cricket channels:', e.message);
    }
  }

  // Standardize Stream Labels
  const sportIcons = {
    football: '⚽', cricket: '🏏', motorsport: '🏎️',
    basketball: '🏀', american_football: '🏈', rugby: '🏉', networks: '📺'
  };
  const icon = sportIcons[match.category] || '📡';
  
  const niceNames = {
    streamfree: 'StreamFree', timstreams: 'TimStreams', bintv: 'BinTV',
    ntv: 'NTV', sportyhunter: 'SportyHunter', streamsports: 'StreamSports',
    'iptv-org': 'Direct IPTV', 'streamsports99': 'StreamSports99',
    'ppvdomains': 'PPV Domains', 'streamic': 'Streamic', 'strims24': 'Strims24',
    mlbelmundo: 'MLB El Mundo'
  };

  streams.forEach(s => {
    let quality = s.resolution || s.quality || 'Auto';
    if (quality.includes('x')) {
       const h = quality.split('x')[1];
       quality = h + 'p';
    }
    
    const isWeb = !!s.externalUrl || s.name === 'Nuvio Web Player';
    // The scorer attached the sourceName as _source in calculateScore? No, we didn't attach it.
    // Wait, streamScorer doesn't attach sourceName to s.
    // I can determine providerName from the string it already had.
    let providerName = niceNames[s._source] || niceNames[Object.keys(niceNames).find(k => s.title && s.title.toLowerCase().includes(k))] || 'Streamed.pk';
    
    if (s.title && s.title.toLowerCase().includes('timstreams')) providerName = 'TimStreams';
    else if (s.title && s.title.toLowerCase().includes('bintv')) providerName = 'BinTV';
    else if (s.title && s.title.toLowerCase().includes('ntv')) providerName = 'NTV';
    else if (s.title && s.title.toLowerCase().includes('sporty')) providerName = 'SportyHunter';
    else if (s.title && s.title.toLowerCase().includes('streamfree')) providerName = 'StreamFree';
    else if (s.title && s.title.toLowerCase().includes('watchfooty')) providerName = 'WatchFooty';
    else if (s.title && s.title.toLowerCase().includes('cdnlive')) providerName = 'CDNLiveTV';
    else if (s.title && s.title.toLowerCase().includes('streamsports99')) providerName = 'StreamSports99';
    else if (s.title && s.title.toLowerCase().includes('ppv domains')) providerName = 'PPV Domains';
    else if (s.title && s.title.toLowerCase().includes('streamic')) providerName = 'Streamic';
    else if (s.title && s.title.toLowerCase().includes('strims24')) providerName = 'Strims24';
    else if (s.title && s.title.toLowerCase().includes('mlbelmundo') || (s.title && s.title.toLowerCase().includes('mlb live stream'))) providerName = 'MLB El Mundo';
    else if (s.title && s.title.toLowerCase().includes('24/7')) providerName = 'Direct IPTV';

    let originalTitle = s.title || '';
    let channelName = '';
    if (originalTitle) {
      const match = originalTitle.match(/\(([^)]+)\)/);
      if (match && match[1]) {
        const inner = match[1];
        if (!inner.match(/^[0-9]{3,4}p$/i) && inner !== 'Auto' && !inner.toLowerCase().startsWith('stream')) {
          channelName = inner;
        }
      } else if (!originalTitle.includes('Stream') && !originalTitle.includes('Auto')) {
        channelName = originalTitle;
      }
    }
    // Determine Group
    s.name = isWeb ? '🌐 Web Stream' : '⚡ Direct Stream';
    
    if (channelName) {
      channelName = channelName.split(/[ _-]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ').trim();
    }
    
    const channelDisplay = channelName ? ` | 📺 ${channelName}` : '';
    s.title = `${icon} ${providerName}${channelDisplay}\n⚙️ Quality: ${quality}`;
    
    // Add behaviorHints to group streams and handle CORS for direct streams
    s.behaviorHints = s.behaviorHints || {};
    s.behaviorHints.bingeGroup = `nuvio_sport_${matchId}`;
    
    // If it's a direct m3u8 stream and not routed through our proxy, mark it notWebReady
    if (s.url && s.url.includes('.m3u8') && !s.url.includes('/api/hls')) {
      if (providerName !== 'Direct IPTV') {
        s.behaviorHints.notWebReady = true;
      }
      
      let referer = '';
      if (providerName === 'Streamed.pk') referer = 'https://embed.st/';
      else if (providerName === 'WatchFooty') referer = 'https://watchfooty.st/';
      else if (providerName === 'CDNLiveTV') referer = 'https://cdnlivetv.tv/';
      else if (providerName === 'Streamic') referer = 'https://streamic.st/';
      else if (providerName === 'PPV Domains' || providerName === 'BinTV') referer = 'https://ppv.st/';
      else if (providerName === 'StreamSports99' || providerName === 'StreamSports') referer = 'https://cdnlivetv.is/';
      else if (providerName === 'SportyHunter') referer = 'https://sportyhunter.xyz/';
      
      if (referer) {
        s.behaviorHints.proxyHeaders = {
          request: {
            "Referer": referer,
            "Origin": referer
          }
        };
      }
    }
    
    // Add extra info if present
    if (providerName === 'Direct IPTV' && s.url) {
      s.title = `📺 ${channelName || '24/7 Live Network'}\n⚙️ Quality: ${quality}`;
    }
  });

  // Sort streams: Direct streams first, then by score descending
  streams.sort((a, b) => {
    const aIsDirect = a.name === '⚡ Direct Stream' ? 1 : 0;
    const bIsDirect = b.name === '⚡ Direct Stream' ? 1 : 0;
    if (aIsDirect !== bIsDirect) return bIsDirect - aIsDirect;
    return b.score - a.score;
  });

  // Return streams with cacheMaxAge: 0 to force Nuvio to fetch a fresh token every time!
  return { 
    streams, 
    cacheMaxAge: 0, 
    staleRevalidate: 0, 
    staleError: 0 
  };
}

module.exports = {
  handleStream
};
