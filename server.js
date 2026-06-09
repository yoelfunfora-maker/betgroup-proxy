const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// Inicializar Firebase Admin
let serviceAccount;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_B64) {
    const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8');
    serviceAccount = JSON.parse(decoded);
  } else {
    serviceAccount = require('./serviceAccountKey.json');
  }
} catch(e) {
  console.error('Error al cargar service account:', e.message);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://betgroup-cuba-2024-default-rtdb.firebaseio.com'
});

const app = express();
app.use(cors());
app.use(express.json());

// Función de notificación a Telegram
const TG_TOKEN = process.env.TG_TOKEN || '8671464180:AAHhu_Ct9-3Q6Arjle-7Xy4DyUGuuNvraBs';
const TG_CHAT = process.env.TG_CHAT || '-5154764705';

async function tgNotify(message) {
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: message, parse_mode: 'HTML' })
    });
  } catch(e) {
    console.error('[TG] Error:', e.message);
  }
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'online', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// Endpoint de apuestas (NUEVO - RECONSTRUIDO)
app.post('/api/apostar', async (req, res) => {
  try {
    const { uid, amount, eventName, type, odds, sport } = req.body;
    if (!uid || !amount || !eventName) {
      return res.status(400).json({ error: 'Faltan parámetros: uid, amount, eventName' });
    }

    const db = admin.database();
    const userRef = db.ref(`users/${uid}/creditoReal`);

    const result = await userRef.transaction((saldo) => {
      if (saldo === null) saldo = 0;
      if (saldo >= amount) return saldo - amount;
      return;
    });

    if (!result.committed) {
      return res.status(400).json({ error: 'Saldo insuficiente' });
    }

    const apuestaRef = db.ref('apuestas').push();
    await apuestaRef.set({
      uid, eventName, type, monto: amount, cuota: odds,
      sport: sport || 'soccer', estado: 'pendiente', fecha: Date.now()
    });

    const msgTG = `💰 <b>NUEVA APUESTA</b>\n👤 ${uid}\n📊 ${type}\n💵 $${amount}\n📈 Cuota: ${odds}x`;
    await tgNotify(msgTG);

    console.log(`[APOSTAR] ${uid} apostó ${amount} CR en ${eventName}`);
    res.json({ success: true, message: 'Apuesta confirmada' });

  } catch(err) {
    console.error('[APOSTAR] Error:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Endpoint de liquidación (existente)
app.post('/api/liquidar', async (req, res) => {
  try {
    const { uid, betId, estado, ganancia, marcador } = req.body;
    if (!uid || !betId || !estado) {
      return res.status(400).json({ error: 'Faltan parámetros' });
    }
    const ref = admin.database().ref(`apuestas/${uid}/${betId}`);
    await ref.update({
      estado, ganancia: ganancia || 0,
      marcadorFinal: marcador || 'Liquidado', resueltoEn: Date.now()
    });
    // Acreditar ganancia (Fix A)
    if (estado === 'ganada' && ganancia > 0) {
      await admin.database().ref(`users/${uid}/creditoReal`).transaction(current => (current || 0) + ganancia);
    }
    await tgNotify(`✅ <b>APUESTA LIQUIDADA</b>\n💰 ${betId}\n📊 Estado: ${estado}\n💵 Ganancia: $${ganancia}`);
    res.json({ success: true, betId, estado });
  } catch(err) {
    console.error('[LIQUIDAR] Error:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ BetGroup Pro Proxy v2.0 en puerto ${PORT}`);
});
