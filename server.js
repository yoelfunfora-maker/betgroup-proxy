const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// Firebase init
const firebaseServiceAccountB64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64 || '';

if (!firebaseServiceAccountB64) {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT_B64 no definido');
  process.exit(1);
}

let serviceAccount;
try {
  const decoded = Buffer.from(firebaseServiceAccountB64, 'base64').toString('utf-8');
  serviceAccount = JSON.parse(decoded);
  console.log('✅ Firebase inicializado');
} catch (e) {
  console.error('❌ Error Firebase:', e.message);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://betgroup-cuba-2024-default-rtdb.firebaseio.com'
});

const db = admin.database();
const auth = admin.auth();

// ESPN endpoints
const ESPN_ENDPOINTS = {
  'La Liga': 'soccer/esp.1/scoreboard',
  'Premier League': 'soccer/eng.1/scoreboard',
  'Bundesliga': 'soccer/ger.1/scoreboard',
  'Serie A': 'soccer/ita.1/scoreboard',
  'Ligue 1': 'soccer/fra.1/scoreboard',
  'Champions': 'soccer/uefa.champions/scoreboard',
  'Libertadores': 'soccer/conmebol.libertadores/scoreboard',
  'Mundial': 'soccer/fifa.world/scoreboard',
  'NBA': 'basketball/nba/scoreboard',
  'MLB': 'baseball/mlb/scoreboard',
  'NFL': 'football/nfl/scoreboard',
  'NHL': 'hockey/nhl/scoreboard'
};

// ODDS API sports mapping
const ODDS_SPORTS = {
  'soccer_esp.1': 'La Liga',
  'soccer_eng.1': 'Premier League',
  'soccer_ger.1': 'Bundesliga',
  'soccer_ita.1': 'Serie A',
  'soccer_fra.1': 'Ligue 1',
  'soccer_uefa.champions': 'Champions',
  'soccer_conmebol.libertadores': 'Libertadores',
  'soccer_fifa.world': 'Mundial',
  'basketball_nba': 'NBA',
  'baseball_mlb': 'MLB',
  'football_nfl': 'NFL',
  'hockey_nhl': 'NHL'
};

app.get('/health', (req, res) => {
  res.json({ status: 'sync_completed', timestamp: new Date().toISOString() });
});

app.post('/sync', async (req, res) => {
  try {
    console.log('🔄 SYNC: ESPN cartelera → cuotas The Odds API');
    
    // 1. OBTENER CARTELERA DE ESPN
    console.log('📡 Consultando ESPN...');
    const cartelera = await obtenerCarteleraESPN();
    console.log('✅ ' + Object.keys(cartelera).length + ' eventos de ESPN');
    
    // 2. ENRIQUECER CON CUOTAS
    console.log('💰 Agregando cuotas de The Odds API...');
    const eventosCompletos = await enriquecerConCuotas(cartelera);
    
    // 3. GUARDAR EN FIREBASE
    await db.ref('eventos').set(eventosCompletos);
    console.log('✅ ' + Object.keys(eventosCompletos).length + ' eventos guardados en /eventos');
    
    res.json({ 
      status: 'sync_completed', 
      eventos: Object.keys(eventosCompletos).length,
      fuentes: 'ESPN + The Odds API',
      timestamp: new Date().toISOString()
    });

  } catch (e) {
    console.error('❌ Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

async function obtenerCarteleraESPN() {
  const eventos = {};
  
  for (const [liga, path] of Object.entries(ESPN_ENDPOINTS)) {
    try {
      const url = 'https://site.api.espn.com/apis/site/v2/sports/' + path;
      console.log('📍 ' + liga + ': ' + url);
      
      const response = await axios.get(url, { 
        timeout: 8000,
        headers: { 'User-Agent': 'BetGroup-Proxy/1.0' }
      });
      
      if (response.data && response.data.events && Array.isArray(response.data.events)) {
        
        response.data.events.forEach(function(evt) {
          if (!evt.id || !evt.competitions || !evt.competitions[0]) return;
          
          const comp = evt.competitions[0];
          const local = comp.competitors && comp.competitors[0];
          const visita = comp.competitors && comp.competitors[1];
          
          eventos[evt.id] = {
            id: evt.id,
            nombre: (local ? local.displayName : '?') + ' vs ' + (visita ? visita.displayName : '?'),
            liga: liga,
            deporte: path.split('/')[0],
            fecha: evt.date || new Date().toISOString(),
            estado: evt.status && evt.status.type ? evt.status.type.name : 'scheduled',
            
            local: {
              nombre: local ? local.displayName : '?',
              logo: local && local.logos && local.logos[0] ? local.logos[0].href : '',
              marcador: local && local.score ? parseInt(local.score) : 0
            },
            
            visita: {
              nombre: visita ? visita.displayName : '?',
              logo: visita && visita.logos && visita.logos[0] ? visita.logos[0].href : '',
              marcador: visita && visita.score ? parseInt(visita.score) : 0
            },
            
            enlace: evt.links && evt.links[0] ? evt.links[0].href : '',
            fuente: 'ESPN',
            cuotas: {} // Se llenará en enriquecerConCuotas
          };
        });
      }
      
      console.log('  ✅ ' + (response.data.events ? response.data.events.length : 0) + ' eventos');
      
    } catch (e) {
      console.error('  ❌ ' + liga + ': ' + e.message);
    }
  }
  
  return eventos;
}

async function enriquecerConCuotas(eventos) {
  const apiKey = process.env.ODDS_API_KEY_1;
  
  if (!apiKey) {
    console.warn('⚠️ ODDS_API_KEY_1 no disponible');
    return eventos;
  }
  
  const sports = ['soccer_epl', 'soccer_champions_league', 'soccer_la_liga', 'baseball_mlb', 'basketball_nba', 'football_nfl'];
  
  for (const sport of sports) {
    try {
      console.log('  💰 ' + sport);
      
      const response = await axios.get('https://api.the-odds-api.com/v4/sports/' + sport + '/odds', {
        params: { apiKey: apiKey, regions: 'us' },
        timeout: 8000
      });
      
      if (response.data && Array.isArray(response.data)) {
        response.data.forEach(function(oddEvt) {
          // Buscar evento en cartelera ESPN
          for (const [id, evt] of Object.entries(eventos)) {
            if (evt.nombre.toLowerCase().includes(oddEvt.home_team.toLowerCase()) && 
                evt.nombre.toLowerCase().includes(oddEvt.away_team.toLowerCase())) {
              evt.cuotas = {
                local: oddEvt.home_team,
                visita: oddEvt.away_team,
                mercados: oddEvt.bookmakers || []
              };
              break;
            }
          }
        });
      }
      
    } catch (e) {
      console.error('  ❌ ' + sport + ': ' + e.message);
    }
  }
  
  return eventos;
}

app.post('/api/delete-user', async (req, res) => {
  try {
    const { uid } = req.body;
    if (!uid) return res.status(400).json({ error: 'UID requerido' });
    await auth.deleteUser(uid);
    await db.ref('users/' + uid).remove();
    await db.ref('apuestas/' + uid).remove();
    await db.ref('historial/' + uid).remove();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🚀 BetGroup Proxy ESPN+Odds en puerto ' + PORT));
