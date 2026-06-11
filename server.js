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

// === Claves de agentes (base64) ===
const GEMINI_B64 = 'QVEuQWI4Uk42SVNDbFk0WnNqSXRpZlNCaXZkeUppblBjMUdoNEljMUJGM2Nxc3RBVjRsa2c=';
const GROQ_B64   = 'Z3NrX05rU01oNlBxdm9qdElnNTlrT1QyV0dkeWIzRlkwc3dDYVZHYzRGa055ZFV6OGZYcjl0SXc=';
const GEMINI_API_KEY = Buffer.from(GEMINI_B64, 'base64').toString();
const GROQ_API_KEY   = Buffer.from(GROQ_B64, 'base64').toString();


  db = admin.database();
} catch(error) {
  console.error('Error al inicializar Firebase Admin SDK:', error.message);
  process.exit(1);
}

// ==================== NOTIFICACIÓN DE ERRORES A TELEGRAM ====================
const TELEGRAM_BOT_TOKEN = '8671464180:AAHhu_Ct9-3Q6Arjle-7Xy4DyUGuuNvraBs';
const TELEGRAM_CHAT_ID = '-5154764705';

function notifyTelegram(texto) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  require('https').get(`${url}?chat_id=${TELEGRAM_CHAT_ID}&text=${encodeURIComponent(texto)}`).on('error', () => {});
}

process.on('uncaughtException', (err) => {
  console.error('❌ Error no capturado:', err.message);
  notifyTelegram(`🚨 BetGroup Proxy ERROR: ${err.message}`);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Promesa rechazada:', reason);
  notifyTelegram(`⚠️ BetGroup Proxy RECHAZO: ${reason?.message || reason}`);
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
      const isFinished = status.state === 'post';
      
      if (!isLive && !isScheduled && !isFinished) continue;

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
        marcador: (isLive || isFinished) ? `${homeScore}-${awayScore}` : null,
        minuto: ev.status?.displayClock || null,
        estado: isLive ? 'live' : (isFinished ? 'finished' : 'scheduled'),
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

// ==================== ENRIQUECER CON CUOTAS (GEMINI) ====================

async function obtenerCuotasConGemini(eventos) {
  const geminiKey = process.env.GEMINI_API_KEY;
  
  if (!geminiKey) {
    console.warn('⚠️ Sin GEMINI_API_KEY - no se pueden obtener cuotas');
    return eventos;
  }

  // Procesar en lotes (máximo 5 eventos a la vez)
  for (let i = 0; i < eventos.length; i += 5) {
    const lote = eventos.slice(i, i + 5);
    
    for (const evento of lote) {
      if (evento.estado === 'finished') continue; // No buscar cuotas de eventos terminados
      
      try {
        const prompt = `Eres un analista de cuotas de apuestas deportivas. 
        
Busca CUOTAS ACTUALES para este evento:
${evento.local} vs ${evento.visitante} (${evento.liga})

Proporciona SOLO tres números decimales separados por comas:
[cuota_local],[cuota_empate],[cuota_visitante]

Ejemplo: 2.10,3.50,1.80

IMPORTANTE: 
- Las cuotas deben estar entre 1.01 y 10.00
- Suma de inversas debe ser ~0.95-1.05
- Se realista con las cuotas del mercado`;

        const resp = await axios.post(
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent',
          {
            contents: [{
              parts: [{ text: prompt }]
            }]
          },
          {
            headers: {
              'X-goog-api-key': geminiKey,
              'Content-Type': 'application/json'
            },
            timeout: 10000
          }
        );

        const respuesta = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        
        // Extraer números decimales de la respuesta
        const numeros = respuesta.match(/\d+\.\d+/g);
        
        if (numeros && numeros.length >= 3) {
          evento.cuota_local = parseFloat(numeros[0]);
          evento.cuota_empate = parseFloat(numeros[1]);
          evento.cuota_visitante = parseFloat(numeros[2]);
          console.log(`✅ Cuotas para ${evento.local}: ${evento.cuota_local}, ${evento.cuota_empate}, ${evento.cuota_visitante}`);
        }
      } catch(err) {
        console.error(`⚠️ Error obteniendo cuotas para ${evento.local}:`, err.message);
      }
    }
    
    // Esperar 1 segundo entre lotes para no sobrecargar Gemini
    if (i + 5 < eventos.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
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
    { path: 'soccer/fifa.world/scoreboard', sport: 'soccer' },
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

  // Obtener cuotas con Gemini
  await obtenerCuotasConGemini(allEvents);

  const response = {
    status: 'online',
    timestamp: new Date().toISOString(),
    total: allEvents.length,
    en_vivo: allEvents.filter(e => e.estado === 'live').length,
    proximos: allEvents.filter(e => e.estado === 'scheduled').length,
    terminados: allEvents.filter(e => e.estado === 'finished').length,
    data: allEvents
  };

  setCache('fixtures', response);
  console.log(`✅ Caché precalentado: ${allEvents.length} eventos (${allEvents.filter(e => e.cuota_local).length} con cuotas)`);
}

// ==================== ENDPOINTS BÁSICOS ====================

app.get('/', (req, res) => {
  res.json({ status: 'online', message: 'BetGroup Pro API v8.2.0' });
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

// ==================== FIXTURES ====================

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
      terminados: 0,
      data: []
    };
    
    res.json(response);

    // Precalentar en background
    await precalentarCache();
  } catch(err) {
    console.error('Error /api/fixtures:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== SALDO ====================

app.get('/api/saldo/:uid', async (req, res) => {
  const { uid } = req.params;

  if (!uid || uid.length < 10) {
    return res.status(400).json({ error: 'UID inválido' });
  }

  try {
    const snap = await db.ref(`users/${uid}/creditoReal`).once('value');
    const saldo = snap.val();

    res.json({
      uid,
      creditoReal: saldo !== null ? saldo : 0,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Error /api/saldo:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==================== APOSTAR ====================

app.post('/api/apostar', async (req, res) => {
  const { uid, amount, evento, tipo, cuota } = req.body;

  if (!uid || !amount || !evento || !tipo || !cuota) {
    return res.status(400).json({ error: 'Parámetros faltantes' });
  }

  try {
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
    const ganancia = Math.round(amount * cuota * 100) / 100;
    
    await db.ref(`apuestas/${uid}/${betId}`).set({
      eventoNombre: evento,
      tipo: tipo,
      monto: amount,
      cuota: cuota,
      ganancia: ganancia,
      gananciaNetaProyectada: ganancia - amount,
      estado: 'pendiente',
      fecha: Date.now()
    });

    res.json({
      success: true,
      saldoNuevo: saldoNuevo,
      betId: betId,
      gananciaProyectada: ganancia
    });
  } catch(err) {
    console.error('Error /api/apostar:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== LIQUIDACIÓN DE APUESTAS ====================

app.post('/api/apuestas/liquidar', async (req, res) => {
  const { uid, betId, resultado, marcador } = req.body;

  if (!uid || !betId || !resultado) {
    return res.status(400).json({ error: 'Parámetros incompletos' });
  }

  // resultado: 'ganado', 'perdido', 'nulo'

  try {
    // Obtener la apuesta
    const betSnap = await db.ref(`apuestas/${uid}/${betId}`).once('value');
    const apuesta = betSnap.val();

    if (!apuesta) {
      return res.status(404).json({ error: 'Apuesta no encontrada' });
    }

    if (apuesta.estado !== 'pendiente') {
      return res.status(400).json({ error: 'Apuesta ya fue liquidada' });
    }

    // Calcular ganancia
    let monto = 0;
    let estadoFinal = resultado;

    if (resultado === 'ganado') {
      monto = apuesta.ganancia; // monto * cuota
    } else if (resultado === 'nulo') {
      monto = apuesta.monto; // devolver el monto
    }
    // Si es perdido, monto = 0 (ya fue descontado)

    // Actualizar saldo si hay ganancia o devolución
    if (monto > 0) {
      const saldoSnap = await db.ref(`users/${uid}/creditoReal`).once('value');
      const saldoActual = saldoSnap.val() || 0;
      const saldoNuevo = saldoActual + monto;
      await db.ref(`users/${uid}/creditoReal`).set(saldoNuevo);
    }

    // Actualizar estado de apuesta
    await db.ref(`apuestas/${uid}/${betId}`).update({
      estado: estadoFinal,
      resultado: resultado,
      marcador: marcador || null,
      liquidado: true,
      fechaLiquidacion: Date.now(),
      montoRecibido: monto
    });

    // Registrar en historial (sin persistencia entre reinicios)
    await db.ref(`historial/${uid}/${betId}`).set({
      tipo: 'apuesta_liquidada',
      apuesta: {
        eventoNombre: apuesta.eventoNombre,
        tipo: apuesta.tipo,
        monto: apuesta.monto,
        cuota: apuesta.cuota,
        ganancia: apuesta.ganancia
      },
      resultado: resultado,
      montoRecibido: monto,
      fecha: Date.now()
    });

    res.json({
      success: true,
      estado: estadoFinal,
      montoRecibido: monto,
      timestamp: new Date().toISOString()
    });
  } catch(err) {
    console.error('Error /api/apuestas/liquidar:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==================== RESULTADOS Y GRÁFICA ====================

app.get('/api/apuestas/resultados/:uid', async (req, res) => {
  const { uid } = req.params;

  if (!uid || uid.length < 10) {
    return res.status(400).json({ error: 'UID inválido' });
  }

  try {
    const apuestasSnap = await db.ref(`apuestas/${uid}`).once('value');
    const apuestas = apuestasSnap.val() || {};

    const resultados = {
      total: 0,
      ganadas: 0,
      perdidas: 0,
      nulas: 0,
      montoTotal: 0,
      ganancia: 0,
      pérdida: 0,
      apuestas: []
    };

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
        betId,
        evento: apuesta.eventoNombre,
        tipo: apuesta.tipo,
        monto: apuesta.monto,
        cuota: apuesta.cuota,
        ganancia: apuesta.ganancia,
        montoRecibido: apuesta.montoRecibido || 0,
        estado: estado,
        fecha: new Date(apuesta.fecha).toISOString(),
        marcador: apuesta.marcador || null
      });
    }

    // Datos para gráfica
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
    console.error('Error /api/apuestas/resultados:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function generarGraficaPorDia(apuestas) {
  const porDia = {};

  for (const apuesta of apuestas) {
    const fecha = new Date(apuesta.fecha).toISOString().split('T')[0]; // YYYY-MM-DD
    
    if (!porDia[fecha]) {
      porDia[fecha] = { ganadas: 0, perdidas: 0, nulas: 0, ganancia: 0 };
    }

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

  return Object.entries(porDia).map(([fecha, stats]) => ({
    fecha,
    ...stats
  }));
}

// ==================== GENERAR CÓDIGO CEO (ROL + FECHA) ====================

app.get('/api/admin/generar-codigo', async (req, res) => {
  const { rol = 'ceo' } = req.query;

  // Validar rol
  const rolesValidos = ['ceo', 'admin', 'moderador', 'soporte'];
  if (!rolesValidos.includes(rol)) {
    return res.status(400).json({ error: 'Rol no válido' });
  }

  try {
    // Formato: [ROL_INICIAL][FECHA_DDMMYYHHMM][RANDOM_4_CHARS]
    // Ejemplo: C1106251530ABCD (C=CEO, 11=día, 06=mes, 25=año, 15=hora, 30=minuto, ABCD=random)
    
    const ahora = new Date();
    const dia = String(ahora.getDate()).padStart(2, '0');
    const mes = String(ahora.getMonth() + 1).padStart(2, '0');
    const año = String(ahora.getFullYear()).slice(-2);
    const hora = String(ahora.getHours()).padStart(2, '0');
    const minuto = String(ahora.getMinutes()).padStart(2, '0');
    
    const rolInicial = rol.charAt(0).toUpperCase();
    const fecha = `${dia}${mes}${año}${hora}${minuto}`;
    
    // Generar 4 caracteres aleatorios
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    
    const codigo = `${rolInicial}${fecha}${random}`;
    
    res.json({
      success: true,
      codigo: codigo,
      rol: rol,
      formato: `${rolInicial}[DÍA][MES][AÑO][HORA][MINUTO][RANDOM_4]`,
      expira: new Date(ahora.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 días
    });
  } catch(err) {
    console.error('Error /api/admin/generar-codigo:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==================== APLICAR CÓDIGO CEO ====================

app.post('/api/admin/aplicar-codigo', async (req, res) => {
  const { codigo, uid } = req.body;

  if (!codigo || !uid) {
    return res.status(400).json({ error: 'Código o UID faltante' });
  }

  try {
    // Validar formato del código (debe empezar con C para CEO)
    if (!codigo.startsWith('C') && !codigo.startsWith('A') && !codigo.startsWith('M') && !codigo.startsWith('S')) {
      return res.status(400).json({ error: 'Código no válido' });
    }

    const rolMap = {
      'C': 'ceo',
      'A': 'admin',
      'M': 'moderador',
      'S': 'soporte'
    };

    const rol = rolMap[codigo.charAt(0)];

    // Aplicar rol al usuario
    await db.ref(`users/${uid}/rol`).set(rol);

    // Registrar en auditoría (sin persistencia)
    await db.ref(`audit/${uid}/${Date.now()}`).set({
      accion: 'rol_asignado',
      rol: rol,
      codigo: codigo,
      fecha: new Date().toISOString()
    });

    res.json({
      success: true,
      uid: uid,
      rol: rol,
      mensaje: `Rol "${rol}" asignado al usuario ${uid}`
    });
  } catch(err) {
    console.error('Error /api/admin/aplicar-codigo:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==================== AGENTES STATUS ====================

app.get('/api/agents-status', async (req, res) => {
  const status = { 
    Geminis02: 'checking',
    Agente_groc01: 'checking',
    Athos_Tavily: 'configured'
  };
  
  const geminiKey = process.env.GEMINI_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;
  
  // Probar Geminis02
  try {
    const resp = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${geminiKey}`,
      { contents: [{ parts: [{ text: 'OK' }] }] },
      { timeout: 5000 }
    );
    status.Geminis02 = resp.data?.candidates ? 'online' : 'error';
  } catch(e) { 
    status.Geminis02 = 'error'; 
  }

  // Probar Agente_groc01
  try {
    const resp = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      { model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: 'OK' }] },
      { 
        headers: { Authorization: `Bearer ${groqKey}` }, 
        timeout: 5000 
      }
    );
    status.Agente_groc01 = resp.data?.choices ? 'online' : 'error';
  } catch(e) { 
    status.Agente_groc01 = 'error'; 
  }

  res.json({ 
    success: true, 
    agents: status, 
    timestamp: new Date().toISOString() 
  });
});

// ==================== CHATBOT ====================

app.post('/api/chat', async (req, res) => {
  const { mensaje } = req.body;
  if (!mensaje || typeof mensaje !== 'string' || mensaje.trim().length === 0) {
    return res.status(400).json({ error: 'Mensaje vacío' });
  }

  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) {
    return res.status(500).json({ error: 'Agente no configurado' });
  }

  try {
    const prompt = `Eres Agente_groc01, el asistente de BetGroup Pro. Ayuda con dudas sobre apuestas, registro, créditos y soporte. Se breve y útil.`;

    const resp = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: mensaje.trim() }
        ],
        max_tokens: 200,
        temperature: 0.7
      },
      {
        headers: { 
          Authorization: `Bearer ${groqKey}`,
          'Content-Type': 'application/json' 
        },
        timeout: 10000
      }
    );

    const respuesta = resp.data?.choices?.[0]?.message?.content || 'No puedo responder en este momento.';
    res.json({ success: true, respuesta });
  } catch (e) {
    console.error('Error /api/chat:', e.message);
    res.status(500).json({ error: 'Error procesando consulta' });
  }
});

// ==================== SERVIDOR ====================

app.listen(PORT, () => {
  console.log(`✅ BetGroup Pro API v8.2.0 escuchando en puerto ${PORT}`);
  console.log('');
  console.log('Endpoints disponibles:');
  console.log('  ✅ GET  /api/health');
  console.log('  ✅ GET  /api/fixtures');
  console.log('  ✅ GET  /api/saldo/:uid');
  console.log('  ✅ POST /api/apostar');
  console.log('  ✅ POST /api/apuestas/liquidar');
  console.log('  ✅ GET  /api/apuestas/resultados/:uid (con gráfica)');
  console.log('  ✅ GET  /api/admin/generar-codigo?rol=ceo');
  console.log('  ✅ POST /api/admin/aplicar-codigo');
  console.log('  ✅ GET  /api/agents-status');
  console.log('  ✅ POST /api/chat');
  console.log('');
  
  precalentarCache();
  setInterval(precalentarCache, 5 * 60 * 1000); // Cada 5 minutos
});
