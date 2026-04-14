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
const STATS_CACHE_TTL = 30 * 1000; // 30 segundos para stats en vivo

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

// ==================== API-SPORTS PARA RANKING REAL ====================
const API_SPORTS_KEY = '9c6baa24885e4b5c12d33d7530b03996';
const STANDINGS_CACHE = {};
const STANDINGS_TTL = 24 * 60 * 60 * 1000;

const LEAGUE_MAPPING = {
  soccer: {
    'Spanish LALIGA': 140,
    'English Premier League': 39,
    'German Bundesliga': 78,
    'Italian Serie A': 135,
    'French Ligue 1': 61,
    'UEFA Champions League': 2,
    'CONMEBOL Libertadores': 13,
    'MLS': 253
  },
  basketball: {
    'National Basketball Association': 12
  },
  football: {
    'National Football League': 1
  },
  baseball: {
    'Major League Baseball': 1
  }
};

async function fetchStandingsFromAPISports(sport, leagueName) {
  if (!LEAGUE_MAPPING[sport] || !LEAGUE_MAPPING[sport][leagueName]) {
    return null;
  }
  
  const leagueId = LEAGUE_MAPPING[sport][leagueName];
  const cacheKey = `standings_${sport}_${leagueId}`;
  const cached = STANDINGS_CACHE[cacheKey];
  if (cached && Date.now() - cached.timestamp < STANDINGS_TTL) {
    return cached.data;
  }
  
  const sportDomains = {
    soccer: 'v3.football',
    basketball: 'v1.basketball',
    football: 'v1.american-football',
    baseball: 'v1.baseball'
  };
  
  const domain = sportDomains[sport];
  if (!domain) return null;
  
  try {
    const season = sport === 'soccer' ? 2025 : (sport === 'basketball' ? '2025-2026' : 2025);
    const url = `https://${domain}.api-sports.io/standings?league=${leagueId}&season=${season}`;
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    const res = await fetch(url, {
      headers: { 'x-apisports-key': API_SPORTS_KEY },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    const data = await res.json();
    
    if (data.errors && Object.keys(data.errors).length > 0) {
      console.log('⚠️ API-Sports error:', data.errors);
      return null;
    }
    
    const rankings = {};
    if (data.response && data.response.length > 0) {
      const standings = data.response[0]?.league?.standings || [];
      for (const group of standings) {
        for (const team of group) {
          const teamName = team.team.name;
          const rank = team.rank;
          rankings[teamName] = rank;
        }
      }
    }
    
    STANDINGS_CACHE[cacheKey] = { data: rankings, timestamp: Date.now() };
    return rankings;
    
  } catch(e) {
    console.log('❌ API-Sports caída:', e.message);
    return null;
  }
}

function getTeamRank(teamName, rankings) {
  if (!rankings) return 50;
  
  for (const name in rankings) {
    if (teamName.includes(name) || name.includes(teamName)) {
      return rankings[name];
    }
  }
  return 50;
}

// ==================== CÁLCULO DE CUOTAS DINÁMICAS ====================
function calcularCuotas(homeRank, awayRank, sport) {
  const hr = homeRank || 50;
  const ar = awayRank || 50;
  
  const maxRank = Math.max(hr, ar, 20);
  const homeStrength = 1 - (hr / maxRank) * 0.7;
  const awayStrength = 1 - (ar / maxRank) * 0.7;
  
  const LOCAL_ADVANTAGE = 0.12;
  
  let homeProb = homeStrength / (homeStrength + awayStrength);
  let awayProb = awayStrength / (homeStrength + awayStrength);
  
  homeProb = homeProb * (1 + LOCAL_ADVANTAGE);
  awayProb = awayProb * (1 - LOCAL_ADVANTAGE);
  
  const total = homeProb + awayProb;
  homeProb = homeProb / total;
  awayProb = awayProb / total;
  
  let drawProb = 0;
  if (sport === 'soccer') {
    const diff = Math.abs(hr - ar);
    if (diff <= 2) drawProb = 0.28;
    else if (diff <= 5) drawProb = 0.24;
    else if (diff <= 10) drawProb = 0.20;
    else drawProb = 0.16;
    
    homeProb = homeProb * (1 - drawProb);
    awayProb = awayProb * (1 - drawProb);
  }
  
  const MARGIN = 0.94;
  
  const homeOdds = parseFloat((1 / homeProb * MARGIN).toFixed(2));
  const awayOdds = parseFloat((1 / awayProb * MARGIN).toFixed(2));
  const drawOdds = sport === 'soccer' ? parseFloat((1 / drawProb * MARGIN).toFixed(2)) : null;
  
  return {
    cuota_local: Math.max(1.15, Math.min(9.00, homeOdds)),
    cuota_visitante: Math.max(1.15, Math.min(9.00, awayOdds)),
    cuota_empate: drawOdds ? Math.max(1.40, Math.min(7.00, drawOdds)) : null
  };
}

// ==================== MERCADOS EXTRA ====================
function generateExtraMarkets(homeRank, awayRank, sport) {
  if (sport !== 'soccer') return null;
  
  const hr = homeRank || 50;
  const ar = awayRank || 50;
  const avgRank = (hr + ar) / 2;
  const MARGIN = 0.92;
  
  const overProb = avgRank <= 5 ? 0.58 : avgRank <= 10 ? 0.52 : avgRank <= 15 ? 0.45 : 0.38;
  const over = parseFloat((1 / overProb * MARGIN).toFixed(2));
  const under = parseFloat((1 / (1 - overProb) * MARGIN).toFixed(2));
  
  const bttsProb = (hr <= 5 && ar <= 5) ? 0.55 : (hr > 15 || ar > 15) ? 0.40 : 0.48;
  const bttsYes = parseFloat((1 / bttsProb * MARGIN).toFixed(2));
  const bttsNo = parseFloat((1 / (1 - bttsProb) * MARGIN).toFixed(2));
  
  return {
    over_under: { over, under },
    both_to_score: { yes: bttsYes, no: bttsNo }
  };
}

// ==================== PARSER DE EVENTOS ====================
async function parseEvents(espnData, sport) {
  const events = [];
  if (!espnData || !espnData.events) return events;

  const leagueName = espnData.leagues?.[0]?.name;
  const rankings = await fetchStandingsFromAPISports(sport, leagueName);

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

      const homeTeamName = home.team?.displayName || '';
      const awayTeamName = away.team?.displayName || '';
      
      const homeRank = getTeamRank(homeTeamName, rankings);
      const awayRank = getTeamRank(awayTeamName, rankings);
      
      const cuotas = calcularCuotas(homeRank, awayRank, sport);
      
      let estado = isLive ? 'live' : 'scheduled';
      if (isFinal) estado = 'final';

      const eventObj = {
        id: ev.id,
        sport,
        liga: leagueName || sport,
        ligaLogo: espnData.leagues?.[0]?.logos?.[0]?.href || null,
        local: homeTeamName || 'Local',
        visitante: awayTeamName || 'Visitante',
        homeLogo: home.team?.logo || null,
        awayLogo: away.team?.logo || null,
        marcador: isLive || isFinal ? `${homeScore}-${awayScore}` : null,
        minuto: isLive ? minute : null,
        periodo: period,
        estado: estado,
        horaInicio: ev.date || null,
        cuota_local: cuotas.cuota_local,
        cuota_empate: cuotas.cuota_empate,
        cuota_visitante: cuotas.cuota_visitante,
        homeRank: homeRank,
        awayRank: awayRank
      };

      if (sport === 'soccer') {
        const extra = generateExtraMarkets(homeRank, awayRank, sport);
        if (extra) Object.assign(eventObj, extra);
      }

      events.push(eventObj);
    } catch(e) { }
  }
  return events;
}

// ==================== ENDPOINT DE ESTADÍSTICAS EN VIVO ====================
app.get('/api/stats/:eventId', async (req, res) => {
  const { eventId } = req.params;
  const { sport } = req.query;
  
  if (!sport) {
    return res.status(400).json({ error: 'Se requiere el parámetro sport' });
  }
  
  const cacheKey = `stats_${eventId}`;
  const cached = cache[cacheKey];
  if (cached && Date.now() - cached.timestamp < STATS_CACHE_TTL) {
    return res.json(cached.data);
  }
  
  try {
    const summaryPath = `${sport}/summary?event=${eventId}`;
    const data = await fetchESPN(summaryPath);
    
    let stats = { eventId, sport, local: {}, visitante: {} };
    
    if (data && data.boxscore) {
      const teams = data.boxscore.teams || [];
      const home = teams.find(t => t.homeAway === 'home');
      const away = teams.find(t => t.homeAway === 'away');
      
      if (home && away) {
        const homeStats = home.statistics || [];
        const awayStats = away.statistics || [];
        
        const extractStat = (arr, name) => {
          const found = arr.find(s => s.name === name);
          return found ? found.displayValue : (name.includes('Pct') ? '0%' : 0);
        };
        
        if (sport === 'soccer') {
          stats.local = {
            posesion: extractStat(homeStats, 'possessionPct'),
            tiros: extractStat(homeStats, 'totalShots'),
            tirosPuerta: extractStat(homeStats, 'shotsOnTarget'),
            faltas: extractStat(homeStats, 'fouls'),
            corners: extractStat(homeStats, 'cornerKicks'),
            amarillas: extractStat(homeStats, 'yellowCards'),
            rojas: extractStat(homeStats, 'redCards')
          };
          stats.visitante = {
            posesion: extractStat(awayStats, 'possessionPct'),
            tiros: extractStat(awayStats, 'totalShots'),
            tirosPuerta: extractStat(awayStats, 'shotsOnTarget'),
            faltas: extractStat(awayStats, 'fouls'),
            corners: extractStat(awayStats, 'cornerKicks'),
            amarillas: extractStat(awayStats, 'yellowCards'),
            rojas: extractStat(awayStats, 'redCards')
          };
        } else if (sport === 'basketball') {
          stats.local = {
            puntos: home.score || '0',
            rebotes: extractStat(homeStats, 'totalRebounds'),
            asistencias: extractStat(homeStats, 'assists'),
            fgPct: extractStat(homeStats, 'fieldGoalPct'),
            threePct: extractStat(homeStats, 'threePointPct')
          };
          stats.visitante = {
            puntos: away.score || '0',
            rebotes: extractStat(awayStats, 'totalRebounds'),
            asistencias: extractStat(awayStats, 'assists'),
            fgPct: extractStat(awayStats, 'fieldGoalPct'),
            threePct: extractStat(awayStats, 'threePointPct')
          };
        } else if (sport === 'football') {
          stats.local = {
            puntos: home.score || '0',
            yardasTotales: extractStat(homeStats, 'totalYards'),
            yardasPase: extractStat(homeStats, 'passingYards'),
            yardasCarrera: extractStat(homeStats, 'rushingYards')
          };
          stats.visitante = {
            puntos: away.score || '0',
            yardasTotales: extractStat(awayStats, 'totalYards'),
            yardasPase: extractStat(awayStats, 'passingYards'),
            yardasCarrera: extractStat(awayStats, 'rushingYards')
          };
        } else if (sport === 'baseball') {
          stats.local = {
            carreras: home.score || '0',
            hits: extractStat(homeStats, 'hits'),
            errores: extractStat(homeStats, 'errors')
          };
          stats.visitante = {
            carreras: away.score || '0',
            hits: extractStat(awayStats, 'hits'),
            errores: extractStat(awayStats, 'errors')
          };
        }
      }
    }
    
    const response = { status: 'online', data: stats };
    cache[cacheKey] = { data: response, timestamp: Date.now() };
    res.json(response);
    
  } catch(e) {
    res.status(500).json({ error: 'No se pudieron obtener las estadísticas' });
  }
});

// ==================== ENDPOINT DE RESULTADOS FINALES ====================
app.get('/api/results', async (req, res) => {
  const cacheKey = 'results_finalizados';
  const cached = cache[cacheKey];
  if (cached && Date.now() - cached.timestamp < 5 * 60 * 1000) {
    return res.json(cached.data);
  }
  
  const deportes = [
    { path: 'soccer/esp.1/scoreboard', sport: 'soccer' },
    { path: 'soccer/eng.1/scoreboard', sport: 'soccer' },
    { path: 'soccer/ger.1/scoreboard', sport: 'soccer' },
    { path: 'soccer/ita.1/scoreboard', sport: 'soccer' },
    { path: 'soccer/fra.1/scoreboard', sport: 'soccer' },
    { path: 'soccer/uefa.champions/scoreboard', sport: 'soccer' },
    { path: 'soccer/conmebol.libertadores/scoreboard', sport: 'soccer' },
    { path: 'soccer/usa.1/scoreboard', sport: 'soccer' },
    { path: 'basketball/nba/scoreboard', sport: 'basketball' },
    { path: 'football/nfl/scoreboard', sport: 'football' },
    { path: 'baseball/mlb/scoreboard', sport: 'baseball' },
  ];
  
  const resultados = [];
  
  await Promise.allSettled(
    deportes.map(async ({ path, sport }) => {
      try {
        const data = await fetchESPN(path);
        if (!data || !data.events) return;
        
        for (const ev of data.events) {
          const status = ev.status?.type;
          const isFinal = status?.state === 'post' || status?.completed === true;
          if (!isFinal) continue;
          
          const competition = ev.competitions?.[0];
          if (!competition) continue;
          const competitors = competition.competitors || [];
          const home = competitors.find(c => c.homeAway === 'home');
          const away = competitors.find(c => c.homeAway === 'away');
          if (!home || !away) continue;
          
          resultados.push({
            id: ev.id,
            sport,
            local: home.team?.displayName || 'Local',
            visitante: away.team?.displayName || 'Visitante',
            marcador: `${home.score || '0'}-${away.score || '0'}`,
            golesLocal: parseInt(home.score || '0'),
            golesVisitante: parseInt(away.score || '0'),
            fecha: ev.date
          });
        }
      } catch(e) { }
    })
  );
  
  const response = {
    status: 'online',
    timestamp: new Date().toISOString(),
    total: resultados.length,
    data: resultados
  };
  
  cache[cacheKey] = { data: response, timestamp: Date.now() };
  res.json(response);
});

// ==================== ENDPOINTS PRINCIPALES ====================

app.get('/', (req, res) => {
  res.json({ status: 'online', message: 'BetGroup Pro API v5.1 — Resolución Automática' });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'online', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

app.get('/api/fixtures', async (req, res) => {
  const cached = getCache('fixtures');
  if (cached) return res.json(cached);

  const deportes = [
    { path: 'soccer/esp.1/scoreboard', sport: 'soccer' },
    { path: 'soccer/eng.1/scoreboard', sport: 'soccer' },
    { path: 'soccer/ger.1/scoreboard', sport: 'soccer' },
    { path: 'soccer/ita.1/scoreboard', sport: 'soccer' },
    { path: 'soccer/fra.1/scoreboard', sport: 'soccer' },
    { path: 'soccer/uefa.champions/scoreboard', sport: 'soccer' },
    { path: 'soccer/conmebol.libertadores/scoreboard', sport: 'soccer' },
    { path: 'soccer/usa.1/scoreboard', sport: 'soccer' },
    { path: 'basketball/nba/scoreboard', sport: 'basketball' },
    { path: 'football/nfl/scoreboard', sport: 'football' },
    { path: 'baseball/mlb/scoreboard', sport: 'baseball' },
  ];

  const todos = [];

  await Promise.allSettled(
    deportes.map(async ({ path, sport }) => {
      try {
        const data = await fetchESPN(path);
        const events = await parseEvents(data, sport);
        todos.push(...events);
      } catch(e) { }
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
  console.log(`✅ BetGroup Pro Proxy v5.1 en puerto ${PORT} - Resolución Automática`);
});
