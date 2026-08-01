import { createSegmentStream } from '../resolver/src/relay/segment.js';

async function runBenchmark() {
  const CHUNK_SIZE = 64 * 1024; // 64KB
  const NUM_CHUNKS = 1000; // 64MB buffer

  const startMem = process.memoryUsage().heapUsed;
  const startTime = Date.now();

  let maxMem = 0;

  const stream = createSegmentStream();
  let received = 0;

  stream.on('data', (chunk) => {
    received += chunk.length;
  });

  for (let i = 0; i < NUM_CHUNKS; i++) {
    const chunk = Buffer.alloc(CHUNK_SIZE);
    chunk.fill(0x00); // No 0x47 sync byte
    stream.write(chunk);
    
    const currentMem = process.memoryUsage().heapUsed;
    if (currentMem > maxMem) maxMem = currentMem;
  }

  // Push sync byte to flush
  const endChunk = Buffer.alloc(10);
  endChunk[0] = 0x47; // Sync byte
  stream.write(endChunk);
  stream.end();

  await new Promise(resolve => stream.on('end', resolve));

  const endTime = Date.now();
  const timeMs = endTime - startTime;
  const memUsedMB = (maxMem - startMem) / (1024 * 1024);
  console.log(`[Benchmark] Processed ${received} bytes.`);
  console.log(`[Benchmark] Time: ${timeMs} ms`);
  console.log(`[Benchmark] Peak Memory Growth: ${memUsedMB.toFixed(2)} MB`);
}

runBenchmark().catch(console.error);
