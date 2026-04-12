const express = require('express');
const cors = require('cors');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ==================== CACHÉ INTELIGENTE ====================
const cache = {};
const CACHE_TTL = 3 * 60 * 1000; // 3 minutos

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
    const options = {
      hostname: 'site.api.espn.com',
      path: `/apis/site/v2/sports/${path}`,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json'
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Error parsing ESPN response')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('ESPN timeout')); });
    req.end();
  });
}

// ===== NUEVO: Generador de cuotas para mercados adicionales =====
function generateExtraMarkets(homeRank, awayRank, sport) {
  const avgRank = (homeRank + awayRank) / 2;
  const MARGEN_CASA = 0.92; // 8% de margen para la casa
  
  // Solo para fútbol
  if (sport !== 'soccer') return null;
  
  // Over/Under 2.5 goles
  const overProb = avgRank < 30 ? 0.55 : avgRank > 60 ? 0.40 : 0.48;
  const over_2_5 = parseFloat((1 / overProb * MARGEN_CASA).toFixed(2));
  const under_2_5 = parseFloat((1 / (1 - overProb) * MARGEN_CASA).toFixed(2));
  
  // Ambos equipos marcan (BTTS)
  const bttsProb = avgRank < 25 ? 0.58 : avgRank > 65 ? 0.38 : 0.48;
  const btts_yes = parseFloat((1 / bttsProb * MARGEN_CASA).toFixed(2));
  const btts_no = parseFloat((1 / (1 - bttsProb) * MARGEN_CASA).toFixed(2));
  
  // Doble oportunidad
  const homeProb = 1 / (2.0 - (awayRank - homeRank) / 20 * 0.15);
  const awayProb = 1 / (2.0 + (awayRank - homeRank) / 20 * 0.15);
  const drawProb = sport === 'soccer' ? 0.28 : 0;
  
  const doble_1x = parseFloat((1 / (homeProb + drawProb) * MARGEN_CASA).toFixed(2));
  const doble_x2 = parseFloat((1 / (awayProb + drawProb) * MARGEN_CASA).toFixed(2));
  const doble_12 = parseFloat((1 / (homeProb + awayProb) * MARGEN_CASA).toFixed(2));
  
  // Hándicap asiático (-1.5, +1.5)
  const handicap_home = parseFloat((homeProb * 1.8 * MARGEN_CASA).toFixed(2));
  const handicap_away = parseFloat((awayProb * 1.8 * MARGEN_CASA).toFixed(2));
  
  return {
    over_under: { over: over_2_5, under: under_2_5 },
    both_to_score: { yes: btts_yes, no: btts_no },
    double_chance: { home_draw: doble_1x, away_draw: doble_x2, home_away: doble_12 },
    handicap: { home_minus_1_5: handicap_home, away_plus_1_5: handicap_away }
  };
}

// ===== MODIFICADO: PARSER DE EVENTOS (añade mercados extra) =====
function parseEvents(espnData, sport) {
  const events = [];
  if (!espnData || !espnData.events) return events;

  for (const ev of espnData.events) {
    try {
      const competition = ev.competitions?.[0];
      if (!competition) continue;
      const competitors = competition.competitors || [];
      const home = competitors.find(c => c.homeAway === 'home');
      const away = competitors.find(c => c.homeAway === 'away');
      if (!home || !away) continue;

      const status = ev.status?.type;
      const isLive = status?.state === 'in';
      const isScheduled = status?.state === 'pre';
      const isFinal = status?.state === 'post' || status?.completed === true;
      
      if (!isLive && !isScheduled && !isFinal) continue;

      const homeScore = home.score || '0';
      const awayScore = away.score || '0';
      const minute = ev.status?.displayClock || '';
      const period = ev.status?.period || 0;

      // Cuotas realistas basadas en ranking
      const homeRank = parseInt(home.curatedRank?.current || 50);
      const awayRank = parseInt(away.curatedRank?.current || 50);
      const diff = (awayRank - homeRank) / 20;
      const baseHome = Math.max(1.30, Math.min(5.00, parseFloat((2.0 - diff * 0.15).toFixed(2))));
      const baseDraw = sport === 'soccer' ? parseFloat((3.0 + Math.random() * 0.6).toFixed(2)) : null;
      const baseAway = Math.max(1.30, Math.min(5.00, parseFloat((2.0 + diff * 0.15).toFixed(2))));

      // ===== NUEVO: Determinar estado final =====
      let estado = isLive ? 'live' : 'scheduled';
      if (isFinal) estado = 'final';

      const eventObj = {
        id: ev.id,
        sport,
        liga: espnData.leagues?.[0]?.name || sport,
        ligaLogo: espnData.leagues?.[0]?.logos?.[0]?.href || null,
        local: home.team?.displayName || 'Local',
        visitante: away.team?.displayName || 'Visitante',
        homeLogo: home.team?.logo || null,
        awayLogo: away.team?.logo || null,
        marcador: isLive || isFinal ? `${homeScore}-${awayScore}` : null,
        minuto: isLive ? minute : null,
        periodo: period,
        estado: estado,
        horaInicio: ev.date || null,
        cuota_local: baseHome,
        cuota_empate: baseDraw,
        cuota_visitante: baseAway
      };

      // ===== NUEVO: Añadir mercados extra para fútbol =====
      if (sport === 'soccer') {
        const extra = generateExtraMarkets(homeRank, awayRank, sport);
        if (extra) Object.assign(eventObj, extra);
      }

      events.push(eventObj);
    } catch(e) { /* evento inválido, ignorar */ }
  }
  return events;
}

// ==================== ENDPOINTS ====================

app.get('/', (req, res) => {
  res.json({ status: 'online', message: 'BetGroup Pro API v2.1 — ESPN Real Data + Extra Markets' });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'online', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

app.get('/api/fixtures', async (req, res) => {
  const cached = getCache('fixtures');
  if (cached) return res.json(cached);

  const deportes = [
    { path: 'soccer/esp.1/scoreboard',                  sport: 'soccer' },
    { path: 'soccer/eng.1/scoreboard',                  sport: 'soccer' },
    { path: 'soccer/ger.1/scoreboard',                  sport: 'soccer' },
    { path: 'soccer/ita.1/scoreboard',                  sport: 'soccer' },
    { path: 'soccer/fra.1/scoreboard',                  sport: 'soccer' },
    { path: 'soccer/uefa.champions/scoreboard',         sport: 'soccer' },
    { path: 'soccer/conmebol.libertadores/scoreboard',  sport: 'soccer' },
    { path: 'soccer/usa.1/scoreboard',                  sport: 'soccer' },
    { path: 'basketball/nba/scoreboard',                sport: 'basketball' },
    { path: 'football/nfl/scoreboard',                  sport: 'football' },
    { path: 'hockey/nhl/scoreboard',                    sport: 'hockey' },
    { path: 'baseball/mlb/scoreboard',                  sport: 'baseball' },
  ];

  const todos = [];

  await Promise.allSettled(
    deportes.map(async ({ path, sport }) => {
      try {
        const data = await fetchESPN(path);
        const events = parseEvents(data, sport);
        todos.push(...events);
      } catch(e) { /* liga no disponible */ }
    })
  );

  todos.sort((a, b) => {
    if (a.estado === 'live' && b.estado !== 'live') return -1;
    if (a.estado !== 'live' && b.estado === 'live') return 1;
    return 0;
  });

  const response = {
    status: 'online',
    timestamp: new Date().toISOString(),
    total: todos.length,
    en_vivo: todos.filter(e => e.estado === 'live').length,
    finalizados: todos.filter(e => e.estado === 'final').length,
    proximos: todos.filter(e => e.estado === 'scheduled').length,
    data: todos
  };

  setCache('fixtures', response);
  res.json(response);
});

app.listen(PORT, () => {
  console.log(`✅ BetGroup Pro Proxy v2.1 en puerto ${PORT}`);
});
