const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.database();

const app = express();

// Leer las 2 claves de The Odds API
const ODDS_API_KEYS = [
  process.env.ODDS_API_KEY_1 || '',
  process.env.ODDS_API_KEY_2 || ''
].filter(Boolean);

const ODDS_API_HOST = 'https://api.the-odds-api.com/v4';
let _turnoActual = 0;

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

function getApiKey() {
  if (ODDS_API_KEYS.length === 0) return null;
  const key = ODDS_API_KEYS[_turnoActual % ODDS_API_KEYS.length];
  _turnoActual++;
  return key;
}

function normalizeTeamName(name) {
  if (!name) return '';
  return name.replace(/CF$/g, '').replace(/FC$/g, '').replace(/AFC$/g, '').replace(/SC$/g, '')
    .replace(/United/g, 'United').replace(/City/g, 'City')
    .replace(/Real Madrid CF/gi, 'Real Madrid').replace(/Bayern Munich/gi, 'Bayern de Múnich')
    .replace(/AC Milan/gi, 'AC Milan').replace(/Juventus FC/gi, 'Juventus')
    .replace(/Paris Saint-Germain/gi, 'PSG').replace(/Borussia Dortmund/gi, 'Dortmund').trim();
}

function normalizeCommenceTime(isoString) {
  const d = new Date(isoString);
  return { iso: d.toISOString(), display: d.toLocaleString('es-ES', { timeZone: 'America/Havana', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) };
}

async function checkUpcomingEvents(sportKey) {
  try {
    const snap = await db.ref(`/sport_schedule/${sportKey}`).once('value');
    const schedule = snap.val() || {};
    const ahora = Date.now();
    const v24 = ahora + 86400000;
    return Object.values(schedule).some(g => { const t = new Date(g.commenceTime).getTime(); return t >= ahora && t <= v24; });
  } catch(e) { return false; }
}

async function fetchOddsForSport(sportKey) {
  const apiKey = getApiKey();
  if (!apiKey) return [];
  try {
    const res = await axios.get(`${ODDS_API_HOST}${SPORTS_CONFIG[sportKey].baseUrl}`, {
      params: { apiKey, regions: SPORTS_CONFIG[sportKey].region || 'eu', oddsFormat: 'decimal' }
    });
    return res.data;
  } catch(e) { console.error(`Error ${sportKey}:`, e.message); return []; }
}

async function processAndStoreOdds(sportKey, matches) {
  const updates = {};
  for (const match of matches) {
    const p = {
      id: match.id,
      sport: SPORTS_CONFIG[sportKey].priority === 1 ? 'football_worldcup' : sportKey.includes('soccer') ? 'football' : sportKey.includes('mma') ? 'mma' : sportKey.includes('boxing') ? 'boxing' : 'other',
      homeTeam: normalizeTeamName(match.home_team),
      awayTeam: normalizeTeamName(match.away_team),
      commenceTime: normalizeCommenceTime(match.commence_time),
      cuotas: {},
      fuente: 'the-odds-api',
      actualizadoEn: Date.now(),
      expiraEn: Date.now() + 43200000
    };
    const cuotas = match.bookmakers?.[0]?.markets?.[0]?.outcomes || [];
    cuotas.forEach(o => {
      if (o.name === match.home_team) p.cuotas.local = o.price;
      if (o.name === match.away_team) p.cuotas.visitante = o.price;
      if (o.name === 'Draw') p.cuotas.empate = o.price;
    });
    updates[`/mercados/${match.id}`] = p;
  }
  if (Object.keys(updates).length) await db.ref().update(updates);
}

async function syncAllSports() {
  for (const [k, cfg] of Object.entries(SPORTS_CONFIG)) {
    if (await checkUpcomingEvents(k)) {
      const matches = await fetchOddsForSport(k);
      if (matches.length) await processAndStoreOdds(k, matches);
    }
  }
}

app.get('/api/fixtures', async (req, res) => {
  try {
    const snap = await db.ref('mercados').once('value');
    res.json({ status: 'ok', data: Object.values(snap.val() || {}) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/sync', async (req, res) => {
  await syncAllSports();
  res.json({ status: 'sync_completed' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy activo en puerto ${PORT}`));
