const WebSocket = require('ws');

const RCON_HOST = process.env.RCON_HOST;
const RCON_PORT = process.env.RCON_PORT || '28152';
const RCON_PASS = process.env.RCON_PASS;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const COMMANDS = [
  { id: 'skybox', reply: 'say [Ruscar Bot]: To get into the skybox, type /view in chat!' },
  { id: 'leader', reply: 'say [Ruscar Bot]: To see who is winning type /pos in chat! If there is no active race type /race leaders instead!' },
  { id: 'none', reply: null }
];

let ws;
let counter = 1;
let cooldown = false;

function extractMessage(raw) {
  const parts = raw.split(': ');
  return parts.length > 1 ? parts[parts.length - 1].trim() : raw.trim();
}

function extractUsername(raw) {
  // BetterChat format: "[Better Chat] [Team] [Owner] [Admin] 5HeadNN: message"
  // Get everything before the last ": " then take the last word (the username)
  const beforeMessage = raw.split(': ').slice(0, -1).join(': ');
  const words = beforeMessage.trim().split(' ');
  return words[words.length - 1].trim();
}

async function classifyMessage(text) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 10,
        messages: [{
          role: 'user',
          content: `You are a classifier for a Rust game server chat bot. Classify this player message into one of these categories:
- "skybox" if the player is asking how to get into the skybox or sky area
- "leader" if the player is asking who is winning, about race positions or leaderboard
- "none" if it doesn't match either

Reply with ONLY the category word, nothing else.

Player message: "${text}"`
        }]
      })
    });
    const data = await res.json();
    return data.content[0].text.trim().toLowerCase();
  } catch (e) {
    console.error('AI error:', e.message);
    return 'none';
  }
}

async function checkSlur(text) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 10,
        messages: [{
          role: 'user',
          content: `You are a moderation bot for a Rust game server. Does this message contain racial slurs, hate speech or discriminatory language including intentional misspellings or variations?

Reply with ONLY "yes" or "no".

Message: "${text}"`
        }]
      })
    });
    const data = await res.json();
    return data.content[0].text.trim().toLowerCase() === 'yes';
  } catch (e) {
    console.error('AI moderation error:', e.message);
    return false;
  }
}

function sendRcon(command) {
  ws.send(JSON.stringify({
    Identifier: counter++,
    Message: command,
    Name: 'Bot'
  }));
}

function connect() {
  const url = `ws://${RCON_HOST}:${RCON_PORT}/${RCON_PASS}`;
  console.log('Connecting...');
  ws = new WebSocket(url);

  ws.on('open', () => {
    console.log('Connected to Rust RCON!');
  });

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const raw = msg.Message || '';
      const channel = (msg.Channel || 0);

      // Extract username from msg fields or from raw BetterChat format
      const player = msg.Username || msg.Name || extractUsername(raw);

      if (channel !== 0) return;
      if (!raw) return;

      const text = extractMessage(raw).toLowerCase();
      console.log(`[CHAT] ${player}: ${text}`);

      // Check for slurs first
      const isSlur = await checkSlur(text);
      if (isSlur) {
        console.log(`🚨 Slur detected from ${player} — prisoning!`);
        sendRcon(`prison ${player}`);
        sendRcon(`say [Ruscar Bot]: ${player} has been automatically prisoned for using hate speech.`);
        return;
      }

      // Info commands with cooldown
      if (cooldown) return;
      cooldown = true;
      setTimeout(() => cooldown = false, 10000);

      const category = await classifyMessage(text);
      console.log('AI classified as:', category);

      const command = COMMANDS.find(c => c.id === category);
      if (command && command.reply) {
        console.log('Sending:', command.reply);
        sendRcon(command.reply);
      } else {
        cooldown = false;
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
