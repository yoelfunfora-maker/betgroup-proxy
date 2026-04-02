                                               'x-rapidapi-host': 'v3.football.api-sports.io'
                                                                                                    }
                   const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// Tu API key de API-Football
const API_KEY = "6578ce4bcf940dbff3f82b1ca6549cef";

// Endpoint para obtener partidos por fecha
app.get('/api/fixtures', async (req, res) => {
    try {
        const { date, league } = req.query;
        let url = `https://v3.football.api-sports.io/fixtures?date=${date}`;
        if (league && league !== 'all' && league !== 'undefined') {
            url += `&league=${league}`;
        }
        
        console.log(`Llamando a: ${url}`);
        
        const response = await axios.get(url, {
            headers: {
                'x-rapidapi-key': API_KEY,
                'x-rapidapi-host': 'v3.football.api-sports.io'
            }
        });
        
        console.log(`Respuesta: ${response.data.results} partidos encontrados`);
        res.json(response.data);
    } catch (error) {
        console.error('Error en /api/fixtures:', error.message);
        res.status(500).json({ error: error.message, details: error.response?.data });
    }
});

// Endpoint para partidos en vivo
app.get('/api/live', async (req, res) => {
    try {
        const response = await axios.get('https://v3.football.api-sports.io/fixtures?live=all', {
            headers: {
                'x-rapidapi-key': API_KEY,
                'x-rapidapi-host': 'v3.football.api-sports.io'
            }
        });
        res.json(response.data);
    } catch (error) {
        console.error('Error en /api/live:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Ruta raíz para verificar
app.get('/', (req, res) => {
    res.json({ 
        status: 'online', 
        message: 'BetGroup Proxy funcionando',
        apiKey: API_KEY ? 'Configurada' : 'No configurada'
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Proxy corriendo en puerto ${PORT}`);
    console.log(`🔑 API Key: ${API_KEY ? 'Configurada' : 'FALTA'}`);
});                                                                                         });
                                                                                                                    res.json(response.data);
                                                                                                                        } catch (error) {
                                                                                                                                res.status(500).json({ error: error.message });
                                                                                                                                    }
                                                                                                                                    });

                                                                                                                                    app.get('/api/live', async (req, res) => {
                                                                                                                                        try {
                                                                                                                                                const response = await axios.get('https://v3.football.api-sports.io/fixtures?live=all', {
                                                                                                                                                            headers: {
                                                                                                                                                                            'x-rapidapi-key': API_KEY,
                                                                                                                                                                                            'x-rapidapi-host': 'v3.football.api-sports.io'
                                                                                                                                                                                                        }
                                                                                                                                                                                                                });
                                                                                                                                                                                                                        res.json(response.data);
                                                                                                                                                                                                                            } catch (error) {
                                                                                                                                                                                                                                    res.status(500).json({ error: error.message });
                                                                                                                                                                                                                                        }
                                                                                                                                                                                                                                        });

                                                                                                                                                                                                                                        app.get('/', (req, res) => {
                                                                                                                                                                                                                                            res.json({ status: 'online', message: 'BetGroup Proxy funcionando' });
                                                                                                                                                                                                                                            });

                                                                                                                                                                                                                                            const PORT = process.env.PORT || 3000;
                                                                                                                                                                                                                                            app.listen(PORT, () => console.log(`Proxy en puerto ${PORT}`));
