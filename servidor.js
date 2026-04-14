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
      const competition = ev.competitions?.[0];
      if (!competition) continue;
      const competitors = competition.competitors || [];
      const home = competitors.find(c => c.homeAway === 'home');
      const away = competitors.find(c => c.homeAway === 'away');
      if (!home || !away) continue;

      const status = ev.status?.type;
      const isLive = status?.state === 'in';
      const isScheduled = status?.state === 'pre';
      if (!isLive && !isScheduled) continue;

      const homeScore = home.score || '0';
      const awayScore = away.score || '0';
      const minute = ev.status?.displayClock || '';
      const period = ev.status?.period || 0;

      // Cuotas realistas basadas en ranking
      const homeRank = parseInt(home.curatedRank?.current || 50);
      const awayRank = parseInt(away.curatedRank?.current || 50);
      // Cuotas dinamicas con margen 15%
      const MARGIN = 1.15;
      const diff = Math.max(-30, Math.min(30, awayRank - homeRank));

      let probHome, probDraw, probAway;
      if(diff > 20){probHome=0.65;probDraw=0.20;probAway=0.15;}
      else if(diff > 10){probHome=0.55;probDraw=0.22;probAway=0.23;}
      else if(diff > 0){probHome=0.45;probDraw=0.27;probAway=0.28;}
      else if(diff > -10){probHome=0.35;probDraw=0.27;probAway=0.38;}
      else if(diff > -20){probHome=0.25;probDraw=0.22;probAway=0.53;}
      else{probHome=0.15;probDraw=0.20;probAway=0.65;}

      const v=()=>(Math.random()*0.10)-0.05;
      probHome=Math.max(0.10,probHome+v());
      probAway=Math.max(0.10,probAway+v());
      probDraw=sport==='soccer'?Math.max(0.10,probDraw+v()):0;

      const baseHome=parseFloat((MARGIN/probHome).toFixed(2));
      const baseDraw=sport==='soccer'?parseFloat((MARGIN/probDraw).toFixed(2)):null;
      const baseAway=parseFloat((MARGIN/probAway).toFixed(2));

      events.push({
        id: ev.id,
        sport,
        liga: espnData.leagues?.[0]?.name || sport,
        ligaLogo: espnData.leagues?.[0]?.logos?.[0]?.href || null,
        local: home.team?.displayName || 'Local',
        visitante: away.team?.displayName || 'Visitante',
        homeLogo: home.team?.logo || null,
        awayLogo: away.team?.logo || null,
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
    proximos: todos.filter(e => e.estado === 'scheduled').length,
    data: todos
  };

  setCache('fixtures', response);
  res.json(response);
});

app.listen(PORT, () => {
  console.log(`✅ BetGroup Pro Proxy v2.0 en puerto ${PORT}`);
});
