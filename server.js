                                                                                                                                                                                                                                            const PORT = process.env.PORT || 3000;                                                                                      const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Ruta de prueba
app.get('/', (req, res) => {
    res.json({ status: 'online', message: 'BetGroup Proxy funcionando' });
});

// Ruta para obtener partidos en vivo
app.get('/api/fixtures', async (req, res) => {
    try {
        const { live = 'all', league } = req.query;
        
        // Aquí puedes conectar con API-Football o devolver datos de ejemplo
        // Mientras tanto, devolvemos datos de muestra para probar
        const sampleData = [
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
            }
        ];
        
        res.json({
            status: 'online',
            data: sampleData
        });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Ruta para obtener cuotas de un partido específico
app.get('/api/odds', async (req, res) => {
    try {
        const { fixture } = req.query;
        res.json({
            status: 'online',
            data: {
                local: 2.10,
                empate: 3.40,
                visitante: 3.20
            }
        });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`Proxy corriendo en puerto ${PORT}`);
});                                               
