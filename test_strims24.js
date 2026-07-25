const container = require('./src/container');

async function testStrims24() {
    console.log("--- Testing Strims24Provider ---");
    const provider = container.resolve('strims24Provider');
    
    console.log(`Provider name: ${provider.name}`);
    console.log("Fetching matches...");
    const matches = await provider.getMatches();
    
    console.log(`Found ${matches.length} matches.`);
    
    if (matches.length > 0) {
        console.log("\nSample Match:");
        const match = matches[0];
        console.log(`  ID: ${match.id}`);
        console.log(`  Title: ${match.title}`);
        console.log(`  Category: ${match.category}`);
        console.log(`  Date: ${new Date(parseInt(match.date)).toISOString()}`);
        console.log(`  League: ${match.league}`);
        console.log(`  Source: ${match.sources[0].source}`);
        
        console.log("\nResolving streams for the sample match...");
        const streams = await provider.resolveStream(match.sources[0].id, match.category, match.title);
        
        console.log(`Found ${streams.length} stream(s):`);
        streams.forEach((s, idx) => {
            console.log(`\n  Stream ${idx + 1}:`);
            console.log(`    Name: ${s.name}`);
            console.log(`    Title: ${s.title}`);
            console.log(`    URL: ${s.url}`);
        });
    } else {
        console.log("No matches found to resolve streams for.");
    }
    console.log("\n--- Test Complete ---");
}

testStrims24().catch(console.error);
