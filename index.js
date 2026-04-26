const WebSocket = require('ws');

const RCON_HOST = process.env.RCON_HOST;
const RCON_PORT = process.env.RCON_PORT || '28152';
const RCON_PASS = process.env.RCON_PASS;

const SKYBOX_KEYWORDS = ['skybox', 'sky box', 'get in sky'];

let ws;
let counter = 1;

function connect() {
  const url = `ws://${RCON_HOST}:${RCON_PORT}`;
  console.log('Connecting to', url);
  ws = new WebSocket(url, { headers: { 'Authorization': RCON_PASS } });

  ws.on('open', () => {
    console.log('Connected! Authenticating...');
    ws.send(JSON.stringify({
      Identifier: counter++,
      Message: RCON_PASS,
      Name: 'Auth'
    }));
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const text = (msg.Message || '').toLowerCase();
      if (text) console.log('[MSG]', msg.Message);
      if (SKYBOX_KEYWORDS.some(kw => text.includes(kw))) {
        console.log('Triggered! Sending /view...');
        ws.send(JSON.stringify({
          Identifier: counter++,
          Message: 'say /view',
          Name: 'Bot'
        }));
      }
    } catch (e) {
      console.log('Raw:', data.toString());
    }
  });

  ws.on('close', () => {
    console.log('Disconnected, reconnecting in 5s...');
    setTimeout(connect, 5000);
  });

  ws.on('error', (err) => console.error('WS Error:', err.message));
}

if (!RCON_HOST || !RCON_PASS) {
  console.error('Missing RCON_HOST or RCON_PASS!');
  process.exit(1);
}

console.log('Bot started...');
connect();
