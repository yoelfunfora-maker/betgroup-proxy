const express = require('express');
const cors = require('cors');
const https = require('https');
const admin = require('firebase-admin');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ==================== FIREBASE ====================

let db;

try {
  const serviceAccountB64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!serviceAccountB64) {
    throw new Error('La variable de entorno FIREBASE_SERVICE_ACCOUNT_B64 no está definida.');
  }

  const serviceAccountJson = Buffer.from(serviceAccountB64, 'base64').toString('utf8');
  const serviceAccount = JSON.parse(serviceAccountJson);
  
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: 'https://betgroup-cuba-2024-default-rtdb.firebaseio.com'
  });
  
  console.log('✅ Firebase Admin SDK inicializado');
  db = admin.database();
} catch(error) {
  console.error('Error al inicializar Firebase Admin SDK:', error.message);
  process.exit(1);
}

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

// ==================== API KEYS ====================

const ODDS_API_KEY_1 = process.env.ODDS_API_KEY_1 || '';
const ODDS_API_KEY_2 = process.env.ODDS_API_KEY_2 || '';

function getApiKey() {
  const hour = new Date().getHours();
  return hour < 12 ? ODDS_API_KEY_1 : ODDS_API_KEY_2;
}

// ==================== ESPN FETCH ====================

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
        try { 
          resolve(JSON.parse(data)); 
        } catch(e) { 
          reject(new Error('Error parsing ESPN response')); 
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(8000, () => { 
      req.destroy(); 
      reject(new Error('ESPN timeout')); 
    });
    req.end();
  });
}

// ==================== PARSE EVENTS ====================

function parseEvents(espnData, sport) {
  const events = [];
  if (!espnData || !espnData.events) return events;

  for (const ev of espnData.events) {
    try {
      let allCompetitors = [];
      let competitionStatus = ev.status?.type;

      if (ev.competitions?.length) {
        allCompetitors = ev.competitions[0].competitors || [];
        competitionStatus = ev.competitions[0].status?.type || competitionStatus;
      } else if (ev.groupings?.length) {
        for (const grouping of ev.groupings) {
          if (grouping.competitions?.length) {
            const latestComp = grouping.competitions[grouping.competitions.length - 1];
            allCompetitors = latestComp.competitors || [];
            competitionStatus = latestComp.status?.type || competitionStatus;
            if (allCompetitors.length >= 2) break;
          }
        }
      }
      
      if (allCompetitors.length < 2) continue;

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

      const getName = (c) => {
        return c?.athlete?.displayName || c?.team?.displayName || 'Desconocido';
      };
      
      const getLogo = (c) => c?.team?.logo || null;

      const status = competitionStatus || ev.status?.type;
      if (!status) continue;
      
      const isLive = status.state === 'in';
      const isScheduled = status.state === 'pre';
      if (!isLive && !isScheduled) continue;

      const homeScore = home.score || '0';
      const awayScore = away.score || '0';

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
        minuto: ev.status?.displayClock || null,
        estado: isLive ? 'live' : 'scheduled',
        horaInicio: ev.date || null,
        cuota_local: 1.8,
        cuota_empate: 3.5,
        cuota_visitante: 2.0
      });
    } catch(e) { 
      /* evento inválido */ 
    }
  }
  
  return events;
}

// ==================== ENRIQUECER CON CUOTAS ====================

async function enriquecerConCuotas(eventos) {
  const apiKey = getApiKey();
  
  if (!apiKey) {
    console.warn('⚠️ Sin The Odds API Key - usando cuotas por defecto');
    return eventos;
  }

  const sportKeyMap = {
    'soccer': 'soccer_epl',
    'basketball': 'basketball_nba',
    'baseball': 'baseball_mlb',
    'mma': 'mma_mixed_martial_arts'
  };

  for (const evento of eventos) {
    const sportKey = sportKeyMap[evento.sport];
    if (!sportKey) continue;

    try {
      const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds?apiKey=${apiKey}&markets=h2h&limit=5`;
      const response = await axios.get(url, { timeout: 5000 });
      
      if (response.data?.data) {
        for (const game of response.data.data) {
          if (
            (game.home_team?.includes(evento.local) || evento.local.includes(game.home_team)) &&
            (game.away_team?.includes(evento.visitante) || evento.visitante.includes(game.away_team))
          ) {
            const bookmakers = game.bookmakers?.[0];
            if (bookmakers?.markets?.[0]?.outcomes) {
              const outcomes = bookmakers.markets[0].outcomes;
              evento.cuota_local = outcomes.find(o => o.name === 'Home')?.price || evento.cuota_local;
              evento.cuota_visitante = outcomes.find(o => o.name === 'Away')?.price || evento.cuota_visitante;
            }
            break;
          }
        }
      }
    } catch(err) {
      console.error(`Error cuotas para ${evento.local} (sportKey: ${sportKey}):`, err.message);
    }
  }

  return eventos;
}

// ==================== PRECALENTAR CACHÉ ====================

async function precalentarCache() {
  console.log('⏳ Precalentando caché...');

  const deportes = [
    { path: 'basketball/nba/scoreboard', sport: 'basketball' },
    { path: 'baseball/mlb/scoreboard', sport: 'baseball' },
    { path: 'soccer/fifa.friendly/scoreboard', sport: 'soccer' },
    { path: 'soccer/fifa.world/scoreboard', sport: 'soccer' },
    { path: 'tennis/wta/scoreboard', sport: 'tennis' },
    { path: 'mma/ufc/scoreboard', sport: 'mma' }
  ];

  let allEvents = [];

  for (const deporte of deportes) {
    try {
      const data = await fetchESPN(deporte.path);
      const eventos = parseEvents(data, deporte.sport);
      allEvents = allEvents.concat(eventos);
    } catch(err) {
      console.error(`Error ${deporte.path}:`, err.message);
    }
  }

  await enriquecerConCuotas(allEvents);

  const response = {
    status: 'online',
    timestamp: new Date().toISOString(),
    total: allEvents.length,
    en_vivo: allEvents.filter(e => e.estado === 'live').length,
    proximos: allEvents.filter(e => e.estado === 'scheduled').length,
    data: allEvents
  };

  setCache('fixtures', response);
  console.log(`✅ Caché precalentado: ${allEvents.length} eventos`);
}

// ==================== ENDPOINTS ====================

app.get('/', (req, res) => {
  res.json({ status: 'online', message: 'BetGroup Pro API v2.0' });
});

app.get('/api/ping', (req, res) => {
  res.json({ ok: true, timestamp: Date.now() });
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'online', 
    uptime: process.uptime(), 
    timestamp: new Date().toISOString() 
  });
});

app.get('/api/fixtures', async (req, res) => {
  try {
    const cached = getCache('fixtures');
    if (cached) {
      return res.json(cached);
    }

    const response = {
      status: 'loading',
      total: 0,
      en_vivo: 0,
      proximos: 0,
      data: []
    };
    
    res.json(response);

    await precalentarCache();
  } catch(err) {
    console.error('Error /api/fixtures:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/apostar', async (req, res) => {
  const { uid, amount, evento, tipo, cuota } = req.body;

  if (!uid || !amount || !evento || !tipo || !cuota) {
    return res.status(400).json({ error: 'Parámetros faltantes' });
  }

  try {
    if (!db) {
      return res.status(500).json({ error: 'Firebase no configurado' });
    }

    const snap = await db.ref(`users/${uid}/creditoReal`).once('value');
    const saldoActual = snap.val();

    if (saldoActual === null || saldoActual < amount) {
      return res.status(400).json({
        error: 'Saldo insuficiente',
        saldoActual: saldoActual || 0
      });
    }

    const saldoNuevo = saldoActual - amount;
    await db.ref(`users/${uid}/creditoReal`).set(saldoNuevo);

    const betId = Date.now().toString();
    await db.ref(`apuestas/${uid}/${betId}`).set({
      eventoNombre: evento,
      tipo: tipo,
      monto: amount,
      cuota: cuota,
      ganancia: Math.floor(amount * cuota),
      estado: 'pendiente',
      fecha: Date.now()
    });

    res.json({
      success: true,
      saldoNuevo: saldoNuevo,
      betId: betId
    });
  } catch(err) {
    console.error('Error /api/apostar:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== INICIAR ====================

app.listen(PORT, () => {
  console.log(`✅ Proxy escuchando en puerto ${PORT}`);
  precalentarCache();
  setInterval(precalentarCache, 3 * 60 * 1000);
});
