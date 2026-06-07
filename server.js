const express = require('express');
const cors = require('cors');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const admin = require('firebase-admin');

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
} catch(error) {
  console.error('Error al inicializar Firebase Admin SDK:', error.message);
  process.exit(1);
}

const db = admin.database();
const auth = admin.auth();

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
      let competitionStatus = ev.status?.type;
      
      if (ev.competitions?.length) {
        allCompetitors = ev.competitions[0].competitors || [];
        competitionStatus = ev.competitions[0].status?.type || competitionStatus;
      } else if (ev.groupings?.length) {
        for (const grouping of ev.groupings) {
          if (grouping.competitions?.length) {
            // Usar la competición más reciente (la última del array)
            const latestComp = grouping.competitions[grouping.competitions.length - 1];
            allCompetitors = latestComp.competitors || [];
            competitionStatus = latestComp.status?.type || competitionStatus;
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
      const getName = (c) => {
        const name = c?.athlete?.displayName || c?.team?.displayName;
        if (name && name !== 'TBD') return name;
        // Para tenis, buscar en notes
        const notes = competition?.notes || [];
        const noteText = notes.find(n => n.type === 'event')?.text || '';
        if (noteText) {
          const match = noteText.match(/(.+) bt (.+)/);
          if (match) {
            const idx = c?.homeAway === 'home' ? 1 : (c?.homeAway === 'away' ? 2 : 0);
            if (idx === 1) return match[1].replace(/\(.*?\)/g, '').trim();
            if (idx === 2) return match[2].replace(/\(.*?\)/g, '').trim();
          }
        }
        return name || 'Desconocido';
      };
      const getLogo = (c) => c?.team?.logo || null;

      // Usar el estado de la competición más reciente (no del evento padre)
      const status = competitionStatus || ev.status?.type;
      if (!status) continue;
      const isLive = status.state === 'in';
      const isScheduled = status.state === 'pre';
      if (!isLive && !isScheduled) continue;

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

      // Filtrar eventos sin nombres reales (TBD)
      if (getName(home) === 'TBD' || getName(away) === 'TBD') continue;

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

app.get('/api/test', (req, res) => {
  res.json({ status: 'ok', message: 'Express funcionando correctamente' });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'online', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

let precargaEnProgreso = false;

app.get('/api/fixtures', async (req, res) => {
  const cached = getCache('fixtures');
  if (cached) return res.json(cached);
  await settleAllPendingBets();
  
  // Si no hay caché, devolver vacío y cargar en background
  res.json({ status: 'loading', total: 0, en_vivo: 0, data: [] });
  
  if (!precargaEnProgreso) {
    precargaEnProgreso = true;
    try {
      await precalentarCache();
    } catch(e) {
      console.error('Error precargando:', e.message);
    }
    precargaEnProgreso = false;
  }
});

// Endpoint original (solo para referencia, no se usa)
app.get('/api/fixtures_old', async (req, res) => {
  const deportes = [
    // === ACTIVOS (Junio 2026) ===
    { path: 'basketball/nba/scoreboard',                sport: 'basketball' },  // 1 evento (NBA Finals)
    { path: 'baseball/mlb/scoreboard',                  sport: 'baseball' },    // 15 eventos (temporada regular)
    { path: 'soccer/fifa.friendly/scoreboard',           sport: 'soccer' },     // 7 eventos (amistosos)
    { path: 'soccer/fifa.world/scoreboard',              sport: 'soccer' },     // 2 eventos (Mundial próximo)
    { path: 'tennis/wta/scoreboard',                     sport: 'tennis' },     // 1 evento
    { path: 'mma/ufc/scoreboard',                        sport: 'mma' },        // 1 evento
    // === FUERA DE TEMPORADA (comentados para ahorrar tiempo) ===
    // { path: 'soccer/esp.1/scoreboard',                  sport: 'soccer' },  // LaLiga
    // { path: 'soccer/eng.1/scoreboard',                  sport: 'soccer' },  // Premier
    // { path: 'soccer/ger.1/scoreboard',                  sport: 'soccer' },  // Bundesliga
    // { path: 'soccer/ita.1/scoreboard',                  sport: 'soccer' },  // Serie A
    // { path: 'soccer/fra.1/scoreboard',                  sport: 'soccer' },  // Ligue 1
    // { path: 'soccer/uefa.champions/scoreboard',         sport: 'soccer' },  // Champions
    // { path: 'soccer/conmebol.libertadores/scoreboard',  sport: 'soccer' },  // Libertadores
    // { path: 'soccer/usa.1/scoreboard',                  sport: 'soccer' },  // MLS
    // { path: 'tennis/atp/scoreboard',                     sport: 'tennis' }, // ATP
  ];

  const todos = [];

  cat << 'EOFNEW'
// Ejecutar con delay para evitar rate limiting de ESPN
for (const deporte of deportes) {
  try {
    const data = await fetchESPN(deporte.path);
    const eventos = parseEvents(data, deporte.sport);
    todos.push(...eventos);
  } catch(e) {
    console.error(`Error en ${deporte.path}:`, e.message);
  }
  await new Promise(r => setTimeout(r, 500)); // Esperar 500ms entre peticiones
}

EOFNEW

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
  const apiKey = getApiKey();
  if (!apiKey) { console.warn('⚠️ Sin API Key disponible'); return eventos; }

  const sportKeyMap = {
    soccer: 'soccer_uefa_champs_league',
    basketball: 'basketball_nba',
    baseball: 'baseball_mlb',
    mma: 'mma_mixed_martial_arts',
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


// Precargar caché al iniciar y refrescar cada 3 minutos
// Versión final con Promise.allSettled (recomendado por Porthos)
async function precalentarCache() {
  console.log('🔄 Precargando caché con Promise.allSettled...');
  const deportesActivos = [
    { path: 'basketball/nba/scoreboard',                sport: 'basketball' },
    { path: 'baseball/mlb/scoreboard',                  sport: 'baseball' },
    { path: 'soccer/fifa.friendly/scoreboard',           sport: 'soccer' },
    { path: 'soccer/fifa.world/scoreboard',              sport: 'soccer' },
    { path: 'tennis/wta/scoreboard',                     sport: 'tennis' },
    { path: 'mma/ufc/scoreboard',                        sport: 'mma' },
  ];

  const resultados = await Promise.allSettled(
    deportesActivos.map(({ path, sport }) => 
      fetchESPN(path).then(data => parseEvents(data, sport)).catch(() => [])
    )
  );

  const todos = [];
  resultados.forEach(r => {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      todos.push(...r.value);
    }
  });

  try {
    await enriquecerConCuotas(todos);
  } catch(e) {
    console.error('Error enriqueciendo cuotas:', e.message);
  }

  todos.sort((a, b) => (a.estado === 'live' ? -1 : 1));
  const response = {
    status: 'online',
    timestamp: new Date().toISOString(),
    total: todos.length,
    en_vivo: todos.filter(e => e.estado === 'live').length,
    proximos: todos.filter(e => e.estado === 'scheduled').length,
    data: todos
  };
  setCache('fixtures', response);
  console.log('✅ Caché actualizada: ' + todos.length + ' eventos');
  return response;
}

// Iniciar precarga en background (sin bloquear el arranque)
precalentarCache().catch(e => console.error('Error precarga inicial:', e.message));
// setInterval(() => precalentarCache().catch(e => console.error('Error refresco:', e.message)), 3 * 60 * 1000);


// ==================== ENDPOINT DE APUESTAS (Admin SDK) ====================
// ════════════════════════════════════════════════════════════════════
// 🔐 VALIDACIÓN DE TOKEN - PROTEGER /api/apostar
// ════════════════════════════════════════════════════════════════════

function validarTokenFirebase(token) {
  // Validar que el token sea un string válido
  if (!token || typeof token !== 'string') {
    return { valido: false, error: 'Token requerido' };
  }
  
  // Formato: "Bearer <token>"
  if (!token.startsWith('Bearer ')) {
    return { valido: false, error: 'Formato inválido (Bearer required)' };
  }
  
  const actualToken = token.slice(7); // Quitar "Bearer "
  
  // Validar longitud mínima
  if (actualToken.length < 100) {
    return { valido: false, error: 'Token inválido (muy corto)' };
  }
  
  return { valido: true, token: actualToken };
}

// Middleware de protección
async function protegerApostar(req, res, next) {
  const auth = req.headers.authorization;
  const validacion = validarTokenFirebase(auth);
  
  if (!validacion.valido) {
    console.log('[APOSTAR] ❌ No autorizado:', validacion.error);
    return res.status(401).json({ 
      error: validacion.error,
      code: 'UNAUTHORIZED'
    });
  }
  
  console.log('[APOSTAR] ✅ Token válido, procediendo...');
  req.token = validacion.token;
  next();
}

// Reemplazar el endpoint anterior
app.post('/api/apostar', protegerApostar, async (req, res) => {
  try {
    const { uid, eventoId, cantidad, tipoApuesta, cuota } = req.body;
    
    if (!uid || !eventoId || !cantidad || !tipoApuesta || !cuota) {
      return res.status(400).json({ error: 'Faltan parámetros' });
    }
    
    console.log(`[APOSTAR] ${uid} → ${eventoId} (${tipoApuesta} $${cantidad})`);
    
    // Crear apuesta en Firebase
    const ref = admin.database().ref(`apuestas/${uid}`);
    const betId = Date.now();
    
    await ref.child(betId).set({
      betId: betId,
      eventoId: eventoId,
      tipo: tipoApuesta,
      monto: cantidad,
      cuota: cuota,
      ganancia: 0,
      estado: 'pendiente',
      fecha: new Date().toISOString()
    });
    
    // Notificar Telegram
    const msgTG = `💰 <b>NUEVA APUESTA</b>\n👤 ${uid}\n📊 ${tipoApuesta}\n💵 $${cantidad}\n📈 Cuota: ${cuota}x`;
    try { await tgNotify(msgTG); } catch(e) { console.log('[TG] Error:', e.message); }
    
    res.json({ 
      success: true, 
      betId: betId,
      mensaje: 'Apuesta registrada'
    });
    
  } catch(e) {
    console.error('[APOSTAR] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/ping', (req, res) => {
  res.json({ ok: true, timestamp: Date.now() });
});


// ==================== LIQUIDACIÓN DE APUESTAS ====================

app.get('/api/settle', async (req, res) => {
  try {
    const apuestasRef = db.ref('apuestas');
    const snapshot = await apuestasRef.once('value');
    const allApuestas = snapshot.val();
    const settledBets = [];

    if (!allApuestas) {
      return res.json({ message: 'No hay apuestas pendientes.' });
    }

    for (const userId in allApuestas) {
      for (const betId in allApuestas[userId]) {
        const apuesta = allApuestas[userId][betId];

        if (apuesta.estado !== 'pendiente') continue;

        // Intentar obtener el resultado del evento desde la caché del proxy
        await precalentarCache();
    const fixturesCache = getCache('fixtures');
        let eventResult = null;
        if (fixturesCache && fixturesCache.data) {
          eventResult = fixturesCache.data.find(e =>
            (e.local + ' vs ' + e.visitante) === apuesta.eventoNombre ||
            (e.visitante + ' vs ' + e.local) === apuesta.eventoNombre
          );
        }

        if (!eventResult || eventResult.estado === 'scheduled' || eventResult.estado === 'live') {
          continue; // Evento no terminado aún
        }

        const [homeScore, awayScore] = (eventResult.marcador || '0-0').split('-').map(Number);
        let resultadoReal;
        if (homeScore > awayScore) resultadoReal = 'Local';
        else if (awayScore > homeScore) resultadoReal = 'Visitante';
        else resultadoReal = 'Empate';

        let hasWon = false;
        switch (apuesta.tipo) {
          case 'Local': hasWon = (resultadoReal === 'Local'); break;
          case 'Visitante': hasWon = (resultadoReal === 'Visitante'); break;
          case 'Empate': hasWon = (resultadoReal === 'Empate'); break;
          case 'Local -0.5': hasWon = (homeScore > awayScore); break;
          case 'Visit +0.5': hasWon = (awayScore >= homeScore); break;
          case '1X': hasWon = (resultadoReal === 'Local' || resultadoReal === 'Empate'); break;
          case 'X2': hasWon = (resultadoReal === 'Visitante' || resultadoReal === 'Empate'); break;
          case '12': hasWon = (resultadoReal === 'Local' || resultadoReal === 'Visitante'); break;
          default: continue;
        }

        const newEstado = hasWon ? 'ganada' : 'perdida';
        await db.ref('apuestas/' + userId + '/' + betId).update({ estado: newEstado });

        if (hasWon) {
          const ganancia = Math.floor(apuesta.monto * apuesta.cuota);
          const userSnap = await db.ref('users/' + userId + '/creditoReal').once('value');
          const saldoActual = userSnap.val() || 0;
          await db.ref('users/' + userId + '/creditoReal').set(saldoActual + ganancia);
        }

        settledBets.push({
          userId,
          betId,
          evento: apuesta.eventoNombre,
          tipo: apuesta.tipo,
          resultado: newEstado,
          marcador: eventResult.marcador
        });
      }
    }

    res.json({
      success: true,
      total: settledBets.length,
      bets: settledBets
    });

  } catch(e) {
    console.error('Error en /api/settle:', e.message);
    res.status(500).json({ error: e.message });
  }
});



// ==================== LIQUIDACIÓN MANUAL DE APUESTAS ====================

app.post('/api/settle-manual', async (req, res) => {
  try {
    const { eventName, marcador } = req.body;
    if (!eventName || !marcador) {
      return res.status(400).json({ error: 'Faltan eventName o marcador' });
    }

    const [homeScore, awayScore] = marcador.split('-').map(Number);
    if (isNaN(homeScore) || isNaN(awayScore)) {
      return res.status(400).json({ error: 'Formato de marcador inválido. Use: 2-1' });
    }

    let resultadoReal;
    if (homeScore > awayScore) resultadoReal = 'Local';
    else if (awayScore > homeScore) resultadoReal = 'Visitante';
    else resultadoReal = 'Empate';

    const apuestasRef = db.ref('apuestas');
    const snapshot = await apuestasRef.once('value');
    const allApuestas = snapshot.val();
    const settledBets = [];

    if (!allApuestas) {
      return res.json({ success: true, total: 0, bets: [], message: 'No hay apuestas' });
    }

    for (const userId in allApuestas) {
      for (const betId in allApuestas[userId]) {
        const apuesta = allApuestas[userId][betId];

        if (apuesta.estado !== 'pendiente') continue;

        // Buscar coincidencia flexible con el nombre del evento
        const apuestaNombre = (apuesta.eventoNombre || '').toLowerCase();
        const eventNameLower = eventName.toLowerCase();
        if (!apuestaNombre.includes(eventNameLower) && !eventNameLower.includes(apuestaNombre)) {
          continue;
        }

        let hasWon = false;
        switch (apuesta.tipo) {
          case 'Local': hasWon = (resultadoReal === 'Local'); break;
          case 'Visitante': hasWon = (resultadoReal === 'Visitante'); break;
          case 'Empate': hasWon = (resultadoReal === 'Empate'); break;
          case 'Local -0.5': hasWon = (homeScore > awayScore); break;
          case 'Visit +0.5': hasWon = (awayScore >= homeScore); break;
          case '1X': hasWon = (resultadoReal === 'Local' || resultadoReal === 'Empate'); break;
          case 'X2': hasWon = (resultadoReal === 'Visitante' || resultadoReal === 'Empate'); break;
          case '12': hasWon = (resultadoReal === 'Local' || resultadoReal === 'Visitante'); break;
          default: continue;
        }

        const newEstado = hasWon ? 'ganada' : 'perdida';
        await db.ref('apuestas/' + userId + '/' + betId).update({ estado: newEstado });

        if (hasWon) {
          const ganancia = Math.floor(apuesta.monto * apuesta.cuota);
          const userSnap = await db.ref('users/' + userId + '/creditoReal').once('value');
          const saldoActual = userSnap.val() || 0;
          await db.ref('users/' + userId + '/creditoReal').set(saldoActual + ganancia);
        }

        settledBets.push({
          userId,
          betId,
          evento: apuesta.eventoNombre,
          tipo: apuesta.tipo,
          resultado: newEstado,
          marcador: marcador
        });
      }
    }

    res.json({
      success: true,
      total: settledBets.length,
      bets: settledBets
    });

  } catch(e) {
    console.error('Error en /api/settle-manual:', e.message);
    res.status(500).json({ error: e.message });
  }
});



// ==================== LIQUIDACIÓN AUTOMÁTICA INTERNA ====================


app.get('/api/settle-internal', async (req, res) => {
  const result = await settleAllPendingBets();
  res.json({ success: true, ...result });
});


// ==================== ENDPOINT MANUAL ====================
app.post('/api/settle-manual-marcador', async (req, res) => {
  try {
    const { eventoNombre, marcador } = req.body;
    if (!eventoNombre || !marcador) return res.json({ success: false, msg: 'Falta evento' });
    await db.ref('marcadosCompletados/' + eventoNombre).set({ marcador, ts: Date.now() });
    const result = await settleAllPendingBets();
    res.json({ success: true, liquidadas: result.total });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});



// ==================== PRECALENTAMIENTO A HORARIOS ESPECÍFICOS ====================
function schedulePrecalentarCache() {
  function checkAndRun() {
    const now = new Date();
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();
    if ((hour === 8 && minute === 0) || (hour === 14 && minute === 0)) {
      console.log('[SCHEDULED] Precalentamiento a ' + now.toISOString());
      precalentarCache().catch(e => console.error('Error:', e.message));
    }
  }
  setInterval(checkAndRun, 60 * 1000);
  console.log('⏰ API Precalentamiento: 8:00 AM y 2:00 PM UTC');
}
schedulePrecalentarCache();

// ==================== TELEGRAM NOTIFICATIONS ====================
async function tgNotify(mensaje) {
  try {
    const token = process.env.TG_TOKEN || '8671464180:AAHhu_Ct9-3Q6Arjle-7Xy4DyUGuuNvraBs';
    const chatId = process.env.TG_CHAT || '-5154764705';
    
    console.log('[TG] Enviando notificación...');
    console.log('[TG] Token exists:', !!token);
    console.log('[TG] ChatId exists:', !!chatId);
    
    if (!token || !chatId) {
      console.error('[TG] Falta TG_TOKEN o TG_CHAT');
      return;
    }
    
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const body = JSON.stringify({ chat_id: chatId, text: mensaje, parse_mode: 'HTML' });
    
    const response = await fetch(url, { 
      method: 'POST', 
      headers: { 'Content-Type': 'application/json' }, 
      body 
    });
    
    const result = await response.json();
    
    if (response.ok) {
      console.log('[TG] ✅ Enviado:', result.result.message_id);
    } else {
      console.error('[TG] ❌ Error:', result.description);
    }
  } catch(e) {
    console.error('[TG] Exception:', e.message);
  }
}

// ==================== LIQUIDACIÓN AUTOMÁTICA ====================
async function settleAllPendingBets() {
  try {
    const apuestasRef = db.ref('apuestas');
    const snapshot = await apuestasRef.once('value');
    const allApuestas = snapshot.val();
    if (!allApuestas) return { total: 0, bets: [] };

    const settledBets = [];
    const fixturesCache = getCache('fixtures');

    for (const userId in allApuestas) {
      for (const betId in allApuestas[userId]) {
        const apuesta = allApuestas[userId][betId];
        if (apuesta.estado !== 'pendiente') continue;

        let marcador = null;

        // PASO 1: Buscar en caché de ESPN
        if (fixturesCache && fixturesCache.data) {
          const eventResult = fixturesCache.data.find(e => {
            const e1 = (e.local + ' vs ' + e.visitante).toLowerCase().trim().replace(/\s+/g, ' ');
            const e2 = (e.visitante + ' vs ' + e.local).toLowerCase().trim().replace(/\s+/g, ' ');
            const ap = apuesta.eventoNombre.toLowerCase().trim().replace(/\s+/g, ' ');
            return e1 === ap || e2 === ap;
          });
          if (eventResult && eventResult.marcador && eventResult.estado === 'finished') {
            marcador = eventResult.marcador;
          }
        }

        // PASO 2: Si no está en ESPN, buscar en Firebase
        if (!marcador) {
          try {
            const eventoNormalizado = apuesta.eventoNombre.toLowerCase().trim().replace(/\s+/g, ' ');
            const snap = await db.ref('marcadosCompletados/' + eventoNormalizado).once('value');
            const data = snap.val();
            if (data && data.marcador) marcador = data.marcador;
          } catch(e) {}
        }

        if (!marcador) continue;

        // Validación: No liquidar eventos aún en vivo
        if (eventResult && eventResult.estado === 'live') {
          console.log('[SKIP-LIVE]', apuesta.eventoNombre, '- Aún en transmisión');
          continue;
        }

        // PASO 3: Procesar resultado
        const [homeScore, awayScore] = marcador.split('-').map(Number);
        let resultadoReal = homeScore > awayScore ? 'Local' : awayScore > homeScore ? 'Visitante' : 'Empate';

        let hasWon = false;
        switch (apuesta.tipo) {
          case 'Local': hasWon = (resultadoReal === 'Local'); break;
          case 'Visitante': hasWon = (resultadoReal === 'Visitante'); break;
          case 'Empate': hasWon = (resultadoReal === 'Empate'); break;
          case 'Local -0.5': hasWon = (homeScore > awayScore); break;
          case 'Visit +0.5': hasWon = (awayScore >= homeScore); break;
          case '1X': hasWon = (resultadoReal === 'Local' || resultadoReal === 'Empate'); break;
          case 'X2': hasWon = (resultadoReal === 'Visitante' || resultadoReal === 'Empate'); break;
          case '12': hasWon = (resultadoReal === 'Local' || resultadoReal === 'Visitante'); break;
        }

        const newEstado = hasWon ? 'ganada' : 'perdida';
        await db.ref('apuestas/' + userId + '/' + betId).update({ estado: newEstado });

        if (hasWon) {
          const ganancia = Math.floor(apuesta.monto * apuesta.cuota);
          const userSnap = await db.ref('users/' + userId + '/creditoReal').once('value');
          const saldoActual = userSnap.val() || 0;
          await db.ref('users/' + userId + '/creditoReal').set(saldoActual + ganancia);
        }

        settledBets.push({ userId, betId, evento: apuesta.eventoNombre, tipo: apuesta.tipo, resultado: newEstado, marcador });
      }
    }

    if (settledBets.length > 0) {
      try {
        let msg = '🤖 <b>LIQUIDACIÓN</b>\n📅 ' + new Date().toLocaleString() + '\n📊 Total: ' + settledBets.length + '\n\n';
        for (let i = 0; i < settledBets.length; i++) {
          const bet = settledBets[i];
          msg += '• ' + bet.evento + ' → ' + (bet.resultado === 'ganada' ? '✅' : '❌') + ' (' + bet.marcador + ')\n';
        }
        await tgNotify(msg);
      } catch(e) { console.error('[TG]', e.message); }
    }

    console.log('[SETTLE]', settledBets.length, 'liquidadas');
    return { total: settledBets.length, bets: settledBets };
  } catch(e) {
    console.error('[SETTLE] Error:', e.message);
    return { total: 0, error: e.message };
  }
}
// ==================== TEST TELEGRAM ====================
app.get("/api/test-telegram", async (req, res) => {
  try {
    const ts = new Date().toLocaleString();
    const msg = "🧪 <b>TEST TELEGRAM</b>\n📅 " + ts + "\n✅ FUNCIONA";
    console.log("[TEST-TG] Enviando...");
    await tgNotify(msg);
    res.json({ success: true, timestamp: ts });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

app.get('/api/daily-tasks', async (req, res) => {
  res.json({ timestamp: new Date().toISOString(), status: 'ok', message: 'Endpoint de diagnóstico diario activo' });
});
// Endpoint para que agentes externos (Replit) envien notificaciones
app.post('/api/notify', async (req, res) => {
  try {
    const { mensaje } = req.body;
    await tgNotify(mensaje);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
// Endpoint para recibir órdenes para los agentes
app.post('/api/agent-order', async (req, res) => {
  try {
    const { agente, tarea, parametros } = req.body;
    console.log(`[AGENTE] Orden recibida: ${agente} → ${tarea}`);
    let resultado;
    if (agente === 'athos') {
      const https = require('https');
      const data = JSON.stringify({ api_key: process.env.TAVILY_KEY || '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', query: parametros || tarea, search_depth: 'basic', max_results: 3 });
      resultado = await new Promise((resolve, reject) => {
        const req = https.request({ hostname: 'api.tavily.com', path: '/search', method: 'POST', headers: { 'Content-Type': 'application/json' } }, r => { let d=''; r.on('data', c => d+=c); r.on('end', () => resolve(JSON.parse(d))); });
        req.on('error', reject); req.write(data); req.end();
      });
    } else if (agente === 'porthos') {
      resultado = { mensaje: 'Porthos debe ejecutarse en Replit con node agentes/porthos.js' };
    } else {
      return res.status(400).json({ error: 'Agente no reconocido' });
    }
    res.json({ success: true, agente, tarea, resultado });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.listen(PORT, () => {
  console.log(`✅ BetGroup Pro Proxy v2.0 en puerto ${PORT}`);
});
// Force deploy Mon Jun  1 01:52:30 EDT 2026

// ==================== MOTOR AUTOMÁTICO DE LIQUIDACIÓN ====================
setInterval(async () => {
  console.log('[AUTO-SETTLE] Ejecutando liquidación automática...');
  await settleAllPendingBets();
}, 10 * 60 * 1000); // Cada 10 minutos

console.log('⏰ Motor automático de liquidación activado (cada 10 minutos).');

// Force deploy v2 Mon Jun  1 02:05:10 EDT 2026

// ════════════════════════════════════════════════════════════════════
// 🔧 ENDPOINT DE LIQUIDACIÓN (TESTING/ADMIN)
// ════════════════════════════════════════════════════════════════════

app.post('/api/liquidar', async (req, res) => {
  try {
    const { uid, betId, estado, ganancia, marcador } = req.body;
    
    if (!uid || !betId || !estado) {
      return res.status(400).json({ error: 'Faltan parámetros' });
    }

    console.log(`[LIQUIDAR] ${uid} - ${betId} - ${estado}`);

    // Actualizar en Firebase
    const ref = admin.database().ref(`apuestas/${uid}/${betId}`);
    await ref.update({
      estado: estado,
      ganancia: ganancia || 0,
      marcadorFinal: marcador || 'Liquidado',
      resueltoEn: Date.now()
    });

    // Enviar notificación Telegram
    const msgTG = `✅ <b>APUESTA LIQUIDADA</b>\n💰 ${betId}\n📊 Estado: ${estado}\n💵 Ganancia: $${ganancia}\n📝 ${marcador || 'Sin marcador'}`;
    try { await tgNotify(msgTG); } catch(e) { console.log('[TG] Error:', e.message); }

    // Verificar que se guardó
    const snap = await ref.once('value');
    const datos = snap.val();

    res.json({
      success: true,
      betId: betId,
      estado: datos.estado,
      ganancia: datos.ganancia
    });

  } catch(e) {
    console.error('[LIQUIDAR ERROR]', e.message);
    res.status(500).json({ error: e.message });
  }
});

