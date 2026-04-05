const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Ruta principal
app.get('/', (req, res) => {
    res.json({ status: 'online', message: 'BetGroup Proxy funcionando' });
});

// Ruta de partidos (datos de ejemplo)
app.get('/api/fixtures', (req, res) => {
    const partidos = [
        {
            id: 1,
            local: "Real Madrid",
            visitante: "Barcelona",
            marcador: "2-1",
            minuto: "71'",
            cuota_local: 2.10,
            cuota_empate: 3.40,
            cuota_visitante: 3.20
        },
        {
            id: 2,
            local: "Manchester City",
            visitante: "Liverpool",
            marcador: "1-0",
            minuto: "58'",
            cuota_local: 2.05,
            cuota_empate: 3.50,
            cuota_visitante: 3.30
        },
        {
            id: 3,
            local: "Bayern Munich",
            visitante: "Dortmund",
            marcador: "0-0",
            minuto: "15'",
            cuota_local: 1.85,
            cuota_empate: 3.60,
            cuota_visitante: 4.00
        }
    ];
    
    res.json({ status: 'online', data: partidos });
});

// Ruta de cuotas
app.get('/api/odds', (req, res) => {
    res.json({
        status: 'online',
        data: { local: 2.10, empate: 3.40, visitante: 3.20 }
    });
});

app.listen(PORT, () => {
    console.log(`Proxy corriendo en puerto ${PORT}`);
});
