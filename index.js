const WebSocket = require('ws');

const RCON_HOST = process.env.RCON_HOST;
const RCON_PORT = process.env.RCON_PORT || '28152';
const RCON_PASS = process.env.RCON_PASS;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const COMMANDS = [
  { id: 'skybox', reply: 'say [Ruscar Bot]: To get into the skybox, type /view in chat!' },
  { id: 'leader', reply: 'say [Ruscar Bot]: To see who is winning type /pos in chat! If there is no active race type /race leaders instead!' },
  { id: 'portal', reply: 'say [Ruscar Bot]: Not sure which portal? Check the MIDDLE board at the race hub — it shows the current/next league race map!' },
  { id: 'modtool', reply: 'say [Ruscar Bot]: Ask 5HeadNN and he will give you one, please be patient!' },
  { id: 'food', reply: 'say [Ruscar Bot]: Type /kit in chat and redeem the food kit!' },
  { id: 'none', reply: null }
];

const spamTracker = {};
const SPAM_LIMIT  = 7;
const SPAM_WINDOW = 10000;
const prisoned = new Set();

let ws;
let counter = 1;
let cooldown = false;

function isSpamming(userId) {
  const now = Date.now();
  if (!spamTracker[userId]) spamTracker[userId] = [];
  spamTracker[userId] = spamTracker[userId].filter(t => now - t < SPAM_WINDOW);
  spamTracker[userId].push(now);
  console.log(`[SPAM] ${userId} has ${spamTracker[userId].length} messages in window`);
  return spamTracker[userId].length >= SPAM_LIMIT;
}

function extractPlayerMessage(raw) {
  // Strip BetterChat prefix - get text after last ": "
  const parts = raw.split(': ');
  return parts.length > 1 ? parts[parts.length - 1].trim() : raw.trim();
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
- "portal" if the player is asking which portal to go through, which map the race is on, which track, or which race to join
- "modtool" if the player is asking for a mod tool, modular car, vehicle tool, or says things like "can i get a mod tool", "can we have a mod tool", "give me a mod tool", "need a mod tool", "where is the mod tool", "how do i get a mod tool"
- "food" if the player is asking for food, how to eat, how to get food, or saying they are hungry
- "none" if it doesn't match any of the above

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

      if (msg.Type !== 'Chat') return;

      let inner;
      try { inner = JSON.parse(msg.Message); } catch { return; }

      const rawText  = inner.Message || '';
      const username = inner.Username || '';
      const userId   = inner.UserId || '';

      if (!rawText) return;
      if (userId === '0' || username === 'SERVER') return;

      // Strip BetterChat prefix to get just the player's actual message
      const text = extractPlayerMessage(rawText).toLowerCase();

      console.log(`[CHAT] ${username}: ${text}`);

      // Check for spam first — instant, no AI
      if (isSpamming(userId)) {
        if (!prisoned.has(userId)) {
          prisoned.add(userId);
          console.log(`Spam detected from ${username} — prisoning!`);
          sendRcon(`prison ${userId}`);
          sendRcon(`say [Ruscar Bot]: ${username} has been automatically prisoned for spamming.`);
          delete spamTracker[userId];
          setTimeout(() => prisoned.delete(userId), 30000);
        }
        return;
      }

      // Check for slurs
      const isSlur = await checkSlur(text);
      if (isSlur) {
        if (!prisoned.has(userId)) {
          prisoned.add(userId);
          console.log(`Slur detected from ${username} — prisoning!`);
          sendRcon(`prison ${userId}`);
          sendRcon(`say [Ruscar Bot]: ${username} has been automatically prisoned for using hate speech.`);
          setTimeout(() => prisoned.delete(userId), 30000);
        }
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
      console.log('Error:', e.message);
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
