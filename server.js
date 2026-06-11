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

// Claves de agentes (si no están en variables de entorno)


// ==================== NOTIFICACIÓN DE ERRORES A TELEGRAM ====================
const TELEGRAM_BOT_TOKEN = '8671464180:AAHhu_Ct9-3Q6Arjle-7Xy4DyUGuuNvraBs';
const TELEGRAM_CHAT_ID = '-5154764705';

function notifyTelegram(texto) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  require('https').get(`${url}?chat_id=${TELEGRAM_CHAT_ID}&text=${encodeURIComponent(texto)}`).on('error', () => {});
}

process.on('uncaughtException', (err) => {
  console.error('❌ Error no capturado:', err.message);
  notifyTelegram(`🚨 BetGroup Proxy ERROR: ${err.message}\n\nStack: ${err.stack?.substring(0, 300) || 'sin stack'}`);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Promesa rechazada:', reason);
  notifyTelegram(`⚠️ BetGroup Proxy PROMESA RECHAZADA: ${reason?.message || reason}`);
});
// ==================== FIN NOTIFICACIÓN TELEGRAM ====================


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
        cuota_local: null,
        cuota_empate: null,
        cuota_visitante: null
      });
    } catch(e) { 
      /* evento inválido */ 
    }
  }
  
  return events;
}

// ==================== ENRIQUECER CON CUOTAS ====================



// ==================== ENRIQUECER CON CUOTAS ====================

function limpiarNombre(nombre) {
  return nombre
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quitar tildes
    .replace(/\b(new york|los angeles|san francisco|san diego|tampa bay|kansas city|st louis|st. louis|green bay|golden state|oklahoma city|portland trail|new england|new orleans)\b/g, '') // quitar ciudades comunes
    .replace(/[^a-z0-9ñ ]/g, ' ') // solo letras, números y espacios
    .replace(/\s+/g, ' ')
    .trim();
}


// Cache de cuotas por sportKey (12h de vida)
const oddsCache = {};


// ==================== RASTREADOR ATHOS (TAVILY) ====================
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || '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';


// ==================== GENERADOR DE CUOTAS GEMINIS02 ====================
async function enriquecerConGeminis(eventos) {
  const geminiKey = process.env.GEMINI_API_KEY || 'AQ.Ab8RN6ISClY4ZsjItifSBivdyJinPc1Gh4Ic1BF3cqstAV4lkg';
  if (!geminiKey) {
    console.warn('⚠️ Sin GEMINI_API_KEY para generar cuotas');
    return eventos;
  }

  console.log(`Geminis02 procesando ${eventos.length} eventos...`);
  for (const evento of eventos) {
    // Forzar generación de cuotas siempre (debug)

    const prompt = `Eres un generador de cuotas de apuestas deportivas. Para el siguiente evento, busca información actualizada y genera cuotas REALISTAS. Responde EXCLUSIVAMENTE con un objeto JSON válido, sin markdown, sin comillas alrededor, sin texto adicional. Solo el JSON.

Evento: ${evento.local} vs ${evento.visitante}
Deporte: ${evento.sport || 'desconocido'}
Liga: ${evento.liga || 'desconocida'}

Formato de respuesta obligatorio:
{"cuota_local": X.XX, "cuota_empate": X.XX, "cuota_visitante": X.XX}`;

    try {
      const resp = await axios.post(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent',
        { contents: [{ parts: [{ text: prompt }] }] },
        { headers: { 'X-goog-api-key': geminiKey, 'Content-Type': 'application/json' }, timeout: 10000 }
      );
      
      const texto = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (texto) {
        // Intentar extraer JSON, incluso si está dentro de bloques markdown
      let jsonMatch = texto.match(/```jsons*([\s\S]*?)```/);
      if (jsonMatch) {
        // Si hay bloque markdown, usar el contenido dentro
        jsonMatch = jsonMatch[1].match(/{[\s\S]*}/);
      } else {
        // Si no, buscar directamente el JSON
        jsonMatch = texto.match(/{[\s\S]*}/);
      }
        if (jsonMatch) {
          const cuotas = JSON.parse(jsonMatch[0]);
          console.log(`✅ Cuotas asignadas para ${evento.local}:`, cuotas);
          if (cuotas.cuota_local) evento.cuota_local = parseFloat(cuotas.cuota_local);
          if (cuotas.cuota_empate) evento.cuota_empate = parseFloat(cuotas.cuota_empate);
          if (cuotas.cuota_visitante) evento.cuota_visitante = parseFloat(cuotas.cuota_visitante);
        }
      }
    } catch(e) {
      console.error(`Geminis02 error para ${evento.local}:`, e.message);
    }
  }
  return eventos;
}
// ==================== FIN GENERADOR GEMINIS02 ====================

async function enriquecerConAthos(eventos) {
  if (!TAVILY_API_KEY) {
    console.warn('⚠️ Sin TAVILY_API_KEY - no se pueden buscar cuotas');
    return eventos;
  }

  for (const evento of eventos) {
    // Solo buscar si no tiene cuotas reales aún
    if (evento.cuota_local > 1.0 && evento.cuota_visitante > 1.0) continue;

    const query = `cuotas apuestas ${evento.local} vs ${evento.visitante} ${evento.liga} ${evento.sport} oddschecker flashscore`;
    
    try {
      const response = await axios.post('https://api.tavily.com/search', {
        api_key: TAVILY_API_KEY,
        query: query,
        search_depth: 'advanced',
        max_results: 5
      }, { timeout: 10000 });

      // Extraer cuotas de los resultados (parsing simple)
      const cuotas = extraerCuotas(response.data?.results || [], evento);
      if (cuotas) {
        evento.cuota_local = cuotas.local;
        evento.cuota_visitante = cuotas.visitante;
        evento.cuota_empate = cuotas.empate || 3.5;
      }
    } catch(err) {
      console.error(`Athos error para ${evento.local}:`, err.message);
    }
  }
  return eventos;
}

function extraerCuotas(results, evento) {
  // Buscar patrones de cuotas en los snippets (números con decimales)
  const patron = /(\d+\.\d{2})/g;
  let todas = [];
  
  for (const r of results) {
    const matches = r.content?.match(patron) || [];
    todas = todas.concat(matches.map(Number));
  }
  
  if (todas.length >= 2) {
    // Asumir que las dos primeras son local y visitante
    return { local: todas[0], visitante: todas[1] };
  }
  return null;
}
// ==================== FIN ATHOS ====================


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

  // Agrupar eventos por sportKey
  const grupos = {};
  for (const evento of eventos) {
    const sportKey = sportKeyMap[evento.sport];
    if (!sportKey) continue;
    if (!grupos[sportKey]) grupos[sportKey] = [];
    grupos[sportKey].push(evento);
  }

  // Procesar cada grupo
  for (const [sportKey, eventosGrupo] of Object.entries(grupos)) {
    const cacheEntry = oddsCache[sportKey];
    let juegos = null;

    // Usar caché si es válido (menos de 12h)
    if (cacheEntry && (Date.now() - cacheEntry.timestamp) < 12 * 60 * 60 * 1000) {
      juegos = cacheEntry.data;
    } else {
      try {
        const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds?apiKey=${apiKey}&markets=h2h&regions=us`;
        const response = await axios.get(url, { timeout: 5000 });
        if (response.data) {
          juegos = response.data.data || response.data; // la API a veces devuelve {data: [...]}
          oddsCache[sportKey] = { data: juegos, timestamp: Date.now() };
        }
      } catch(err) {
        console.error(`Error cuotas para ${sportKey}:`, err.message);
        continue; // seguir con el siguiente deporte
      }
    }

    if (!juegos) continue;

    // Ahora cruzar cada evento del grupo con los juegos obtenidos
    for (const evento of eventosGrupo) {
      for (const game of juegos) {
        const localLimpio = limpiarNombre(evento.local);
        const visitanteLimpio = limpiarNombre(evento.visitante);
        const homeLimpio = limpiarNombre(game.home_team || '');
        const awayLimpio = limpiarNombre(game.away_team || '');

        if (
          (homeLimpio.includes(localLimpio) || localLimpio.includes(homeLimpio)) &&
          (awayLimpio.includes(visitanteLimpio) || visitanteLimpio.includes(awayLimpio))
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
  }

  return eventos;
}


// ==================== PRECALENTAR CACHÉ ====================


// ==================== INFORME DE CUOTAS A TELEGRAM ====================
async function enviarInformeCuotas() {
  try {
    const fixtures = await axios.get('https://betgroup-proxy-v2.onrender.com/api/fixtures', { timeout: 5000 });
    const eventos = fixtures.data?.data || [];
    if (!eventos.length) return;

    // Formatear lista de eventos con cuotas
    let mensaje = '📊 <b>INFORME DE CUOTAS</b>\n\n';
    const conCuotas = eventos.filter(e => e.cuota_local > 1.0);
    const sinCuotas = eventos.filter(e => !e.cuota_local || e.cuota_local <= 1.0);

    for (const e of conCuotas) {
      mensaje += `⚽ ${e.local} vs ${e.visitante}\n`;
      mensaje += `   Local: ${e.cuota_local} | Empate: ${e.cuota_empate || 'N/A'} | Visitante: ${e.cuota_visitante}\n\n`;
    }

    if (sinCuotas.length > 0) {
      mensaje += `⚠️ ${sinCuotas.length} eventos sin cuotas aún.\n`;
    }

    mensaje += `\n🕐 Actualizado: ${new Date().toLocaleString()}`;

    await axios.post('https://api.telegram.org/bot8671464180:AAHhu_Ct9-3Q6Arjle-7Xy4DyUGuuNvraBs/sendMessage', {
      chat_id: '-5154764705',
      text: mensaje,
      parse_mode: 'HTML'
    }, { timeout: 5000 });

    console.log('✅ Informe de cuotas enviado a Telegram');
  } catch(e) {
    console.error('Error enviando informe de cuotas:', e.message);
  }
}
// ==================== FIN INFORME CUOTAS ====================

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

  console.log('🔎 Athos buscará cuotas para todos los eventos...');
  console.log('🔎 Athos buscará cuotas...');
  console.log('🔎 Geminis02 buscará cuotas para todos los eventos...');
  await enriquecerConGeminis(allEvents);
  // Athos como respaldo
  const sinCuotas = allEvents.filter(e => !e.cuota_local || e.cuota_local <= 1.0).length;
  if (sinCuotas > 0) {
    console.log(`⚠️ Geminis02 no encontró cuotas para ${sinCuotas} eventos. Usando Athos...`);
    await enriquecerConAthos(allEvents);
  }
  // API principal como respaldo final
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
  enviarInformeCuotas();
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


// ==================== ENDPOINT SALDO REAL ====================

app.get('/api/saldo/:uid', async (req, res) => {
  const { uid } = req.params;

  if (!uid || uid.length < 10) {
    return res.status(400).json({ error: 'UID inválido' });
  }

  try {
    if (!db) {
      return res.status(500).json({ error: 'Firebase no configurado' });
    }

    const snap = await db.ref(`users/${uid}/creditoReal`).once('value');
    const saldo = snap.val();

    res.json({
      uid,
      creditoReal: saldo !== null && saldo !== undefined ? saldo : 0,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Error /api/saldo:', err.message);
    res.status(500).json({ error: err.message });
  }
});







// ==================== ENDPOINT DE ESTADO DE AGENTES ====================






app.get('/api/agents-status', async (req, res) => {
  const GEMINI_B64 = 'QVEuQWI4Uk42SVNDbFk0WnNqSXRpZlNCaXZkeUppblBjMUdoNEljMUJGM2Nxc3RBVjRsa2c=';
  const GROQ_B64 = 'Z3NrX05rU01oNlBxdm9qdElnNTlrT1QyV0dkeWIzRlkwc3dDYVZHYzRGa055ZFV6OGZYcjl0SXc=';
  const geminiKey = Buffer.from(GEMINI_B64, 'base64').toString();
  const groqKey   = Buffer.from(GROQ_B64, 'base64').toString();
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

  const tavilyKey = process.env.TAVILY_API_KEY;
  status.Athos_Tavily = tavilyKey ? 'configured' : 'no_key';
  res.json({ success: true, agents: status, timestamp: new Date().toISOString() });
});


// ==================== CHATBOT AGENTE_GROC01 ====================

app.post('/api/chat', async (req, res) => {
  const { mensaje } = req.body;
  if (!mensaje || typeof mensaje !== 'string' || mensaje.trim().length === 0) {
    return res.status(400).json({ error: 'Mensaje vacío o inválido' });
  }
  const GROQ_B64 = 'Z3NrX05rU01oNlBxdm9qdElnNTlrT1QyV0dkeWIzRlkwc3dDYVZHYzRGa055ZFV6OGZYcjl0SXc=';
  const groqKey = Buffer.from(GROQ_B64, 'base64').toString();
  if (!groqKey) return res.status(500).json({ error: 'Agente no configurado' });
  try {
    const prompt = `Eres el asistente virtual de BetGroup Pro, una plataforma de apuestas deportivas. Responde de forma clara, breve y útil. Solo debes ayudar con dudas sobre cómo apostar, cómo registrarse, cómo funciona el sistema de créditos, cómo contactar con soporte y otras cuestiones operativas. No debes dar información sobre otros usuarios, resultados de apuestas ni datos internos del sistema. Pregunta del usuario: "${mensaje.trim()}"`;
    const resp = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'system', content: prompt }, { role: 'user', content: mensaje.trim() }],
        max_tokens: 300, temperature: 0.7
      },
      { headers: { Authorization: 'Bearer ' + groqKey, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    const respuesta = resp.data?.choices?.[0]?.message?.content || 'Lo siento, no puedo responder en este momento.';
    res.json({ success: true, respuesta });
  } catch(e) { console.error('Error /api/chat:', e.message); res.status(500).json({ error: 'Error al procesar la consulta' }); }
});



// ==================== VERIFICADOR GEMINIS02 ====================

async function obtenerEstadoSistema() {
  const estado = { proxy: 'ok', agentes: {}, eventos: 0, chatbot: false, saldo_firebase: null, saldo_endpoint: null };
  try {
    const agents = await axios.get('https://betgroup-proxy-v2.onrender.com/api/agents-status', { timeout: 5000 });
    estado.agentes = agents.data?.agents || {};
  } catch(e) { estado.agentes = { error: e.message }; }

  try {
    const fixtures = await axios.get('https://betgroup-proxy-v2.onrender.com/api/fixtures', { timeout: 5000 });
    estado.eventos = fixtures.data?.total || 0;
  } catch(e) { estado.eventos = -1; }

  try {
    const chat = await axios.post('https://betgroup-proxy-v2.onrender.com/api/chat',
      { mensaje: 'Test' }, { timeout: 5000 });
    estado.chatbot = chat.data?.success || false;
  } catch(e) { estado.chatbot = false; }

  // Leer saldo de usuario de prueba directamente desde Firebase
  try {
    const snap = await db.ref('users/BG_mq7rch3t_h6sjfs1h/creditoReal').once('value');
    estado.saldo_firebase = snap.val();
  } catch(e) { estado.saldo_firebase = 'error'; }

  // Leer saldo desde el endpoint /api/saldo
  try {
    const resp = await axios.get('https://betgroup-proxy-v2.onrender.com/api/saldo/BG_mq7rch3t_h6sjfs1h', { timeout: 5000 });
    estado.saldo_endpoint = resp.data?.creditoReal;
  } catch(e) { estado.saldo_endpoint = 'error'; }

  return estado;
}

async function notificarTelegram(texto) {
  try {
    await axios.post('https://api.telegram.org/bot8671464180:AAHhu_Ct9-3Q6Arjle-7Xy4DyUGuuNvraBs/sendMessage', {
      chat_id: '-5154764705',
      text: texto,
      parse_mode: 'HTML'
    }, { timeout: 5000 });
  } catch(e) { console.error('Error notificando a Telegram:', e.message); }
}

app.get('/api/verificacion-geminis', async (req, res) => {
  try {
    const estado = { proxy: 'ok', agentes: {}, eventos: 0, chatbot: false, saldo_firebase: null, saldo_endpoint: null };
    
    const [agentsResp, fixturesResp, chatResp, saldoFB, saldoEP] = await Promise.allSettled([
      axios.get('https://betgroup-proxy-v2.onrender.com/api/agents-status', { timeout: 3000 }),
      axios.get('https://betgroup-proxy-v2.onrender.com/api/fixtures', { timeout: 3000 }),
      axios.post('https://betgroup-proxy-v2.onrender.com/api/chat', { mensaje: 'Test' }, { timeout: 3000 }),
      db.ref('users/BG_mq7rch3t_h6sjfs1h/creditoReal').once('value'),
      axios.get('https://betgroup-proxy-v2.onrender.com/api/saldo/BG_mq7rch3t_h6sjfs1h', { timeout: 3000 })
    ]);

    if (agentsResp.status === 'fulfilled') estado.agentes = agentsResp.value.data?.agents || {};
    if (fixturesResp.status === 'fulfilled') estado.eventos = fixturesResp.value.data?.total || 0;
    if (chatResp.status === 'fulfilled') estado.chatbot = chatResp.value.data?.success || false;
    if (saldoFB.status === 'fulfilled') estado.saldo_firebase = saldoFB.value.val();
    if (saldoEP.status === 'fulfilled') estado.saldo_endpoint = saldoEP.value.data?.creditoReal;

    // Formato exacto del curl funcional
    const geminiKey = 'AQ.Ab8RN6ISClY4ZsjItifSBivdyJinPc1Gh4Ic1BF3cqstAV4lkg';
    let informe = 'Sistema operativo. Saldo Firebase: ' + estado.saldo_firebase + ' | Saldo endpoint: ' + estado.saldo_endpoint;
    
    try {
      const resp = await axios.post(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent',
        { contents: [{ parts: [{ text: 'Eres el verificador de BetGroup Pro. Datos del sistema: ' + JSON.stringify(estado) + '. Genera un informe breve en 2 frases.' }] }] },
        { headers: { 'X-goog-api-key': geminiKey, 'Content-Type': 'application/json' }, timeout: 8000 }
      );
      if (resp.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
        informe = resp.data.candidates[0].content.parts[0].text;
      }
    } catch(e) { console.log('Gemini no disponible para el informe, usando resumen básico'); }

    await axios.post('https://api.telegram.org/bot8671464180:AAHhu_Ct9-3Q6Arjle-7Xy4DyUGuuNvraBs/sendMessage', {
      chat_id: '-5154764705',
      text: '📊 <b>INFORME DE GEMINIS02</b>\n\n' + informe,
      parse_mode: 'HTML'
    }, { timeout: 5000 });

    res.json({ success: true, estado, informe });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


app.listen(PORT, () => {
  console.log(`✅ Proxy escuchando en puerto ${PORT}`);
  precalentarCache();
  setInterval(precalentarCache, 3 * 60 * 1000);
});
