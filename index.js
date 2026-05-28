const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');

// Inicializar Firebase Admin
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.database();

const app = express();
const ODDS_API_KEY = process.env.ODDS_API_KEY;
const ODDS_API_HOST = 'https://api.the-odds-api.com/v4';

// 1. FILTRO DE DEPORTES (Prioridad Fútbol + Mundial)
const SPORTS_CONFIG = {
  'soccer_fifa_world_cup': { priority: 1, baseUrl: '/sports/soccer_fifa_world_cup/odds', dailyLimit: 2, region: 'eu' },
  'soccer_conmebol_libertadores': { priority: 2, baseUrl: '/sports/soccer_conmebol_libertadores/odds', dailyLimit: 2, region: 'eu' },
  'soccer_uefa_champions_league': { priority: 2, baseUrl: '/sports/soccer_uefa_champions_league/odds', dailyLimit: 2, region: 'eu' },
  'soccer_uefa_europa_league': { priority: 3, baseUrl: '/sports/soccer_uefa_europa_league/odds', dailyLimit: 2, region: 'eu' },
  'soccer_spain_la_liga': { priority: 3, baseUrl: '/sports/soccer_spain_la_liga/odds', dailyLimit: 2, region: 'eu' },
  'soccer_epl': { priority: 3, baseUrl: '/sports/soccer_epl/odds', dailyLimit: 2, region: 'eu' },
  'soccer_italy_serie_a': { priority: 3, baseUrl: '/sports/soccer_italy_serie_a/odds', dailyLimit: 2, region: 'eu' },
  'soccer_germany_bundesliga': { priority: 3, baseUrl: '/sports/soccer_germany_bundesliga/odds', dailyLimit: 2, region: 'eu' },
  'soccer_france_ligue_1': { priority: 3, baseUrl: '/sports/soccer_france_ligue_1/odds', dailyLimit: 2, region: 'eu' },
  'soccer_mexico_liga_mx': { priority: 3, baseUrl: '/sports/soccer_mexico_liga_mx/odds', dailyLimit: 2, region: 'eu' },
  'soccer_usa_mls': { priority: 3, baseUrl: '/sports/soccer_usa_mls/odds', dailyLimit: 2, region: 'eu' },
  'soccer_argentina_primera': { priority: 3, baseUrl: '/sports/soccer_argentina_primera/odds', dailyLimit: 2, region: 'eu' },
  'soccer_brazil_campeonato': { priority: 3, baseUrl: '/sports/soccer_brazil_campeonato/odds', dailyLimit: 2, region: 'eu' },
  'mma_mixed_martial_arts': { priority: 10, baseUrl: '/sports/mma_mixed_martial_arts/odds', dailyLimit: 1, region: 'us' },
  'boxing_boxing': { priority: 10, baseUrl: '/sports/boxing_boxing/odds', dailyLimit: 1, region: 'us' },
  'baseball_mlb': { priority: 10, baseUrl: '/sports/baseball_mlb/odds', dailyLimit: 1, region: 'us' },
  'baseball_npb': { priority: 10, baseUrl: '/sports/baseball_npb/odds', dailyLimit: 1, region: 'us' },
  'basketball_nba': { priority: 10, baseUrl: '/sports/basketball_nba/odds', dailyLimit: 1, region: 'us' },
  'basketball_euroleague': { priority: 10, baseUrl: '/sports/basketball_euroleague/odds', dailyLimit: 1, region: 'eu' }
};

// 2. MAPEO DE NOMBRES ESTILO ESPN
function normalizeTeamName(name) {
  if (!name) return '';
  return name
    .replace(/CF$/g, '').replace(/FC$/g, '').replace(/AFC$/g, '').replace(/SC$/g, '')
    .replace(/United/g, 'United').replace(/City/g, 'City')
    .replace(/Real Madrid CF/gi, 'Real Madrid')
    .replace(/Bayern Munich/gi, 'Bayern de Múnich')
    .replace(/AC Milan/gi, 'AC Milan')
    .replace(/Juventus FC/gi, 'Juventus')
    .replace(/Paris Saint-Germain/gi, 'PSG')
    .replace(/Borussia Dortmund/gi, 'Dortmund')
    .trim();
}

// 3. NORMALIZACIÓN DE FECHA
function normalizeCommenceTime(isoString) {
  const date = new Date(isoString);
  return {
    iso: date.toISOString(),
    display: date.toLocaleString('es-ES', { timeZone: 'America/Havana', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  };
}

// 4. CONTROL DE CRÉDITOS
async function checkUpcomingEvents(sportKey) {
  try {
    const snap = await db.ref(`/sport_schedule/${sportKey}`).once('value');
    const schedule = snap.val() || {};
    const ahora = Date.now();
    const veinticuatroHoras = ahora + (24 * 60 * 60 * 1000);
    return Object.values(schedule).some(game => {
      const gameTime = new Date(game.commenceTime).getTime();
      return gameTime >= ahora && gameTime <= veinticuatroHoras;
    });
  } catch(e) { return false; }
}

// 5. LLAMADA A THE ODDS API
async function fetchOddsForSport(sportKey) {
  try {
    const response = await axios.get(`${ODDS_API_HOST}${SPORTS_CONFIG[sportKey].baseUrl}`, {
      params: { apiKey: ODDS_API_KEY, regions: SPORTS_CONFIG[sportKey].region || 'eu', oddsFormat: 'decimal' }
    });
    return response.data;
  } catch(e) { console.error(`Error fetching ${sportKey}:`, e.message); return []; }
}

// 6. PROCESAMIENTO Y ESCRITURA EN RTDB
async function processAndStoreOdds(sportKey, matches) {
  const updates = {};
  for (const match of matches) {
    const processed = {
      id: match.id,
      sport: SPORTS_CONFIG[sportKey].priority === 1 ? 'football_worldcup' : sportKey.includes('soccer') ? 'football' : sportKey.includes('mma') ? 'mma' : sportKey.includes('boxing') ? 'boxing' : 'other',
      homeTeam: normalizeTeamName(match.home_team),
      awayTeam: normalizeTeamName(match.away_team),
      commenceTime: normalizeCommenceTime(match.commence_time),
      cuotas: {},
      fuente: 'the-odds-api',
      actualizadoEn: Date.now(),
      expiraEn: Date.now() + (12 * 60 * 60 * 1000)
    };
    if (match.bookmakers?.length) {
      const cuotas = match.bookmakers[0].markets?.[0]?.outcomes || [];
      cuotas.forEach(outcome => {
        if (outcome.name === match.home_team) processed.cuotas.local = outcome.price;
        if (outcome.name === match.away_team) processed.cuotas.visitante = outcome.price;
        if (outcome.name === 'Draw') processed.cuotas.empate = outcome.price;
      });
    }
    updates[`/mercados/${match.id}`] = processed;
  }
  if (Object.keys(updates).length) await db.ref().update(updates);
}

// 7. ORQUESTADOR PRINCIPAL
async function syncAllSports() {
  for (const [sportKey, config] of Object.entries(SPORTS_CONFIG)) {
    if (await checkUpcomingEvents(sportKey)) {
      const matches = await fetchOddsForSport(sportKey);
      if (matches.length) await processAndStoreOdds(sportKey, matches);
    }
  }
}

// Endpoint principal
app.get('/api/fixtures', async (req, res) => {
  try {
    const snap = await db.ref('mercados').once('value');
    res.json({ status: 'ok', data: Object.values(snap.val() || {}) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Endpoint de sincronización manual
app.get('/sync', async (req, res) => {
  await syncAllSports();
  res.json({ status: 'sync_completed' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy activo en puerto ${PORT}`));
