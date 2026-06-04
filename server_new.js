PLACEHOLDER_ANTES_LISTEN
// ==================== ENDPOINT MANUAL ====================
app.post('/api/settle-manual-marcador', async (req, res) => {
  try {
    const { eventoNombre, marcador } = req.body;
    if (!eventoNombre || !marcador) {
      return res.json({ success: false, msg: 'Falta evento o marcador' });
    }
    await db.ref('marcadosCompletados/' + eventoNombre).set({ marcador, ts: Date.now() });
    const result = await settleAllPendingBets();
    res.json({ success: true, liquidadas: result.total, msg: 'Liquidación ejecutada' });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

PLACEHOLDER_DESPUES_LISTEN
