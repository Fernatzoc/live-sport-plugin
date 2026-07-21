const { createContainer, asClass, asValue, InjectionMode } = require('awilix');

const CacheService = require('./services/CacheService');
const CircuitBreakerService = require('./services/CircuitBreakerService');
const CronService = require('./services/CronService');
const M3U8ParserService = require('./services/M3U8ParserService');
const MatchAggregator = require('./services/MatchAggregator');
const StreamScoringService = require('./services/StreamScoringService');

const fs = require('fs');
const path = require('path');
const YamlProviderBuilder = require('./services/YamlProviderBuilder');

const container = createContainer({
  injectionMode: InjectionMode.PROXY
});

// Register Core Services
container.register({
  cacheService: asClass(CacheService).singleton(),
  circuitBreaker: asClass(CircuitBreakerService).singleton(),
  m3u8Parser: asClass(M3U8ParserService).singleton(),
  cronService: asClass(CronService).singleton(),
  matchAggregator: asClass(MatchAggregator).singleton(),
  streamScorer: asClass(StreamScoringService).singleton()
});

// Build dynamic YAML Providers
const yamlBuilder = new YamlProviderBuilder();
const yamlProviders = yamlBuilder.buildProviders(container, container.resolve('circuitBreaker'));

// Dynamically load and register JS Providers
const providersDir = path.join(__dirname, 'providers');
const providerFiles = fs.readdirSync(providersDir).filter(f => f.endsWith('.js') && f !== 'BaseProvider.js');

const providerRegistrations = {};
const jsProviderKeys = [];
providerFiles.forEach(file => {
  const providerClass = require(path.join(providersDir, file));
  const providerName = file.replace('.js', '');
  const camelCaseName = providerName.charAt(0).toLowerCase() + providerName.slice(1);
  providerRegistrations[camelCaseName] = asClass(providerClass).singleton();
  jsProviderKeys.push(camelCaseName);
});

container.register(providerRegistrations);
container.register({
  jsProvidersList: asValue(jsProviderKeys),
  yamlProviders: asValue(yamlProviders)
});

module.exports = container;
