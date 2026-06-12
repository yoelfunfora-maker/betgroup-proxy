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
    throw new Error('FIREBASE_SERVICE_ACCOUNT_B64 no está definida.');
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
  console.error('❌ Error Firebase:', error.message);
  process.exit(1);
}

// ==================== TELEGRAM ====================
const TELEGRAM_BOT_TOKEN = '8671464180:AAHhu_Ct9-3Q6Arjle-7Xy4DyUGuuNvraBs';
const TELEGRAM_CHAT_ID = '-5154764705';

function notifyTelegram(texto) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  require('https').get(`${url}?chat_id=${TELEGRAM_CHAT_ID}&text=${encodeURIComponent(texto)}`).on('error', () => {});
}

process.on('uncaughtException', (err) => {
  console.error('❌ Error:', err.message);
  notifyTelegram(`🚨 BetGroup ERROR: ${err.message}`);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Rechazo:', reason);
  notifyTelegram(`⚠️ BetGroup RECHAZO: ${reason?.message || reason}`);
});

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
function getApiKey() {
  const hour = new Date().getHours();
  if (hour === 0)  return 'e18abd8956512f34027f0ac3f87fbe52';
  if (hour === 8)  return 'e18abd8956512f34027f0ac3f87fbe52';
  if (hour === 14) return '0e31c3149f0afbb009491a0cd80169f4';
  if (hour === 18) return '0e31c3149f0afbb009491a0cd80169f4';
  return '0e31c3149f0afbb009491a0cd80169f4'; // DEFAULT: clave que funciona
}

const TAVILY_API_KEY = process.env.TAVILY_API_KEY || '';

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
        try { resolve(JSON.parse(data)); } catch(e) { reject(new Error('ESPN parse')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('ESPN timeout')); });
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
        if (!home && !away) { home = allCompetitors[0]; away = allCompetitors[1]; }
      } else {
        home = allCompetitors[0];
        away = allCompetitors[1];
      }

      const getName = (c) => c?.athlete?.displayName || c?.team?.displayName || 'Desconocido';
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
        cuota_local: null,
        cuota_empate: null,
        cuota_visitante: null
      });
    } catch(e) { }
  }

  return events;
}

// ==================== NORMALIZACIÓN MEJORADA ====================

function normalizarNombre(nombre) {
  if (!nombre) return '';
  
  return nombre
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // tildes
    .replace(/\b(fc|cf|as|vs|ud|cd|fff)\b/g, '') // abreviaturas
    .replace(/[^a-z0-9ñ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ==================== SIMILITUD DE JACCARD ====================

function jaccardSimilarity(str1, str2) {
  const tokens1 = new Set(str1.split(' ').filter(t => t.length > 1));
  const tokens2 = new Set(str2.split(' ').filter(t => t.length > 1));
  
  if (tokens1.size === 0 && tokens2.size === 0) return 1.0;
  if (tokens1.size === 0 || tokens2.size === 0) return 0.0;
  
  const interseccion = new Set([...tokens1].filter(x => tokens2.has(x)));
  const union = new Set([...tokens1, ...tokens2]);
  
  return interseccion.size / union.size;
}

// ==================== DISTANCIA DE LEVENSHTEIN ====================

function levenshteinDistance(s1, s2) {
  const len1 = s1.length;
  const len2 = s2.length;
  const d = Array(len2 + 1).fill(0).map(() => Array(len1 + 1).fill(0));
  
  for (let i = 0; i <= len1; i++) d[0][i] = i;
  for (let j = 0; j <= len2; j++) d[j][0] = j;
  
  for (let j = 1; j <= len2; j++) {
    for (let i = 1; i <= len1; i++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      d[j][i] = Math.min(
        d[j][i - 1] + 1,
        d[j - 1][i] + 1,
        d[j - 1][i - 1] + cost
      );
    }
  }
  
  return d[len2][len1];
}

function levenshteinSimilarity(s1, s2) {
  const maxLen = Math.max(s1.length, s2.length);
  if (maxLen === 0) return 1.0;
  return 1 - (levenshteinDistance(s1, s2) / maxLen);
}

// ==================== PUNTUACIÓN DE SIMILITUD MULTI-CRITERIO ====================

function calcularPuntuacionSimilitud(evento, game) {
  const localNorm = normalizarNombre(evento.local);
  const visitanteNorm = normalizarNombre(evento.visitante);
  const homeNorm = normalizarNombre(game.home_team || '');
  const awayNorm = normalizarNombre(game.away_team || '');
  
  // COINCIDENCIA DIRECTA: local = home, visitante = away
  const jaccardHome = jaccardSimilarity(localNorm, homeNorm);
  const jaccardAway = jaccardSimilarity(visitanteNorm, awayNorm);
  const levenHome = levenshteinSimilarity(localNorm, homeNorm);
  const levenAway = levenshteinSimilarity(visitanteNorm, awayNorm);
  
  const puntuacionDirecta = (jaccardHome * 0.4 + levenHome * 0.35) + (jaccardAway * 0.4 + levenAway * 0.35);
  
  // COINCIDENCIA CRUZADA: local = away, visitante = home
  const jaccardHomeX = jaccardSimilarity(localNorm, awayNorm);
  const jaccardAwayX = jaccardSimilarity(visitanteNorm, homeNorm);
  const levenHomeX = levenshteinSimilarity(localNorm, awayNorm);
  const levenAwayX = levenshteinSimilarity(visitanteNorm, homeNorm);
  
  const puntuacionCruzada = (jaccardHomeX * 0.4 + levenHomeX * 0.35) + (jaccardAwayX * 0.4 + levenAwayX * 0.35);
  
  return {
    directa: puntuacionDirecta,
    cruzada: puntuacionCruzada,
    mejor: Math.max(puntuacionDirecta, puntuacionCruzada),
    tipo: puntuacionDirecta > puntuacionCruzada ? 'directa' : 'cruzada'
  };
}

// ==================== CACHÉ ODDS ====================
const oddsCache = {};

// ==================== ENRIQUECER CON CUOTAS (MEJORADO) ====================

async function enriquecerConCuotas(eventos) {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.warn('⚠️ Sin API Key');
    return eventos;
  }

  const sportKeyMap = {
    'soccer': 'soccer_epl',
    'basketball': 'basketball_nba',
    'baseball': 'baseball_mlb',
    'mma': 'mma_mixed_martial_arts'
  };

  const grupos = {};
  for (const evento of eventos) {
    const sportKey = sportKeyMap[evento.sport];
    if (!sportKey) continue;
    if (!grupos[sportKey]) grupos[sportKey] = [];
    grupos[sportKey].push(evento);
  }

  for (const [sportKey, eventosGrupo] of Object.entries(grupos)) {
    let juegos = null;
    const cacheEntry = oddsCache[sportKey];

    // Usar caché si es válido (< 12h)
    if (cacheEntry && (Date.now() - cacheEntry.timestamp) < 12 * 60 * 60 * 1000 && cacheEntry.data?.length > 0) {
      juegos = cacheEntry.data;
      console.log(`📦 Usando caché para ${sportKey} (${juegos.length} juegos)`);
    } else {
      try {
        console.log(`🔍 Obteniendo ${sportKey} de Odds API...`);
        const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds?apiKey=${apiKey}&markets=h2h&regions=us`;
        const response = await axios.get(url, { timeout: 8000 });
        
        if (response.data) {
          juegos = response.data.data || response.data;
          oddsCache[sportKey] = { data: juegos, timestamp: Date.now() };
          console.log(`✅ Obtenidos ${juegos.length} juegos de ${sportKey}`);
        }
      } catch(err) {
        console.error(`❌ Error ${sportKey}:`, err.message);
        continue;
      }
    }

    if (!juegos || juegos.length === 0) {
      console.warn(`⚠️ Sin juegos para ${sportKey}`);
      continue;
    }

    // Procesar cada evento con el NUEVO MOTOR DE SIMILITUD MULTI-CRITERIO
    for (const evento of eventosGrupo) {
      let mejorCoincidencia = null;
      let mejorPuntuacion = 0;
      const UMBRAL_MINIMO = 0.70; // 70% de similitud requerido

      for (const game of juegos) {
        const puntuacion = calcularPuntuacionSimilitud(evento, game);
        
        // Usar la mejor puntuación (directa o cruzada)
        if (puntuacion.mejor > mejorPuntuacion && puntuacion.mejor >= UMBRAL_MINIMO) {
          mejorPuntuacion = puntuacion.mejor;
          mejorCoincidencia = {
            game: game,
            tipo: puntuacion.tipo,
            puntuacion: puntuacion.mejor
          };
        }
      }

      if (mejorCoincidencia) {
        const game = mejorCoincidencia.game;
        const bookmakers = game.bookmakers?.[0];
        
        if (bookmakers?.markets?.[0]?.outcomes) {
          const outcomes = bookmakers.markets[0].outcomes;
          
          if (mejorCoincidencia.tipo === 'directa') {
            // local = home, visitante = away
            evento.cuota_local = outcomes.find(o => o.name === 'Home')?.price || null;
            evento.cuota_visitante = outcomes.find(o => o.name === 'Away')?.price || null;
          } else {
            // local = away, visitante = home (CRUZADO)
            evento.cuota_local = outcomes.find(o => o.name === 'Away')?.price || null;
            evento.cuota_visitante = outcomes.find(o => o.name === 'Home')?.price || null;
          }
          
          evento.cuota_empate = outcomes.find(o => o.name === 'Draw')?.price || null;
          
          if (evento.cuota_local && evento.cuota_visitante) {
            console.log(`✅ ${evento.local} vs ${evento.visitante} (${mejorCoincidencia.tipo}, puntuación: ${mejorPuntuacion.toFixed(3)}): ${evento.cuota_local} - ${evento.cuota_visitante}`);
          }
        }
      } else {
        console.warn(`⚠️ Sin coincidencia > ${UMBRAL_MINIMO * 100}% para: ${evento.local} vs ${evento.visitante}`);
      }
    }
  }

  return eventos;
}

// ==================== ATHOS (TAVILY) ====================

async function enriquecerConAthos(eventos) {
  if (!TAVILY_API_KEY) {
    console.warn('⚠️ Sin TAVILY_API_KEY');
    return eventos;
  }

  for (const evento of eventos) {
    if (evento.cuota_local > 1.0 && evento.cuota_visitante > 1.0) continue;

    const query = `cuotas apuestas ${evento.local} vs ${evento.visitante} ${evento.liga}`;

    try {
      const response = await axios.post('https://api.tavily.com/search', {
        api_key: TAVILY_API_KEY,
        query: query,
        search_depth: 'advanced',
        max_results: 5
      }, { timeout: 10000 });

      const cuotas = extraerCuotas(response.data?.results || []);
      if (cuotas) {
        evento.cuota_local = cuotas.local;
        evento.cuota_visitante = cuotas.visitante;
        evento.cuota_empate = cuotas.empate || 3.5;
        console.log(`🌐 Athos: ${evento.local} = ${evento.cuota_local}`);
      }
    } catch(err) {
      console.error(`Athos error: ${err.message}`);
    }
  }
  return eventos;
}

function extraerCuotas(results) {
  const patron = /(\d+\.\d{2})/g;
  let todas = [];

  for (const r of results) {
    const matches = r.content?.match(patron) || [];
    todas = todas.concat(matches.map(Number));
  }

  if (todas.length >= 2) {
    return { local: todas[0], visitante: todas[1] };
  }
  return null;
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

  console.log(`📊 ESPN: ${allEvents.length} eventos obtenidos`);

  // Enriquecer con cuotas
  await enriquecerConCuotas(allEvents);

  // Si faltan cuotas, usar Athos
  const sinCuotas = allEvents.filter(e => !e.cuota_local || e.cuota_local <= 1.0);
  if (sinCuotas.length > 0) {
    console.log(`🌐 Athos buscando ${sinCuotas.length} cuotas...`);
    await enriquecerConAthos(allEvents);
  }

  const conCuotas = allEvents.filter(e => e.cuota_local && e.cuota_local > 1.0).length;
  console.log(`✅ Total con cuotas reales: ${conCuotas}/${allEvents.length}`);

  const response = {
    status: 'online',
    timestamp: new Date().toISOString(),
    total: allEvents.length,
    en_vivo: allEvents.filter(e => e.estado === 'live').length,
    proximos: allEvents.filter(e => e.estado === 'scheduled').length,
    con_cuotas: conCuotas,
    data: allEvents
  };

  setCache('fixtures', response);
}

// ==================== ENDPOINTS ====================

app.get('/', (req, res) => {
  res.json({ status: 'online', message: 'BetGroup Pro API v8.5+ CUOTAS REPARADO' });
});

app.get('/api/ping', (req, res) => {
  res.json({ ok: true, timestamp: Date.now() });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'online', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

app.get('/api/fixtures', async (req, res) => {
  try {
    const cached = getCache('fixtures');
    if (cached) return res.json(cached);

    res.json({ status: 'loading', total: 0, data: [] });
    await precalentarCache();
  } catch(err) {
    console.error('Error /api/fixtures:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/saldo/:uid', async (req, res) => {
  const { uid } = req.params;
  if (!uid || uid.length < 10) return res.status(400).json({ error: 'UID inválido' });

  try {
    const snap = await db.ref(`users/${uid}/creditoReal`).once('value');
    const saldo = snap.val();
    res.json({ uid, creditoReal: saldo !== null && saldo !== undefined ? saldo : 0, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/apostar', async (req, res) => {
  const { uid, amount, evento, tipo, cuota } = req.body;
  if (!uid || !amount || !evento || !tipo || !cuota) return res.status(400).json({ error: 'Parámetros faltantes' });

  try {
    const snap = await db.ref(`users/${uid}/creditoReal`).once('value');
    const saldoActual = snap.val();

    if (saldoActual === null || saldoActual < amount) {
      return res.status(400).json({ error: 'Saldo insuficiente', saldoActual: saldoActual || 0 });
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

    res.json({ success: true, saldoNuevo: saldoNuevo, betId: betId });
  } catch(err) {
    console.error('Error /api/apostar:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/apuestas/liquidar', async (req, res) => {
  const { uid, betId, resultado, marcador } = req.body;
  if (!uid || !betId || !resultado) return res.status(400).json({ error: 'Parámetros incompletos' });

  try {
    const betSnap = await db.ref(`apuestas/${uid}/${betId}`).once('value');
    const apuesta = betSnap.val();

    if (!apuesta) return res.status(404).json({ error: 'Apuesta no encontrada' });
    if (apuesta.estado !== 'pendiente') return res.status(400).json({ error: 'Apuesta ya liquidada' });

    let monto = 0;
    if (resultado === 'ganado') monto = apuesta.ganancia;
    else if (resultado === 'nulo') monto = apuesta.monto;

    if (monto > 0) {
      const saldoSnap = await db.ref(`users/${uid}/creditoReal`).once('value');
      const saldoActual = saldoSnap.val() || 0;
      await db.ref(`users/${uid}/creditoReal`).set(saldoActual + monto);
    }

    await db.ref(`apuestas/${uid}/${betId}`).update({
      estado: resultado,
      resultado: resultado,
      marcador: marcador || null,
      liquidado: true,
      fechaLiquidacion: Date.now(),
      montoRecibido: monto
    });

    res.json({ success: true, estado: resultado, montoRecibido: monto, timestamp: new Date().toISOString() });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/apuestas/resultados/:uid', async (req, res) => {
  const { uid } = req.params;
  if (!uid || uid.length < 10) return res.status(400).json({ error: 'UID inválido' });

  try {
    const apuestasSnap = await db.ref(`apuestas/${uid}`).once('value');
    const apuestas = apuestasSnap.val() || {};

    const resultados = { total: 0, ganadas: 0, perdidas: 0, nulas: 0, montoTotal: 0, ganancia: 0, pérdida: 0, apuestas: [] };

    for (const [betId, apuesta] of Object.entries(apuestas)) {
      const estado = apuesta.estado || 'pendiente';
      resultados.total++;
      resultados.montoTotal += apuesta.monto || 0;

      if (estado === 'ganado') {
        resultados.ganadas++;
        resultados.ganancia += (apuesta.montoRecibido || apuesta.ganancia || 0) - apuesta.monto;
      } else if (estado === 'perdido') {
        resultados.perdidas++;
        resultados.pérdida += apuesta.monto;
      } else if (estado === 'nulo') {
        resultados.nulas++;
      }

      resultados.apuestas.push({
        betId, evento: apuesta.eventoNombre, tipo: apuesta.tipo, monto: apuesta.monto, cuota: apuesta.cuota,
        ganancia: apuesta.ganancia, montoRecibido: apuesta.montoRecibido || 0, estado: estado,
        fecha: new Date(apuesta.fecha).toISOString(), marcador: apuesta.marcador || null
      });
    }

    resultados.grafica = {
      ganadas_vs_perdidas: [
        { name: 'Ganadas', value: resultados.ganadas },
        { name: 'Perdidas', value: resultados.perdidas }
      ],
      ganancias_por_dia: generarGraficaPorDia(resultados.apuestas),
      resumen: {
        totalApostado: resultados.montoTotal,
        gananciaNetaProyectada: resultados.ganancia - resultados.pérdida,
        roi: resultados.montoTotal > 0 ? ((resultados.ganancia - resultados.pérdida) / resultados.montoTotal * 100).toFixed(2) : 0
      }
    };

    res.json(resultados);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

function generarGraficaPorDia(apuestas) {
  const porDia = {};
  for (const apuesta of apuestas) {
    const fecha = new Date(apuesta.fecha).toISOString().split('T')[0];
    if (!porDia[fecha]) porDia[fecha] = { ganadas: 0, perdidas: 0, nulas: 0, ganancia: 0 };

    if (apuesta.estado === 'ganado') {
      porDia[fecha].ganadas++;
      porDia[fecha].ganancia += (apuesta.montoRecibido - apuesta.monto);
    } else if (apuesta.estado === 'perdido') {
      porDia[fecha].perdidas++;
      porDia[fecha].ganancia -= apuesta.monto;
    } else if (apuesta.estado === 'nulo') {
      porDia[fecha].nulas++;
    }
  }
  return Object.entries(porDia).map(([fecha, stats]) => ({ fecha, ...stats }));
}

app.get('/api/admin/generar-codigo', async (req, res) => {
  const { rol = 'ceo' } = req.query;
  const rolesValidos = ['ceo', 'admin', 'moderador', 'soporte'];
  if (!rolesValidos.includes(rol)) return res.status(400).json({ error: 'Rol no válido' });

  try {
    const ahora = new Date();
    const dia = String(ahora.getDate()).padStart(2, '0');
    const mes = String(ahora.getMonth() + 1).padStart(2, '0');
    const año = String(ahora.getFullYear()).slice(-2);
    const hora = String(ahora.getHours()).padStart(2, '0');
    const minuto = String(ahora.getMinutes()).padStart(2, '0');

    const rolInicial = rol.charAt(0).toUpperCase();
    const fecha = `${dia}${mes}${año}${hora}${minuto}`;
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    const codigo = `${rolInicial}${fecha}${random}`;

    res.json({
      success: true,
      codigo: codigo,
      rol: rol,
      formato: `${rolInicial}[DÍA][MES][AÑO][HORA][MINUTO][RANDOM_4]`,
      expira: new Date(ahora.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/aplicar-codigo', async (req, res) => {
  const { codigo, uid } = req.body;
  if (!codigo || !uid) return res.status(400).json({ error: 'Código o UID faltante' });

  try {
    if (!codigo.match(/^[CAMS]\d{8}\w{4}$/)) return res.status(400).json({ error: 'Código no válido' });

    const rolMap = { 'C': 'ceo', 'A': 'admin', 'M': 'moderador', 'S': 'soporte' };
    const rol = rolMap[codigo.charAt(0)];

    await db.ref(`users/${uid}/rol`).set(rol);
    await db.ref(`audit/${uid}/${Date.now()}`).set({
      accion: 'rol_asignado',
      rol: rol,
      codigo: codigo,
      fecha: new Date().toISOString()
    });

    res.json({ success: true, uid: uid, rol: rol, mensaje: `Rol "${rol}" asignado` });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/agents-status', async (req, res) => {
  const GEMINI_B64 = 'QVEuQWI4Uk42SVNDbFk0WnNqSXRpZlNCaXZkeUppblBjMUdoNEljMUJGM2Nxc3RBVjRsa2c=';
  const GROQ_B64 = 'Z3NrX05rU01oNlBxdm9qdElnNTlrT1QyV0dkeWIzRlkwc3dDYVZHYzRGa055ZFV6OGZYcjl0SXc=';

  const geminiKey = Buffer.from(GEMINI_B64, 'base64').toString();
  const groqKey = Buffer.from(GROQ_B64, 'base64').toString();

  const status = { Geminis02: 'unknown', Agente_groc01: 'unknown', Athos_Tavily: 'unknown' };

  if (geminiKey) {
    try {
      const resp = await axios.post(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent',
        { contents: [{ parts: [{ text: 'OK' }] }] },
        { headers: { 'X-goog-api-key': geminiKey, 'Content-Type': 'application/json' }, timeout: 8000 }
      );
      status.Geminis02 = resp.data?.candidates ? 'online' : 'error';
    } catch(e) { status.Geminis02 = 'error: ' + e.message; }
  } else { status.Geminis02 = 'no_key'; }

  if (groqKey) {
    try {
      const resp = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        { model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: 'OK' }] },
        { headers: { Authorization: 'Bearer ' + groqKey, 'Content-Type': 'application/json' }, timeout: 8000 }
      );
      status.Agente_groc01 = resp.data?.choices ? 'online' : 'error';
    } catch(e) { status.Agente_groc01 = 'error: ' + e.message; }
  } else { status.Agente_groc01 = 'no_key'; }

  status.Athos_Tavily = TAVILY_API_KEY ? 'configured' : 'no_key';

  res.json({ success: true, agents: status, timestamp: new Date().toISOString() });
});

app.post('/api/chat', async (req, res) => {
  const { mensaje } = req.body;
  if (!mensaje || typeof mensaje !== 'string' || mensaje.trim().length === 0) return res.status(400).json({ error: 'Mensaje vacío' });

  const GROQ_B64 = 'Z3NrX05rU01oNlBxdm9qdElnNTlrT1QyV0dkeWIzRlkwc3dDYVZHYzRGa055ZFV6OGZYcjl0SXc=';
  const groqKey = Buffer.from(GROQ_B64, 'base64').toString();
  if (!groqKey) return res.status(500).json({ error: 'Agente no configurado' });

  try {
    const prompt = `Eres el asistente virtual de BetGroup Pro. Responde de forma clara, breve y útil.`;

    const resp = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: mensaje.trim() }
        ],
        max_tokens: 300,
        temperature: 0.7
      },
      { headers: { Authorization: 'Bearer ' + groqKey, 'Content-Type': 'application/json' }, timeout: 15000 }
    );

    const respuesta = resp.data?.choices?.[0]?.message?.content || 'No puedo responder.';
    res.json({ success: true, respuesta });
  } catch(e) {
    res.status(500).json({ error: 'Error procesando' });
  }
});

app.get('/api/verificacion-geminis', async (req, res) => {
  const GEMINI_B64 = 'QVEuQWI4Uk42SVNDbFk0WnNqSXRpZlNCaXZkeUppblBjMUdoNEljMUJGM2Nxc3RBVjRsa2c=';
  const geminiKey = Buffer.from(GEMINI_B64, 'base64').toString();

  try {
    const resp = await axios.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent',
      { contents: [{ parts: [{ text: 'Verifica que funciones. Responde solo OK.' }] }] },
      { headers: { 'X-goog-api-key': geminiKey, 'Content-Type': 'application/json' }, timeout: 10000 }
    );

    const mensaje = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    notifyTelegram(`✅ Geminis02 OK: ${mensaje.substring(0, 100)}`);

    res.json({ success: true, agente: 'Geminis02', respuesta: mensaje, timestamp: new Date().toISOString() });
  } catch(err) {
    notifyTelegram(`❌ Geminis02 ERROR: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ BetGroup Pro API v8.5+ MOTOR DE CUOTAS REPARADO`);
  console.log(`📊 Puerto: ${PORT}`);
  console.log('');
  console.log('🎯 ENDPOINTS:');
  console.log('  ✅ GET  /api/health');
  console.log('  ✅ GET  /api/fixtures (CUOTAS MEJORADAS)');
  console.log('  ✅ GET  /api/saldo/:uid');
  console.log('  ✅ POST /api/apostar');
  console.log('  ✅ POST /api/apuestas/liquidar');
  console.log('  ✅ GET  /api/apuestas/resultados/:uid');
  console.log('  ✅ GET  /api/admin/generar-codigo?rol=ceo');
  console.log('  ✅ POST /api/admin/aplicar-codigo');
  console.log('  ✅ GET  /api/agents-status');
  console.log('  ✅ POST /api/chat');
  console.log('  ✅ GET  /api/verificacion-geminis');
  console.log('');

  precalentarCache();
  setInterval(precalentarCache, 5 * 60 * 1000);
});
