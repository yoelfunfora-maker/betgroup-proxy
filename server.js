const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// TU API KEY DE API-FOOTBALL
const API_KEY = "6578ce4bcf940dbff3f82b1ca6549cef";

app.get('/api/fixtures', async (req, res) => {
    try {
            const { date, league } = req.query;
                    let url = `https://v3.football.api-sports.io/fixtures?date=${date}`;
                            if (league && league !== 'all') url += `&league=${league}`;
                                    
                                            const response = await axios.get(url, {
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