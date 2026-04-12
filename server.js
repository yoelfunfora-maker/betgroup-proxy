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

// ==================== CÁLCULO DE CUOTAS DINÁMICAS ====================
function calcularCuotas(homeRank, awayRank, sport) {
  // Si no hay ranking, usar valor medio (50)
  const hr = homeRank || 50;
  const ar = awayRank || 50;
  
  // Ventaja de localía: +15% probabilidad para el local
  const LOCAL_ADVANTAGE = 0.15;
  
  // Calcular fuerza relativa (0-1)
  const totalRank = hr + ar;
  let homeStrength = ar / totalRank; // El rival más débil da más fuerza
  let awayStrength = hr / totalRank;
  
  // Aplicar ventaja localía
  homeStrength = homeStrength * (1 + LOCAL_ADVANTAGE);
  awayStrength = awayStrength * (1 - LOCAL_ADVANTAGE);
  
  // Normalizar para que sumen 1 (sin empate)
  const total = homeStrength + awayStrength;
  let homeProb = homeStrength / total;
  let awayProb = awayStrength / total;
  
  // Para fútbol, añadir probabilidad de empate (depende de qué tan parejos sean)
  let drawProb = 0;
  if (sport === 'soccer') {
    const diff = Math.abs(hr - ar);
    if (diff < 10) drawProb = 0.28;      // Muy parejos
    else if (diff < 20) drawProb = 0.24; // Algo parejos
    else if (diff < 30) drawProb = 0.20; // Diferencia media
    else drawProb = 0.16;                // Muy desiguales
    
    // Redistribuir probabilidades
    homeProb = homeProb * (1 - drawProb);
    awayProb = awayProb * (1 - drawProb);
  }
  
  // Margen de la casa (6%)
  const MARGIN = 0.94;
  
  // Convertir a cuotas
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
  
  // Over/Under 2.5 - basado en ranking (mejores equipos = más goles)
  const overProb = avgRank < 25 ? 0.58 : avgRank < 40 ? 0.52 : avgRank < 60 ? 0.45 : 0.38;
  const over = parseFloat((1 / overProb * MARGIN).toFixed(2));
  const under = parseFloat((1 / (1 - overProb) * MARGIN).toFixed(2));
  
  // BTTS - Ambos marcan
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

      // Obtener ranking real de ESPN
      const homeRank = parseInt(home.curatedRank?.current || 50);
      const awayRank = parseInt(away.curatedRank?.current || 50);
      
      // Calcular cuotas dinámicas
      const cuotas = calcularCuotas(homeRank, awayRank, sport);
      
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
        // Rankings para transparencia
        homeRank: homeRank,
        awayRank: awayRank
      };

      // Mercados extra para fútbol
      if (sport === 'soccer') {
        const extra = generateExtraMarkets(homeRank, awayRank, sport);
        if (extra) Object.assign(eventObj, extra);
      }

      events.push(eventObj);
    } catch(e) { /* evento inválido */ }
  }
  return events;
}

// ==================== ENDPOINTS ====================

app.get('/', (req, res) => {
  res.json({ status: 'online', message: 'BetGroup Pro API v3.0 — Cuotas Dinámicas' });
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
  console.log(`✅ BetGroup Pro Proxy v3.0 en puerto ${PORT}`);
});
