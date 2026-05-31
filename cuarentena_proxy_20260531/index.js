const http = require('http');
const httpProxy = require('http-proxy');

// CONFIGURACIÓN DE PUERTOS (Cambiado a un puerto libre de Android)
const PORT_PUBLICO = 8080;      // Usamos el 8080 para evitar el error de permisos (EACCES)
const PORT_INTERNO = 3000;      // El puerto donde corre tu app principal de BetGroup

// Crear el servidor de proxy
const proxy = httpProxy.createProxyServer({});

const server = http.createServer((req, res) => {
  console.log(`[Proxy] Redirigiendo petición: ${req.url}`);

  // Redirigir el tráfico al puerto interno
  proxy.web(req, res, { target: `http://127.0.0.1:${PORT_INTERNO}` });
});

// GESTIÓN DE ERRORES
proxy.on('error', (err, req, res) => {
  console.error('[Proxy Error]: No se pudo conectar con la aplicación interna.');
  res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Hosting Temporal BetGroup: La aplicación interna se está reiniciando o está apagada.');
});

// Encender el Proxy
server.listen(PORT_PUBLICO, () => {
  console.log(`🚀 Proxy de BetGroup activo en el puerto público ${PORT_PUBLICO}`);
  console.log(`👉 Redirigiendo tráfico hacia el puerto interno ${PORT_INTERNO}`);
});
