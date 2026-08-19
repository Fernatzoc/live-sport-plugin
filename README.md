# 🔴 Nuvio Live Sports Plugin (Test README)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/rajhodedara/live-sport-plugin)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-3.0.0-brightgreen.svg)](#)

A production-grade live sports streaming add-on for [Nuvio](https://nuvio.tv) and [Stremio](https://www.stremio.com/). It serves as a powerful multi-source aggregator that provides native live sports streams (Football, Basketball, Motorsport, Cricket, and more) inside your client, utilizing an advanced internal stream resolver to bypass CORS restrictions.

---

## ✨ Key Features

- **🏟️ Multi-Source Aggregator:** Combines matches and streams from multiple sources (StreamFree, Streamed.pk, BinTV, TimStreams, SportyHunter, NTV, iptv-org) into a unified catalog.
- **⚡ Background Cron Caching:** Uses Stale-While-Revalidate (SWR) caching with an internal background Cron Service to ensure instant loading without hammering provider APIs.
- **🛡️ Opossum Circuit Breakers:** Provider requests are isolated via circuit breakers to instantly fail-over if a streaming site goes down.
- **🧠 Algorithmic Stream Scoring:** Prioritizes high-resolution direct `.m3u8` links over external web players.
- **🌐 Built-in Stream Resolver:** Spawns a secondary proxy process (`resolver`) to bypass CORS and referrer restrictions natively.
- **📡 WebRTC P2P Mesh Network:** Integrates P2P sharing in the fallback Web Player (`/watch`) to handle massive concurrent traffic dynamically.
- **⚙️ Dynamic Configuration:** Features a beautiful local configuration page to curate your favorite sports and teams.
- **🏗️ Zero-Code YAML Scrapers:** Add new streaming sources instantly using CSS selectors in YAML.

---

## 🛠️ Tech Stack

- **Runtime:** [Node.js](https://nodejs.org/) (v22+)
- **Framework:** [Express.js](https://expressjs.com/)
- **Scraping & DOM:** [Cheerio](https://cheerio.js.org/), [Happy DOM](https://github.com/capricorn86/happy-dom)
- **Dependency Injection:** [Awilix](https://github.com/jeffijoe/awilix)
- **Resilience:** [Opossum](https://nodeshift.dev/opossum/) (Circuit Breakers)
- **Addon SDK:** [stremio-addon-sdk](https://github.com/Stremio/stremio-addon-sdk)
- **Proxying:** http-proxy-middleware
- **Testing:** Jest
- **Deployment**: Render.com, Alwaysdata, Docker

---

## 📋 Prerequisites

Before setting up the project locally, make sure you have:
- **Node.js**: Version 22.0.0 or higher
- **npm**: Installed with Node.js
- **Git**: For version control

---

## 🚀 Getting Started

### 1. Clone the Repository
```bash
git clone https://github.com/rajhodedara/live-sport-plugin.git
cd live-sport-plugin
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Environment Setup
Copy the example environment file:
```bash
cp .env.example .env
```

Configure the following variables in `.env`:
| Variable | Description | Default |
| --- | --- | --- |
| `PORT` | Port the addon server will listen on | `7000` |
| `RESOLVER_PORT` | Port for the internal stream resolver process | `7003` |
| `BASE_URL` | Base URL of the deployed application | `http://localhost:7000` |
| `LOW_MEMORY_MODE` | Enable low memory resource constraints if true | `false` |

### 4. Start Development Server
Run the project in development mode with automatic reload:
```bash
npm run dev
```

### 5. Build for Production
Compiles the application using Vercel NCC:
```bash
npm run build
npm start
```

---

## 📂 Architecture Overview

### Directory Structure
```
├── src/
│   ├── domain/               # Domain Entities
│   │   ├── MatchEntity.js    # Representation of a sports match event
│   │   └── StreamEntity.js   # Representation of a stream link/endpoint
│   ├── providers/            # Scrapers and APIs providers
│   │   ├── BaseProvider.js   # Base class for all scraper providers
│   │   ├── yaml/             # Zero-code YAML-based provider definitions
│   │   └── *Provider.js      # Individual scraping providers (StreamFree, BinTv, etc.)
│   ├── services/             # Core business logic container services
│   │   ├── CacheService.js   # In-memory Stale-While-Revalidate cache
│   │   ├── CronService.js    # Periodically triggers catalog updates
│   │   ├── MatchAggregator.js# Merges matches and handles fuzzy deduplication
│   │   ├── StreamScoringService.js # Scores/ranks available streams
│   │   └── YamlProviderBuilder.js  # Dynamically compiles YAML scrapers
│   ├── index.js              # Entry point of the Express server
│   ├── manifest.js           # Stremio Addon manifest definition
│   ├── api.js                # Addon routes handlers
│   └── container.js          # Awilix dependency injection setup
├── resolver/                 # Standalone reverse-proxy app to bypass HLS CORS
│   └── src/                  # Resolver source code (uses ES Modules)
│       └── server.js         # Entry point for the CORS resolver server
├── public/                   # Static dashboard & configuration page
├── scripts/                  # Command line automation scripts
└── test/                     # Unit and integration test suites
```

### Internal Data Flow & CORS Bypass (The Magic)
```
User Match Request ──> Express Server (catalog) ──> Fetch Match details & Embed Link
                                                              │
                                                              ▼
Nuvio Player <── [proxy url] <── Return Proxy Stream URL <── Decrypt & Extract raw .m3u8
    │
    ▼ (fetch segment)
Resolver Proxy (spawns on port 7003) ──[spoof Referer/Origin]──> Provider CDN
    │                                                                   │
    └────────────────── Passes HLS chunks back natively ───────────────┘
```

### ⚙️ How the Addon Works Internally

1. **Catalog Construction & Fuzzy Match Merging**:
   A background cron service periodically queries all active scraping APIs and website providers (e.g., StreamFree, BinTV, Streamed.pk). It normalizes titles/times and uses fuzzy matching algorithms in [`MatchAggregator`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/services/MatchAggregator.js) to deduplicate identical fixtures, keeping them in an in-memory SWR (Stale-While-Revalidate) cache.

2. **Stream Retrieval & Obfuscation Decryption**:
   When the user opens a match event in Nuvio/Stremio, the app queries the provider pages to locate where the video is embedded. Since providers obscure their streams, the addon runs automated parsing and decryption rules:
   * **TimStreams XOR Decryption**: In [`TimStreamsProvider.js`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/providers/TimStreamsProvider.js), the embed HTML containing a script block in the format `var XXXX=[nums],YYYY=key1,ZZZZ=key2` is parsed. The script is decoded at runtime via `(char_code ^ key1 - key2 + 256) % 256` to construct the true JavaScript string, revealing the hidden `.m3u8` source URL.
   * **StreamFree Token Extraction**: In [`StreamFreeProvider.js`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/providers/StreamFreeProvider.js), security tokens are regex-extracted from Javascript object configurations (`const _0x = {...};`). These tokens (`_t`, `_e`, `_n`) are then appended as query parameters to authorize access to the CDN stream URL.

3. **CORS and Referrer Bypass (The Proxy Resolver)**:
   CDNs for sport streams usually block external players using `Referer` or `Origin` header validation (returning `403 Forbidden`). To bypass this, the main Express server spawns a local HTTP proxy process ([`resolver`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/resolver/src/server.js)). Instead of returning the raw stream URL directly to the user's player, the app returns a local proxy URL route pointing to this resolver.

4. **Segment Relay**:
   When the video player requests the stream segments (`.ts` chunks) from the resolver:
   * The resolver sends requests to the provider CDN using spoofed headers (attaching fake referrer and origin headers corresponding to the provider's host).
   * It intercepts the incoming payload and pipes the clean video chunks directly to the player in real-time, bypassing any client-side CORS policies.

---

## 🎛️ Configuration Options

Through the local `/configure` UI, you can append a base64/URI-encoded configuration object to the addon URL:
- **sports:** Comma-separated list of enabled sports categories (e.g., `football,basketball,cricket`). Defaults to `all`.
- **teams:** Comma-separated list of favorite teams (e.g., `Arsenal,Lakers`). These populate the "⭐ Your Teams" catalog.

---

## ⚙️ Available Scripts

The following npm scripts are defined in `package.json`:

| Command | Action |
| --- | --- |
| `npm start` | Runs the compiled bundle in production (`node dist/index.js`). |
| `npm run dev` | Runs the addon server in watch mode with native live reload. |
| `npm run build` | Compiles the server codebase into a single minified bundle inside `/dist`. |
| `npm test` | Runs the test suite via Jest. |
| `npm run generate:provider` | Runs scaffold utility script to generate a boilerplate YAML provider. |
| `npm run check-sources` | Evaluates the live availability of the external scraper provider APIs. |

---

## 🧪 Testing

The project uses **Jest** for unit and integration testing.

```bash
# Run all tests
npm test

# Run tests in watch mode
npm test -- --watch
```

---

## ☁️ Deployment Instructions

### Option 1: Render.com (Recommended for One-Click)
This project is configured for deployment on Render.com using the `render.yaml` blueprint.
1. Push your repository to GitHub.
2. Link your repo to Render and create a new **Web Service**.
3. Render automatically sets up the environment and launches both the Express server and the child resolver process.

