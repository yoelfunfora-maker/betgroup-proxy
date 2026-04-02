
                                                                                                                    res.json(response.data);
                    const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// Tu API key de API-Football
const API_KEY = "6578ce4bcf940dbff3f82b1ca6549cef";

// Endpoint de prueba
app.get('/', (req, res) => {
    res.json({ 
        status: 'online', 
        message: 'BetGroup Proxy funcionando',
        time: new Date().toISOString()
    });
});

// Endpoint para partidos por fecha
app.get('/api/fixtures', async (req, res) => {
    try {
        const { date, league } = req.query;
        
        if (!date) {
            return res.status(400).json({ error: 'Se requiere fecha (YYYY-MM-DD)' });
        }
        
        let url = `https://v3.football.api-sports.io/fixtures?date=${date}`;
        
        const response = await axios.get(url, {
            headers: {
                'x-rapidapi-key': API_KEY,
                'x-rapidapi-host': 'v3.football.api-sports.io'
            },
            timeout: 10000
        });
        
        res.json(response.data);
    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).json({ 
            error: error.message,
            date: req.query.date
        });
    }
});

// Endpoint para ligas
app.get('/api/leagues', async (req, res) => {
    try {
        const response = await axios.get('https://v3.football.api-sports.io/leagues', {
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Proxy corriendo en puerto ${PORT}`);
});                                                                                                                                                                               res.status(500).json({ error: error.message });
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
