const WebSocket = require('ws');

const RCON_HOST = process.env.RCON_HOST;
const RCON_PORT = process.env.RCON_PORT || '28016';
const RCON_PASS = process.env.RCON_PASS;

const SKYBOX_KEYWORDS = ['skybox', 'sky box', 'get in sky'];

let ws;
let counter = 1;

function connect() {
  ws = new WebSocket(`ws://${RCON_HOST}:${RCON_PORT}/${RCON_PASS}`);

  ws.on('open', () => console.log('Connected to Rust RCON!'));

  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    const text = (msg.Message || '').toLowerCase();
    console.log('[RCON]', msg.Message);
    if (SKYBOX_KEYWORDS.some(kw => text.includes(kw))) {
      console.log('Triggered! Sending /view...');
      ws.send(JSON.stringify({ Identifier: counter++, Message: 'say /view', Name: 'Bot' }));
    }
  });

  ws.on('close', () => { console.log('Disconnected, reconnecting...'); setTimeout(connect, 5000); });
  ws.on('error', (err) => console.error('WS Error:', err.message));
}

if (!RCON_HOST || !RCON_PASS) { console.error('Missing RCON_HOST or RCON_PASS!'); process.exit(1); }

console.log('Bot started...');
connect();
