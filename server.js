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

// ==================== PARSER DE EVENTOS ====================
function parseEvents(espnData, sport) {
  const events = [];
  if (!espnData || !espnData.events) return events;

  for (const ev of espnData.events) {
    try {
      // Buscar competitors en competitions directas o dentro de groupings
      let allCompetitors = [];
      if (ev.competitions?.length) {
        allCompetitors = ev.competitions[0].competitors || [];
      } else if (ev.groupings?.length) {
        for (const grouping of ev.groupings) {
          if (grouping.competitions?.length) {
            allCompetitors = grouping.competitions[0].competitors || [];
            if (allCompetitors.length >= 2) break;
          }
        }
      }
      if (allCompetitors.length < 2) continue;

      // Determinar local/visitante (o atleta1/atleta2 para deportes individuales)
      const isTeamSport = allCompetitors[0].homeAway !== undefined;
      let home, away;
      if (isTeamSport) {
        home = allCompetitors.find(c => c.homeAway === 'home');
        away = allCompetitors.find(c => c.homeAway === 'away');
        if (!home && !away) {
          home = allCompetitors[0];
          away = allCompetitors[1];
        }
      } else {
        home = allCompetitors[0];
        away = allCompetitors[1];
      }
      if (!home || !away) continue;

      // Extraer nombre del competidor (team o athlete)
      const getName = (c) => c?.athlete?.displayName || c?.team?.displayName || 'Desconocido';
      const getLogo = (c) => c?.team?.logo || null;

      const status = ev.status?.type;
      // Aceptar cualquier estado excepto eventos sin estado definido
      if (!status) continue;
      const isLive = status.state === 'in';
      // Permitir eventos 'post' si tienen fecha (pueden ser recién finalizados o próximos según el deporte)

      const homeScore = home.score || '0';
      const awayScore = away.score || '0';
      const minute = ev.status?.displayClock || '';
      const period = ev.status?.period || 0;

      // Sistema de respaldo universal (cuando no hay The Odds API)
      const homeRank = parseInt(home.curatedRank?.current || 0);
      const awayRank = parseInt(away.curatedRank?.current || 0);
      let probHome, probDraw, probAway;
      
      if (homeRank > 0 && awayRank > 0) {
        // Si hay ranking, calcular por diferencia
        const diff = Math.max(-30, Math.min(30, awayRank - homeRank));
        if(diff > 20){probHome=0.65;probDraw=0.20;probAway=0.15;}
        else if(diff > 10){probHome=0.55;probDraw=0.22;probAway=0.23;}
        else if(diff > 0){probHome=0.45;probDraw=0.27;probAway=0.28;}
        else if(diff > -10){probHome=0.35;probDraw=0.27;probAway=0.38;}
        else if(diff > -20){probHome=0.25;probDraw=0.22;probAway=0.53;}
        else{probHome=0.15;probDraw=0.20;probAway=0.65;}
      } else {
        // Sin ranking: probabilidades base por deporte
        const baseProb = {
          soccer: { home: 0.40, away: 0.30, draw: 0.30 },
          baseball: { home: 0.50, away: 0.50, draw: 0 },
          basketball: { home: 0.55, away: 0.45, draw: 0 },
          mma: { home: 0.50, away: 0.50, draw: 0 },
          tennis: { home: 0.50, away: 0.50, draw: 0 }
        };
        const prob = baseProb[sport] || { home: 0.50, away: 0.50, draw: 0 };
        probHome = prob.home;
        probAway = prob.away;
        probDraw = prob.draw;
      }
      const v=()=>(Math.random()*0.05)-0.025;
      probHome=Math.max(0.05,probHome+v());probAway=Math.max(0.05,probAway+v());
      probDraw=sport==='soccer'?Math.max(0.05,probDraw+v()):0;
      // Verificar si el evento permite empate
      const ligaNombre = (espnData.leagues?.[0]?.name || '').toLowerCase();
      const COMPETICIONES_SIN_EMPATE = ['champions', 'libertadores', 'world cup', 'mundial', 'fifa', 'playoff', 'eliminatorias', 'knockout', 'friendly', 'amistoso'];
      const permiteEmpate = sport === 'soccer' && !COMPETICIONES_SIN_EMPATE.some(c => ligaNombre.includes(c));
      const baseHome=parseFloat((1/probHome).toFixed(2));
      const baseDraw=permiteEmpate?parseFloat((1/probDraw).toFixed(2)):null;
      const baseAway=parseFloat((1/probAway).toFixed(2));

      // Filtrar por rango de fecha SOLO para eventos programados (pre)
      if (!isLive) {
        const eventDate = ev.date ? new Date(ev.date) : null;
        if (!eventDate) continue;
        const now = new Date();
        const minDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const maxDate = new Date(now.getTime() + 72 * 60 * 60 * 1000);
        if (eventDate < minDate || eventDate > maxDate) continue;
      }

      events.push({
        id: ev.id,
        sport,
        liga: espnData.leagues?.[0]?.name || sport,
        ligaLogo: espnData.leagues?.[0]?.logos?.[0]?.href || null,
        local: getName(home),
        visitante: getName(away),
        homeLogo: getLogo(home),
        awayLogo: getLogo(away),
        marcador: isLive ? `${homeScore}-${awayScore}` : null,
        minuto: isLive ? minute : null,
        periodo: period,
        estado: isLive ? 'live' : 'scheduled',
        horaInicio: ev.date || null,
        cuota_local: baseHome,
        cuota_empate: baseDraw,
        cuota_visitante: baseAway
      });
    } catch(e) { /* evento inválido, ignorar */ }
  }
  return events;
}

// ==================== ENDPOINTS ====================

app.get('/', (req, res) => {
  res.json({ status: 'online', message: 'BetGroup Pro API v2.0 — ESPN Real Data' });
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
    { path: 'baseball/mlb/scoreboard',                  sport: 'baseball' },
    { path: 'soccer/fifa.friendly/scoreboard',           sport: 'soccer' },
    { path: 'soccer/fifa.world/scoreboard',              sport: 'soccer' },
    { path: 'soccer/uefa.champions/scoreboard',          sport: 'soccer' },
    { path: 'tennis/atp/scoreboard',                     sport: 'tennis' },
    { path: 'tennis/wta/scoreboard',                     sport: 'tennis' },
    { path: 'mma/ufc/scoreboard',                        sport: 'mma' },
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

  await enriquecerConCuotas(todos);
  todos.sort((a, b) => {
    if (a.estado === 'live' && b.estado !== 'live') return -1;
    if (a.estado !== 'live' && b.estado === 'live') return 1;
    return 0;
  });

  const conCuotas = todos.filter(e => e.cuota_local).length;
  const conOverUnder = todos.filter(e => e.over_under).length;
  const conSpreads = todos.filter(e => e.spreads).length;
  const response = {
    status: 'online',
    timestamp: new Date().toISOString(),
    total: todos.length,
    en_vivo: todos.filter(e => e.estado === 'live').length,
    proximos: todos.filter(e => e.estado === 'scheduled').length,
    _debug: { con_cuotas: conCuotas, con_over_under: conOverUnder, con_spreads: conSpreads },
    data: todos
  };

  setCache('fixtures', response);
  res.json(response);
});



// ==================== THE ODDS API ====================
function getApiKey() {
  // Usar Key 2 como principal, Key 1 como respaldo
  const keys = [process.env.ODDS_API_KEY_2, process.env.ODDS_API_KEY_1].filter(Boolean);
  if (!keys.length) { console.warn('⚠️ Sin API Keys disponibles'); return null; }
  return keys[0];
}



async function enriquecerConCuotas(eventos) {
  // Si las API keys están activas, intentar usarlas
  if (apiKeysActivas) {
    let cuotasObtenidas = false;
    // ... (código existente de consulta a The Odds API)
    // Si no se obtienen cuotas, desactivar apiKeysActivas
    // Si se obtienen, mantener activo y no usar respaldo
  } else {
    // Si las API keys no están activas, intentar reactivarlas
    // Probar una consulta ligera a The Odds API
    // Si responde con datos, activar apiKeysActivas
  }
  const apiKey = getApiKey();
  if (!apiKey) { console.warn('⚠️ Sin API Key disponible'); return eventos; }

  const sportKeyMap = {
    soccer: 'soccer_uefa_champs_league',
    basketball: 'basketball_nba',
    baseball: 'baseball_mlb',
    mma: 'mma_mixed_martial_arts',
    boxing: 'boxing_boxing'
  };

  const ODDS_API_HOST = 'https://api.the-odds-api.com/v4';
  const axios = require('axios');
  const processedSports = new Set();

  for (const evento of eventos) {
    const sportKey = sportKeyMap[evento.sport];
    if (!sportKey || processedSports.has(sportKey)) continue;
    processedSports.add(sportKey);

    try {
      const res = await axios.get(ODDS_API_HOST + '/sports/' + sportKey + '/odds', {
        params: { apiKey, regions: 'us', markets: 'h2h,spreads,totals', oddsFormat: 'decimal' },
        timeout: 8000
      });
      if (!res.data || !Array.isArray(res.data)) continue;

      for (const match of res.data) {
        const localMatch = evento.local?.toLowerCase().trim();
        const visitanteMatch = evento.visitante?.toLowerCase().trim();
        const homeTeam = match.home_team?.toLowerCase().trim() || '';
        const awayTeam = match.away_team?.toLowerCase().trim() || '';
        
        const localCoincide = localMatch === homeTeam || 
          (localMatch?.slice(0,5) === homeTeam?.slice(0,5));
        const visitanteCoincide = visitanteMatch === awayTeam || 
          (visitanteMatch?.slice(0,5) === awayTeam?.slice(0,5));
        
        if (!localCoincide || !visitanteCoincide) continue;

        const bookmaker = match.bookmakers?.[0];
        if (!bookmaker) continue;

        const h2h = bookmaker.markets?.find(m => m.key === 'h2h');
        if (h2h) {
          h2h.outcomes.forEach(o => {
            if (o.name === match.home_team) evento.cuota_local = o.price;
            else if (o.name === match.away_team) evento.cuota_visitante = o.price;
            else if (o.name === 'Draw' && evento.sport === 'soccer') evento.cuota_empate = o.price;
          });
        }

        const totals = bookmaker.markets?.find(m => m.key === 'totals');
        if (totals) {
          evento.over_under = {};
          totals.outcomes.forEach(o => {
            if (o.name === 'Over') evento.over_under.over = o.price;
            else if (o.name === 'Under') evento.over_under.under = o.price;
          });
        }

        const spreads = bookmaker.markets?.find(m => m.key === 'spreads');
        if (spreads) {
          evento.spreads = {};
          spreads.outcomes.forEach(o => {
            const point = o.point || o.handicap || 0;
            if (o.name === match.home_team) evento.spreads.local = { handicap: point, price: o.price };
            else if (o.name === match.away_team) evento.spreads.visitante = { handicap: point, price: o.price };
          });
        }
      }
    } catch(e) {
      console.error('Error en ' + sportKey + ': ' + e.message);
    }
  }
  return eventos;
}


app.listen(PORT, () => {
  console.log(`✅ BetGroup Pro Proxy v2.0 en puerto ${PORT}`);
});
// Force deploy Mon Jun  1 01:52:30 EDT 2026
// Force deploy v2 Mon Jun  1 02:05:10 EDT 2026
