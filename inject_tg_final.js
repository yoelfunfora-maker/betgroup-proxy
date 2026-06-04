const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

// Buscar el console.log de settleAllPendingBets
const target = "console.log('[AUTO-SETTLE] Liquidación automática completada:', settledBets.length, 'apuestas procesadas.');";

// Bloque de notificación (usando concatenación simple, sin backticks ni saltos literales)
const notification = [
  '    if (settledBets.length > 0 && typeof tgNotify === "function") {',
  '      try {',
  '        var msg = "";',
  '        msg += "<b>LIQUIDACION AUTOMATICA</b>\\n";',
  '        msg += "📅 " + new Date().toLocaleString() + "\\n";',
  '        msg += "📊 Total: " + settledBets.length + " apuestas\\n\\n";',
  '        for (var i = 0; i < settledBets.length; i++) {',
  '          var bet = settledBets[i];',
  '          msg += "• " + bet.evento + " → " + (bet.resultado === "ganada" ? "GANADA" : "PERDIDA") + "\\n";',
  '        }',
  '        await tgNotify(msg);',
  '      } catch(e) {',
  '        console.error("[TG] Error:", e.message);',
  '      }',
  '    }'
].join('\n');

code = code.replace(target, notification + '\n' + target);
fs.writeFileSync('server.js', code);
console.log('✅ Notificación Telegram inyectada correctamente.');
