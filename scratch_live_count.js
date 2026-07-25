const container = require('./src/container');

async function checkLive() {
    const aggregator = container.resolve('matchAggregator');
    console.log("Fetching matches from all providers...");
    
    // getMatches usually aggregates all matches from all providers
    const matches = await aggregator.getMatches();
    
    const now = Date.now();
    // In our system, a match is live if its start date is in the past (or within the live window).
    // Let's assume a match is live if its date is <= now and date > now - 4*60*60*1000 (4 hours)
    const liveMatches = matches.filter(m => {
        const startTs = parseInt(m.date);
        return startTs <= now && startTs > now - (4 * 60 * 60 * 1000);
    });

    console.log(`Total Matches (all providers): ${matches.length}`);
    console.log(`Total Live Matches (started within last 4 hours): ${liveMatches.length}`);

    console.log("Resolving streams for live matches to count direct streams...");
    let directStreamCount = 0;
    let totalStreams = 0;

    // To prevent taking too long, we can batch resolve or resolve one by one
    // But since it's just a count, we can do it.
    for (const match of liveMatches) {
        // Resolve streams for all sources in the match
        for (const source of match.sources) {
            // Find the provider for this source
            const providerName = source.source + 'Provider';
            let provider;
            try {
                // Not all sources map directly to a provider name, some might be yaml providers
                // the aggregator handles this internally via getMatchStreams, but let's use the aggregator's method if it has one
            } catch(e) {}
        }
    }
}

// Instead of doing it manually, let's check if aggregator has a method to get streams.
// Usually the API endpoint /api/match/:id handles it. Let's look at `api.js` or `MatchAggregator.js`
