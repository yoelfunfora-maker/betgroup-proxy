const express = require('express');
const cors = require('cors');
const https = require('https');
const axios = require('axios');
const admin = require('firebase-admin');

// Inicializar Firebase Admin
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_B64 
  ? Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf-8')
  : process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.database();

const app = express();
app.use(cors());
app.use(express.json());

// ==================== CONFIGURACIÓN ====================
const ODDS_API_KEYS = [
  process.env.ODDS_API_KEY_1 || '',
  process.env.ODDS_API_KEY_2 || ''
].filter(Boolean);
const ODDS_API_HOST = 'https://api.the-odds-api.com/v4';
let _turnoActual = 0;

// ==================== CACHÉ ====================
const cache = {};
const CACHE_TTL = 3 * 60 * 1000;
function getCache(key) {
  const entry = cache[key];
  if (entry && Date.now() - entry.timestamp < CACHE_TTL) return entry.data;
  return null;
}
function setCache(key, data) {
  cache[key] = { data, timestamp: Date.now() };
}

// ==================== HELPER ESPN ====================
function fetchESPN(path) {
  return new Promise((resolve, reject) => {
    https.request({
      hostname: 'site.api.espn.com',
      path: `/apis/site/v2/sports/${path}`,
      method: 'GET',
      headers: { 'User-Agent': 'BetGroupPro/7.5', 'Accept': 'application/json' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('ESPN parse error')); }
      });
    }).on('error', reject).setTimeout(8000, function() { this.destroy(); reject(new Error('ESPN timeout')); }).end();
  });
}

// ==================== PARSER ESPN ====================
function parseEvents(espnData, sport) {
  const events = [];
  if (!espnData || !espnData.events) return events;
  for (const ev of espnData.events) {
    try {
      const comp = ev.competitions?.[0];
      if (!comp) continue;
      const home = comp.competitors?.find(c => c.homeAway === 'home');
      const away = comp.competitors?.find(c => c.homeAway === 'away');
      if (!home || !away) continue;
      const status = ev.status?.type;
      if (!status || (status.state !== 'in' && status.state !== 'pre')) continue;
      events.push({
        id: ev.id,
        sport,
        liga: espnData.leagues?.[0]?.name || sport,
        ligaLogo: espnData.leagues?.[0]?.logos?.[0]?.href || null,
        local: home.team?.displayName || 'Local',
        visitante: away.team?.displayName || 'Visitante',
        homeLogo: home.team?.logo || null,
        awayLogo: away.team?.logo || null,
        marcador: status.state === 'in' ? `${home.score||'0'}-${away.score||'0'}` : null,
        minuto: status.state === 'in' ? ev.status?.displayClock || '' : null,
        estado: status.state === 'in' ? 'live' : 'scheduled',
        horaInicio: ev.date || null,
        cuota_local: null,
        cuota_empate: null,
        cuota_visitante: null
      });
    } catch(e) { /* ignorar */ }
  }
  return events;
}

// ==================== THE ODDS API ====================
function getApiKey() {
  if (!ODDS_API_KEYS.length) return null;
  const key = ODDS_API_KEYS[_turnoActual % ODDS_API_KEYS.length];
  _turnoActual++;
  return key;
}

const SPORTS_CONFIG = {
  'soccer_fifa_world_cup': { priority: 1, baseUrl: '/sports/soccer_fifa_world_cup/odds', region: 'eu' },
  'soccer_conmebol_libertadores': { priority: 2, baseUrl: '/sports/soccer_conmebol_libertadores/odds', region: 'eu' },
  'soccer_uefa_champions_league': { priority: 2, baseUrl: '/sports/soccer_uefa_champions_league/odds', region: 'eu' },
  'soccer_epl': { priority: 3, baseUrl: '/sports/soccer_epl/odds', region: 'eu' },
  'soccer_spain_la_liga': { priority: 3, baseUrl: '/sports/soccer_spain_la_liga/odds', region: 'eu' },
  'soccer_italy_serie_a': { priority: 3, baseUrl: '/sports/soccer_italy_serie_a/odds', region: 'eu' },
  'soccer_germany_bundesliga': { priority: 3, baseUrl: '/sports/soccer_germany_bundesliga/odds', region: 'eu' },
  'soccer_france_ligue_1': { priority: 3, baseUrl: '/sports/soccer_france_ligue_1/odds', region: 'eu' },
  'mma_mixed_martial_arts': { priority: 10, baseUrl: '/sports/mma_mixed_martial_arts/odds', region: 'us' },
  'boxing_boxing': { priority: 10, baseUrl: '/sports/boxing_boxing/odds', region: 'us' },
  'baseball_mlb': { priority: 10, baseUrl: '/sports/baseball_mlb/odds', region: 'us' },
  'basketball_nba': { priority: 10, baseUrl: '/sports/basketball_nba/odds', region: 'us' }
};

async function fetchOddsForSport(sportKey) {
  const apiKey = getApiKey();
  if (!apiKey) return [];
  try {
    const res = await axios.get(`${ODDS_API_HOST}${SPORTS_CONFIG[sportKey].baseUrl}`, {
      params: { apiKey, regions: SPORTS_CONFIG[sportKey].region || 'eu', oddsFormat: 'decimal' }
    });
    return res.data;
  } catch(e) { return []; }
}

// ==================== ENDPOINTS ====================

app.get('/api/fixtures', async (req, res) => {
  const cached = getCache('fixtures');
  if (cached) return res.json(cached);

  // 1. Obtener cartelera de ESPN
  const deportesESPN = [
    { path: 'soccer/esp.1/scoreboard', sport: 'soccer' },
    { path: 'soccer/eng.1/scoreboard', sport: 'soccer' },
    { path: 'soccer/ger.1/scoreboard', sport: 'soccer' },
    { path: 'soccer/ita.1/scoreboard', sport: 'soccer' },
    { path: 'soccer/fra.1/scoreboard', sport: 'soccer' },
    { path: 'soccer/uefa.champions/scoreboard', sport: 'soccer' },
    { path: 'soccer/conmebol.libertadores/scoreboard', sport: 'soccer' },
    { path: 'soccer/fifa.world/scoreboard', sport: 'soccer' },
    { path: 'basketball/nba/scoreboard', sport: 'basketball' },
    { path: 'baseball/mlb/scoreboard', sport: 'baseball' },
    { path: 'football/nfl/scoreboard', sport: 'football' },
    { path: 'hockey/nhl/scoreboard', sport: 'hockey' }
  ];

  const todos = [];
  await Promise.allSettled(deportesESPN.map(async ({ path, sport }) => {
    try {
      const data = await fetchESPN(path);
      todos.push(...parseEvents(data, sport));
    } catch(e) { /* ignorar */ }
  }));

  // 2. Intentar obtener cuotas desde The Odds API (para enriquecer)
  try {
    for (const [sportKey] of Object.entries(SPORTS_CONFIG)) {
      const oddsData = await fetchOddsForSport(sportKey);
      for (const match of oddsData) {
        const found = todos.find(e => e.id === match.id);
        if (found) {
          const outcomes = match.bookmakers?.[0]?.markets?.[0]?.outcomes || [];
          outcomes.forEach(o => {
            if (o.name === match.home_team) found.cuota_local = o.price;
            if (o.name === match.away_team) found.cuota_visitante = o.price;
            if (o.name === 'Draw') found.cuota_empate = o.price;
          });
        }
      }
    }
  } catch(e) { /* continuar sin cuotas */ }

  todos.sort((a, b) => (a.estado === 'live' ? -1 : 1));

  const response = {
    status: 'online',
    timestamp: new Date().toISOString(),
    total: todos.length,
    en_vivo: todos.filter(e => e.estado === 'live').length,
    data: todos
  };

  setCache('fixtures', response);
  res.json(response);
});

app.get('/health', (req, res) => {
  res.json({ status: 'sync_completed', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Proxy con ESPN + Odds en puerto ${PORT}`));
