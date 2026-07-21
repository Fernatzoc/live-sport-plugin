/**
 * manifest.js — Stremio / Nuvio Addon Manifest (iptv-org edition)
 *
 * Single catalog: all free live sports channels from iptv-org,
 * with a search catalog so users can filter by channel name.
 */

const { addonBuilder } = require('stremio-addon-sdk');

const manifest = {
  id: 'community.nuvio.live-sports',
  version: '2.1.0',
  name: '📡 Live Sports TV',
  description:
    'Free live sports TV channels — beIN Sports, Eurosport, Alkass, ESPN & more. ' +
    'Direct HLS streams, plays natively inside Nuvio. Powered by iptv-org.',
  logo: 'https://iptv-org.github.io/iptv/categories/sports.m3u',

  types: ['tv'],
  resources: ['catalog', 'meta', 'stream'],

  catalogs: [
    { type: 'tv', id: 'nuvio_sports_live', name: '🔴 Live Now', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_football', name: '⚽ Soccer', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_cricket', name: '🏏 Cricket', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_motorsport', name: '🏎️ F1 & Motor', extra: [{ name: 'search', isRequired: false }] },
    { 
      type: 'tv', 
      id: 'nuvio_sports_other', 
      name: '🏅 Other Sports', 
      extra: [
        { name: 'search', isRequired: false },
        { name: 'genre', options: ['Basketball', 'MMA', 'Golf', 'Tennis', 'Rugby', 'American Football', 'Baseball', 'Hockey', 'Darts', 'Other'], isRequired: false }
      ] 
    },
    { type: 'tv', id: 'nuvio_sports_networks', name: '📺 24/7 Sports TV', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_upcoming', name: '⏱️ Upcoming', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_rojadirecta', name: '🔴 Rojadirecta', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_mlbelmundo', name: '⚾ MLB El Mundo', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_teams', name: '⭐ Your Teams', extra: [{ name: 'search', isRequired: false }] }
  ],

  config: [
    { key: 'teams', title: 'Favorite Teams (comma separated)', type: 'text' },
    { key: 'sports', title: 'Enabled Sports (comma separated)', type: 'text', default: 'all' }
  ],

  idPrefixes: ['nuvio_sport_'],

  behaviorHints: {
    adult: false,
    p2p: false,
    configurable: true
  },
};

const builder = new addonBuilder(manifest);

module.exports = { builder, manifest };
