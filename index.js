const WebSocket = require('ws');

const RCON_HOST = process.env.RCON_HOST;
const RCON_PORT = process.env.RCON_PORT || '28152';
const RCON_PASS = process.env.RCON_PASS;

const SKYBOX_KEYWORDS = ['skybox', 'sky box', 'get in sky'];

let ws;
let counter = 1;

function connect() {
  const url = `ws://${RCON_HOST}:${RCON_PORT}/${RCON_PASS}`;
  console.log('Connecting...');
  ws = new WebSocket(url);

  ws.on('open', () => {
    console.log('Connected to Rust RCON!');
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const text = (msg.Message || '').toLowerCase();
      if (text) console.log('[MSG]', msg.Message);
      if (SKYBOX_KEYWORDS.some(kw => text.includes(kw))) {
        console.log('Triggered! Sending message...');
        ws.send(JSON.stringify({
          Identifier: counter++,
          Message: 'say To get into the skybox, type /view in chat!',
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
