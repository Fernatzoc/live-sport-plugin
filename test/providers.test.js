const nock = require('nock');
const StreamFreeProvider = require('../src/providers/StreamFreeProvider');
const CircuitBreakerService = require('../src/services/CircuitBreakerService');

describe('StreamFreeProvider', () => {
  let provider;

  beforeEach(() => {
    nock.cleanAll();
    const circuitBreaker = new CircuitBreakerService();
    provider = new StreamFreeProvider({ circuitBreaker });
  });

  test('getMatches() handles valid JSON correctly', async () => {
    // Mock the HTTP response from streamfree.top
    nock('https://streamfree.top')
      .get('/streams')
      .reply(200, {
        streams: {
          football: [
            {
              id: "man_utd_vs_arsenal",
              name: "Manchester United vs Arsenal",
              match_timestamp: 1700000000,
              viewers: 500,
              league: "Premier League",
              team1: { name: "Man Utd" },
              team2: { name: "Arsenal" }
            }
          ]
        }
      });

    const matches = await provider.getMatches();
    
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe('man_utd_vs_arsenal');
    expect(matches[0].title).toBe('Manchester United vs Arsenal');
    expect(matches[0].category).toBe('football');
    expect(matches[0].popular).toBe('1'); // Because viewers > 100
  });

  test('getMatches() handles empty/malformed responses without crashing', async () => {
    nock('https://streamfree.top')
      .get('/streams')
      .reply(500, "Internal Server Error");

    const matches = await provider.getMatches();
    
    // Should return empty array gracefully via circuit breaker / try-catch
    expect(matches).toHaveLength(0);
  });
});

const MlbElMundoProvider = require('../src/providers/MlbElMundoProvider');

describe('MlbElMundoProvider', () => {
  let provider;

  beforeEach(() => {
    nock.cleanAll();
    const circuitBreaker = new CircuitBreakerService();
    provider = new MlbElMundoProvider({ circuitBreaker });
  });

  test('getMatches() parses matches from HTML', async () => {
    const mockHtml = `
      <a class="match-card-link" href="https://good.ltabasket.com/m-day-1.php">
        <section class="match-card" data-team1="Yankees" data-team2="Red Sox" data-date="2026-07-25" data-time="19:00">
          <div class="team-left">Yankees</div>
          <div class="team-right">Red Sox</div>
        </section>
      </a>
    `;

    nock('https://www.elmundodelasmayores.com')
      .get('/partidosmlb/')
      .reply(200, mockHtml);

    const matches = await provider.getMatches();
    expect(matches).toHaveLength(1);
    expect(matches[0].title).toBe('MLB: Yankees vs Red Sox');
    expect(matches[0].category).toBe('baseball');
    expect(matches[0].sources[0].id).toBe('https://good.ltabasket.com/m-day-1.php');
  });

  test('resolveStream() extracts direct m3u8 stream and preserves web player fallback', async () => {
    nock('https://good.ltabasket.com')
      .get('/m-day-1.php')
      .reply(200, '<div class="player-container"><iframe src="https://streame.center/embed/ch15.php"></iframe></div>');

    nock('https://streame.center')
      .get('/embed/ch15.php')
      .reply(200, '<iframe src="https://streame.center/embed/hls.php?stream=ch15"></iframe>');

    nock('https://streame.center')
      .get('/embed/hls.php?stream=ch15')
      .reply(200, '<script>fetch("decrypt.php", { body: new URLSearchParams({ input: "abc123secret" }) });</script>');

    nock('https://streame.center')
      .post('/embed/decrypt.php', 'input=abc123secret')
      .reply(200, 'https://edgestream1.pro/hls/ch15.m3u8?st=token');

    const streams = await provider.resolveStream('https://good.ltabasket.com/m-day-1.php', 'baseball', 'MLB: Yankees vs Red Sox');

    expect(streams).toHaveLength(2);
    expect(streams[0].name).toBe('Nuvio Direct');
    expect(streams[0].url).toContain('/api/hls?url=https%3A%2F%2Fedgestream1.pro%2Fhls%2Fch15.m3u8');
    expect(streams[1].name).toBe('Nuvio Web Player');
    expect(streams[1].externalUrl).toBeDefined();
  });
});
