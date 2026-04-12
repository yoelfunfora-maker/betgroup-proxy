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

// ==================== API-SPORTS PARA CUOTAS REALES ====================
const API_SPORTS_KEY = '6578ce4bcf940dbff3f82b1ca6549cef';
const API_SPORTS_CACHE = {};
const ODDS_CACHE_TTL = 60 * 60 * 1000; // 1 hora

async function fetchOddsFromAPISports(sport, leagueId) {
  const cacheKey = `odds_${sport}_${leagueId}`;
  const cached = API_SPORTS_CACHE[cacheKey];
  if (cached && Date.now() - cached.timestamp < ODDS_CACHE_TTL) {
    return cached.data;
  }
  
  const sportDomains = {
    soccer: 'v3.football',
    basketball: 'v1.basketball',
    football: 'v1.american-football',
    hockey: 'v1.hockey',
    baseball: 'v1.baseball'
  };
  
  const domain = sportDomains[sport];
  if (!domain) return null;
  
  try {
    const url = `https://${domain}.api-sports.io/odds?league=${leagueId}&season=2025`;
    const res = await fetch(url, {
      headers: { 'x-apisports-key': API_SPORTS_KEY }
    });
    const data = await res.json();
    
    API_SPORTS_CACHE[cacheKey] = { data: data.response, timestamp: Date.now() };
    return data.response;
  } catch(e) {
    console.error('Error API-Sports:', e);
    return null;
  }
}

// ==================== CÁLCULO DE CUOTAS DINÁMICAS (MEJORADO CON API-SPORTS) ====================
function calcularCuotas(homeRank, awayRank, sport, apiOdds) {
  // Si hay cuotas reales de API-Sports, usarlas
  if (apiOdds && apiOdds.length > 0) {
    const bookmaker = apiOdds[0]?.bookmakers?.[0];
    if (bookmaker) {
      const bets = bookmaker.bets || [];
      const homeBet = bets.find(b => b.name === 'Home');
      const awayBet = bets.find(b => b.name === 'Away');
      const drawBet = bets.find(b => b.name === 'Draw');
      
      if (homeBet && awayBet) {
        return {
          cuota_local: parseFloat(homeBet.values[0]?.odd || 2.0),
          cuota_visitante: parseFloat(awayBet.values[0]?.odd || 2.0),
          cuota_empate: drawBet ? parseFloat(drawBet.values[0]?.odd) : null
        };
      }
    }
  }
  
  // Fallback al cálculo simulado si no hay datos de API
  const hr = homeRank || 50;
  const ar = awayRank || 50;
  
  const LOCAL_ADVANTAGE = 0.15;
  
  const totalRank = hr + ar;
  let homeStrength = ar / totalRank;
  let awayStrength = hr / totalRank;
  
  homeStrength = homeStrength * (1 + LOCAL_ADVANTAGE);
  awayStrength = awayStrength * (1 - LOCAL_ADVANTAGE);
  
  const total = homeStrength + awayStrength;
  let homeProb = homeStrength / total;
  let awayProb = awayStrength / total;
  
  let drawProb = 0;
  if (sport === 'soccer') {
    const diff = Math.abs(hr - ar);
    if (diff < 10) drawProb = 0.28;
    else if (diff < 20) drawProb = 0.24;
    else if (diff < 30) drawProb = 0.20;
    else drawProb = 0.16;
    
    homeProb = homeProb * (1 - drawProb);
    awayProb = awayProb * (1 - drawProb);
  }
  
  const MARGIN = 0.94;
  
  const homeOdds = parseFloat((1 / homeProb * MARGIN).toFixed(2));
  const awayOdds = parseFloat((1 / awayProb * MARGIN).toFixed(2));
  const drawOdds = sport === 'soccer' ? parseFloat((1 / drawProb * MARGIN).toFixed(2)) : null;
  
  return {
    cuota_local: Math.max(1.20, Math.min(8.00, homeOdds)),
    cuota_visitante: Math.max(1.20, Math.min(8.00, awayOdds)),
    cuota_empate: drawOdds ? Math.max(1.50, Math.min(6.00, drawOdds)) : null
  };
}

// ==================== MERCADOS EXTRA ====================
function generateExtraMarkets(homeRank, awayRank, sport) {
  if (sport !== 'soccer') return null;
  
  const hr = homeRank || 50;
  const ar = awayRank || 50;
  const avgRank = (hr + ar) / 2;
  const MARGIN = 0.92;
  
  const overProb = avgRank < 25 ? 0.58 : avgRank < 40 ? 0.52 : avgRank < 60 ? 0.45 : 0.38;
  const over = parseFloat((1 / overProb * MARGIN).toFixed(2));
  const under = parseFloat((1 / (1 - overProb) * MARGIN).toFixed(2));
  
  const bttsProb = (hr < 40 && ar < 40) ? 0.55 : (hr > 60 || ar > 60) ? 0.40 : 0.48;
  const bttsYes = parseFloat((1 / bttsProb * MARGIN).toFixed(2));
  const bttsNo = parseFloat((1 / (1 - bttsProb) * MARGIN).toFixed(2));
  
  return {
    over_under: { over, under },
    both_to_score: { yes: bttsYes, no: bttsNo }
  };
}

// ==================== PARSER DE EVENTOS ====================
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

      const homeRank = parseInt(home.curatedRank?.current || 50);
      const awayRank = parseInt(away.curatedRank?.current || 50);
      
      const cuotas = calcularCuotas(homeRank, awayRank, sport, null); // Sin API Odds por ahora
      
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

// ==================== ENDPOINT DE ESTADÍSTICAS EN VIVO (TODOS LOS DEPORTES) ====================
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
    
    let stats = {
      eventId,
      sport,
      local: {},
      visitante: {}
    };
    
    if (data && data.boxscore) {
      const teams = data.boxscore.teams || [];
      const home = teams.find(t => t.homeAway === 'home');
      const away = teams.find(t => t.homeAway === 'away');
      
      if (home && away) {
        const homeStats = home.statistics || [];
        const awayStats = away.statistics || [];
        
        const extractStat = (statArray, statName) => {
          const found = statArray.find(s => s.name === statName);
          return found ? found.displayValue : (statName.includes('Pct') ? '0%' : 0);
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
            robos: extractStat(homeStats, 'steals'),
            tapones: extractStat(homeStats, 'blocks'),
            perdidas: extractStat(homeStats, 'turnovers'),
            fgPct: extractStat(homeStats, 'fieldGoalPct'),
            threePct: extractStat(homeStats, 'threePointPct'),
            ftPct: extractStat(homeStats, 'freeThrowPct')
          };
          stats.visitante = {
            puntos: away.score || '0',
            rebotes: extractStat(awayStats, 'totalRebounds'),
            asistencias: extractStat(awayStats, 'assists'),
            robos: extractStat(awayStats, 'steals'),
            tapones: extractStat(awayStats, 'blocks'),
            perdidas: extractStat(awayStats, 'turnovers'),
            fgPct: extractStat(awayStats, 'fieldGoalPct'),
            threePct: extractStat(awayStats, 'threePointPct'),
            ftPct: extractStat(awayStats, 'freeThrowPct')
          };
        } else if (sport === 'football') {
          stats.local = {
            puntos: home.score || '0',
            yardasTotales: extractStat(homeStats, 'totalYards'),
            yardasPase: extractStat(homeStats, 'passingYards'),
            yardasCarrera: extractStat(homeStats, 'rushingYards'),
            primeraOportunidad: extractStat(homeStats, 'firstDowns'),
            terceraEficiencia: extractStat(homeStats, 'thirdDownConvPct'),
            posesion: extractStat(homeStats, 'possessionTime')
          };
          stats.visitante = {
            puntos: away.score || '0',
            yardasTotales: extractStat(awayStats, 'totalYards'),
            yardasPase: extractStat(awayStats, 'passingYards'),
            yardasCarrera: extractStat(awayStats, 'rushingYards'),
            primeraOportunidad: extractStat(awayStats, 'firstDowns'),
            terceraEficiencia: extractStat(awayStats, 'thirdDownConvPct'),
            posesion: extractStat(awayStats, 'possessionTime')
          };
        } else if (sport === 'hockey') {
          stats.local = {
            goles: home.score || '0',
            tiros: extractStat(homeStats, 'shotsOnGoal'),
            powerPlay: extractStat(homeStats, 'powerPlayPct'),
            penalties: extractStat(homeStats, 'penaltyMinutes'),
            hits: extractStat(homeStats, 'hits'),
            faceoffPct: extractStat(homeStats, 'faceoffWinPct')
          };
          stats.visitante = {
            goles: away.score || '0',
            tiros: extractStat(awayStats, 'shotsOnGoal'),
            powerPlay: extractStat(awayStats, 'powerPlayPct'),
            penalties: extractStat(awayStats, 'penaltyMinutes'),
            hits: extractStat(awayStats, 'hits'),
            faceoffPct: extractStat(awayStats, 'faceoffWinPct')
          };
        } else if (sport === 'baseball') {
          stats.local = {
            carreras: home.score || '0',
            hits: extractStat(homeStats, 'hits'),
            errores: extractStat(homeStats, 'errors'),
            avgBateo: extractStat(homeStats, 'battingAvg'),
            obp: extractStat(homeStats, 'onBasePct'),
            slg: extractStat(homeStats, 'sluggingPct')
          };
          stats.visitante = {
            carreras: away.score || '0',
            hits: extractStat(awayStats, 'hits'),
            errores: extractStat(awayStats, 'errors'),
            avgBateo: extractStat(awayStats, 'battingAvg'),
            obp: extractStat(awayStats, 'onBasePct'),
            slg: extractStat(awayStats, 'sluggingPct')
          };
        }
      }
    }
    
    const response = { status: 'online', data: stats };
    cache[cacheKey] = { data: response, timestamp: Date.now() };
    res.json(response);
    
  } catch(e) {
    console.error('Error obteniendo stats:', e);
    res.status(500).json({ error: 'No se pudieron obtener las estadísticas' });
  }
});

// ==================== ENDPOINTS PRINCIPALES ====================

app.get('/', (req, res) => {
  res.json({ status: 'online', message: 'BetGroup Pro API v3.2 — ESPN + API-Sports' });
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
    { path: 'hockey/nhl/scoreboard', sport: 'hockey' },
    { path: 'baseball/mlb/scoreboard', sport: 'baseball' },
  ];

  const todos = [];

  await Promise.allSettled(
    deportes.map(async ({ path, sport }) => {
      try {
        const data = await fetchESPN(path);
        const events = parseEvents(data, sport);
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
  console.log(`✅ BetGroup Pro Proxy v3.2 en puerto ${PORT}`);
});
