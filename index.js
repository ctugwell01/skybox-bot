const WebSocket = require('ws');

const RCON_HOST = process.env.RCON_HOST;
const RCON_PORT = process.env.RCON_PORT || '28152';
const RCON_PASS = process.env.RCON_PASS;

const TRIGGERS = [
  {
    keywords: ['skybox', 'sky box', 'get in sky'],
    reply: 'say [Ruscar Bot]: To get into the skybox, type /view in chat!',
    cooldown: false
  },
  {
    keywords: ['leader', 'leaderboard', 'who is winning', 'whos winning', 'who winning', 'race position', 'positions'],
    reply: 'say [Ruscar Bot]: To see who is winning type /pos in chat! If there is no active race type /race leaders instead!',
    cooldown: false
  }
];

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
      const channel = (msg.Channel || 0);

      if (channel !== 0) return;
      if (!text) return;

      console.log('[CHAT]', msg.Message);

      for (const trigger of TRIGGERS) {
        if (trigger.keywords.some(kw => text.includes(kw))) {
          if (trigger.cooldown) continue;
          trigger.cooldown = true;
          setTimeout(() => trigger.cooldown = false, 10000);

          console.log('Triggered! Sending:', trigger.reply);
          ws.send(JSON.stringify({
            Identifier: counter++,
            Message: trigger.reply,
            Name: 'Bot'
          }));
        }
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
