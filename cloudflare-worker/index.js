/**
 * Nuvio Live Sports - Cloudflare Worker Proxy
 * 
 * Instructions:
 * 1. Go to https://dash.cloudflare.com and sign up/log in.
 * 2. Go to "Workers & Pages" -> "Create Application" -> "Create Worker".
 * 3. Name it "nuvio-proxy" (or anything) and deploy.
 * 4. Click "Edit Code", paste this entire script, and click "Deploy".
 * 5. Copy your worker's URL (e.g., https://nuvio-proxy.yourname.workers.dev)
 * 6. Set this URL as the CF_PROXY_URL environment variable in your Nuvio deployment!
 */

export default {
  async fetch(request, env, ctx) {
    const reqUrl = new URL(request.url);
    
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Max-Age": "86400",
        }
      });
    }

    const action = reqUrl.searchParams.get('action');
    const referer = reqUrl.searchParams.get('referer');
    const origin = reqUrl.searchParams.get('origin');
    
    // Clone headers from the incoming request
    const newHeaders = new Headers(request.headers);
    if (referer) newHeaders.set('Referer', referer);
    if (origin) newHeaders.set('Origin', origin);
    
    // OVERWRITE User-Agent to ensure scraper and player exactly match for token binding
    newHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36');
    newHeaders.delete('Host');

    // --- EDGE SCRAPER FOR STREAMFREE ---
    // If the request is for streamfree, scrape the token on the edge so the IP matches!
    if (action === 'streamfree') {
      try {
        const embedUrl = reqUrl.searchParams.get('embedUrl');
        const streamId = reqUrl.searchParams.get('streamId');
        
        // Use clean headers for embed fetch - StreamFree blocks requests with Referer to embed pages
        const embedHeaders = new Headers();
        embedHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36');
        
        const embedRes = await fetch(embedUrl, { headers: embedHeaders });
        const html = await embedRes.text();
        const match = html.match(/const\s+_0x\s*=\s*(\{.*?\});/);
        if (!match) return new Response("Proxy Error: Could not find token", { status: 502 });
        
        const tokens = JSON.parse(match[1]);
        
        // FETCH STATUS to only pick qualities that are actually available
        let availableQualities = {};
        try {
            const statusRes = await fetch(`https://streamfree.top/api/stream-status/${streamId}`, { headers: embedHeaders });
            if (statusRes.ok) {
                const statusData = await statusRes.json();
                availableQualities = statusData.qualities || {};
            }
        } catch (e) {
            // Ignore status error
        }
        
        const prefs = ['1080p', '720p', '540p'];
        let bestQuality = null;
        let t = null;
        for (const q of prefs) {
          if (tokens[q] && availableQualities[q]) { bestQuality = q; t = tokens[q]; break; }
        }
        
        // Fallback in case status fetch failed
        if (!t) {
            for (const q of prefs) {
              if (tokens[q]) { bestQuality = q; t = tokens[q]; break; }
            }
        }
        
        if (!t) return new Response("Proxy Error: No stream qualities found", { status: 502 });

        const keyRes = await fetch(`https://streamfree.top/get-stream-key/${streamId}`, { headers: newHeaders });
        const keyData = await keyRes.json();
        let baseUrl = '';
        if (keyData && keyData.is_external && keyData.external_url) {
          baseUrl = keyData.external_url;
        } else {
          const serverName = (keyData && keyData.server_name) ? keyData.server_name : 'origin';
          if (serverName !== 'origin') {
            baseUrl = `https://streamfree.top/live-cdn/${streamId}${bestQuality}/index.m3u8`;
          } else {
            baseUrl = `https://streamfree.top/live/${streamId}${bestQuality}/index.m3u8`;
          }
        }
        
        const generatedTargetUrl = `${baseUrl}?_t=${t._t}&_e=${t._e}&_n=${t._n}`;
        reqUrl.searchParams.set('url', generatedTargetUrl);
        // Fall through to normal proxy logic
      } catch (err) {
        return new Response(`StreamFree Edge Scrape Error: ${err.message}`, { status: 502 });
      }
    }
    // -----------------------------------

    // --- EDGE SCRAPER FOR STREAMSPORTS99 ---
    if (action === 'streamsports99') {
      try {
        const playerUrl = reqUrl.searchParams.get('playerUrl');
        
        // Use clean headers - cdnlivetv.tv blocks requests with extra proxy headers
        const ss99Headers = new Headers();
        ss99Headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36');
        ss99Headers.set('Referer', 'https://streamsports99.fun/');
        
        const playerRes = await fetch(playerUrl, { headers: ss99Headers });
        const html = await playerRes.text();
        
        // Find the decoder function (contains atob)
        const decoderMatch = html.match(/function\s+([a-zA-Z0-9_]+)\s*\([a-zA-Z0-9_]+\)\s*\{.+?atob/);
        if (!decoderMatch) return new Response("SS99 Error: No decoder function found", { status: 502 });
        
        const decoderName = decoderMatch[1];
        
        // Find the concatenation line: var X = decoderName(A) + decoderName(B) + ...
        const concatRegex = new RegExp('var\\s+([a-zA-Z0-9_]+)\\s*=\\s*' + decoderName + '\\([^;]+;');
        const concatMatch = html.match(concatRegex);
        if (!concatMatch) return new Response("SS99 Error: No concat line found", { status: 502 });
        
        // Extract all variable names passed to the decoder
        const varRegex = new RegExp(decoderName + '\\(([a-zA-Z0-9_]+)\\)', 'g');
        let varMatch;
        const vars = [];
        while ((varMatch = varRegex.exec(concatMatch[0])) !== null) {
          vars.push(varMatch[1]);
        }
        
        // Decode each base64 variable and concatenate
        let m3u8Url = '';
        for (const v of vars) {
          const valMatch = html.match(new RegExp("var\\s+" + v + "\\s*=\\s*'([^']+)'"));
          if (valMatch && valMatch[1]) {
            let b64 = valMatch[1].replace(/-/g, '+').replace(/_/g, '/');
            while (b64.length % 4) b64 += '=';
            try { m3u8Url += atob(b64); } catch(e) {}
          }
        }
        
        if (!m3u8Url) return new Response("SS99 Error: Could not decode m3u8 URL", { status: 502 });
        
        reqUrl.searchParams.set('url', m3u8Url);
        // Update referer/origin for the stream fetch
        newHeaders.set('Referer', 'https://streamsports99.fun/');
        newHeaders.set('Origin', 'https://streamsports99.fun');
        // Fall through to normal proxy logic
      } catch (err) {
        return new Response(`SS99 Edge Scrape Error: ${err.message}`, { status: 502 });
      }
    }
    // -----------------------------------

    const targetUrl = reqUrl.searchParams.get('url');
    if (!targetUrl) {
      return new Response("Nuvio Cloudflare Proxy is running!", { 
        status: 200,
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }
    
    try {
      const response = await fetch(targetUrl, {
        method: request.method,
        headers: newHeaders,
        body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
        redirect: 'follow'
      });
      
      const responseHeaders = new Headers(response.headers);
      
      // Inject permissive CORS headers
      responseHeaders.set('Access-Control-Allow-Origin', '*');
      responseHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
      responseHeaders.set('Access-Control-Allow-Headers', '*');
      
      const contentType = responseHeaders.get('content-type') || '';
      const isM3u8 = contentType.includes('mpegurl') || contentType.includes('x-mpegURL') || targetUrl.includes('.m3u8');
      
      if (isM3u8 && request.method === 'GET') {
        const text = await response.text();
        const base = new URL(targetUrl);
        
        // Rewrite m3u8 URLs to point back to this worker
        const rewritten = text.split('\n').map(line => {
          const t = line.trim();
          if (!t) return line;
          
          if (t.startsWith('#')) {
            if (!t.includes('URI="')) return line;
            return t.replace(/URI="([^"]+)"/g, (_, uri) => {
              const absUrl = new URL(uri, base).href;
              const q = new URLSearchParams();
              q.set('url', absUrl);
              if (referer) q.set('referer', referer);
              if (origin) q.set('origin', origin);
              return `URI="${reqUrl.origin}/?${q.toString()}"`;
            });
          }
          
          const absUrl = new URL(t, base).href;
          const q = new URLSearchParams();
          q.set('url', absUrl);
          if (referer) q.set('referer', referer);
          if (origin) q.set('origin', origin);
          return `${reqUrl.origin}/?${q.toString()}`;
        }).join('\n');
        
        return new Response(rewritten, {
          status: response.status,
          headers: responseHeaders
        });
      } else if (targetUrl.includes('.key')) {
        responseHeaders.set('Content-Type', 'application/octet-stream');
      } else {
        // Force video/mp2t for chunks (StreamFree hides them as .js which breaks mobile players)
        responseHeaders.set('Content-Type', 'video/mp2t');
      }
      
      // For video chunks (.ts, .js) and everything else, return the stream directly
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders
      });

    } catch (err) {
      return new Response(`Proxy Error: ${err.message}`, { 
        status: 502,
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }
  }
};

// Trigger deployment

// Trigger deployment 2

// Trigger deployment 3
