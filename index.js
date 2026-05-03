const WebSocket = require('ws');

const RCON_HOST = process.env.RCON_HOST;
const RCON_PORT = process.env.RCON_PORT || '28152';
const RCON_PASS = process.env.RCON_PASS;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;

const COMMANDS = [
  { id: 'skybox', reply: 'say [Ruscar Bot]: To get into the skybox, type /view in chat!' },
  { id: 'leader', reply: 'say [Ruscar Bot]: To see who is winning type /pos in chat! If there is no active race type /race leaders instead!' },
  { id: 'portal', reply: 'say [Ruscar Bot]: Not sure which portal? Check the MIDDLE board at the race hub — it shows the current/next league race map!' },
  { id: 'modtool', reply: 'say [Ruscar Bot]: Ask 5HeadNN and he will give you one, please be patient!' },
  { id: 'food', reply: 'say [Ruscar Bot]: Type /kit in chat and redeem the food kit!' },
  { id: 'none', reply: null }
];

const spamTracker = {};
const repeatTracker = {};
const spamOffences = {};
const prisoned = new Set();
const playerCooldowns = new Set();
const releaseCooldowns = new Set(); // prevents spam right after release
const warnedPlayers = new Set(); // tracks who has already been warned

const SPAM_LIMIT   = 7;
const SPAM_WINDOW  = 10000;
const REPEAT_LIMIT = 3;
const SPAM_TIMERS  = [5, 10, 30];

// Explicit blocklist
const BLOCKED_WORDS = [
  'retard', 'retarded', 'spastic', 'spaz',
  'nigger', 'nigga', 'faggot', 'fag', 'tranny',
  'chink', 'kike', 'gook', 'wetback', 'beaner'
];

let ws;
let counter = 1;

function containsBlockedWord(text) {
  // Check normal text
  if (BLOCKED_WORDS.some(word => text.includes(word))) return true;
  // Check with all spaces removed to catch "r etard", "r tard" etc
  const noSpaces = text.replace(/\s+/g, '');
  if (BLOCKED_WORDS.some(word => noSpaces.includes(word))) return true;
  // Check with common substitutions (3=e, 4=a, 0=o, 1=i, @=a)
  const normalised = text.replace(/3/g,'e').replace(/4/g,'a').replace(/0/g,'o').replace(/1/g,'i').replace(/@/g,'a').replace(/\$/g,'s').replace(/\s+/g,'');
  if (BLOCKED_WORDS.some(word => normalised.includes(word))) return true;
  return false;
}

function isSpamming(userId) {
  const now = Date.now();
  if (!spamTracker[userId]) spamTracker[userId] = [];
  spamTracker[userId] = spamTracker[userId].filter(t => now - t < SPAM_WINDOW);
  spamTracker[userId].push(now);
  console.log(`[SPAM] ${userId} has ${spamTracker[userId].length} messages in window`);
  return spamTracker[userId].length >= SPAM_LIMIT;
}

function isRepeating(userId, text) {
  if (!repeatTracker[userId]) repeatTracker[userId] = { text: '', count: 0 };
  if (repeatTracker[userId].text === text) {
    repeatTracker[userId].count++;
  } else {
    repeatTracker[userId] = { text, count: 1 };
  }
  console.log(`[REPEAT] ${userId} said same message ${repeatTracker[userId].count} times`);
  return repeatTracker[userId].count >= REPEAT_LIMIT;
}

function extractPlayerMessage(raw) {
  const parts = raw.split(': ');
  return parts.length > 1 ? parts[parts.length - 1].trim() : raw.trim();
}

function getSpamMinutes(userId) {
  const offence = spamOffences[userId] || 0;
  if (offence < SPAM_TIMERS.length) return SPAM_TIMERS[offence];
  return null;
}

async function sendDiscordAlert(username, userId, reason, offence) {
  if (!DISCORD_WEBHOOK) return;
  const steamUrl = `https://steamcommunity.com/profiles/${userId}`;
  const colour = reason === 'Hate Speech' ? 15158332 : 15105570;
  const body = {
    embeds: [{
      title: '🚨 Player Auto Prisoned',
      color: colour,
      fields: [
        { name: 'Player', value: username, inline: true },
        { name: 'Reason', value: reason, inline: true },
        { name: 'Steam Profile', value: steamUrl, inline: false },
        { name: 'Offence', value: offence ? `#${offence}` : 'Permanent', inline: true }
      ],
      timestamp: new Date().toISOString()
    }]
  };
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    console.log(`Discord alert sent for ${username}`);
  } catch (e) {
    console.error('Discord alert error:', e.message);
  }
}

async function prisonPlayer(userId, username, reason) {
  if (prisoned.has(userId)) return;
  prisoned.add(userId);

  delete spamTracker[userId];
  delete repeatTracker[userId];

  if (reason === 'Spamming') {
    const minutes = getSpamMinutes(userId);
    spamOffences[userId] = (spamOffences[userId] || 0) + 1;

    if (minutes !== null) {
      console.log(`Spam offence #${spamOffences[userId]} from ${username} — ${minutes} mins`);
      await sendDiscordAlert(username, userId, 'Spamming', spamOffences[userId]);
      sendRcon(`prison ${userId} Spamming`);
      sendRcon(`say [Ruscar Bot]: ${username} has been automatically prisoned for spamming. You have ${minutes} minute(s) remaining.`);
      setTimeout(() => {
        console.log(`Auto releasing ${username} after ${minutes} min spam sentence`);
        sendRcon(`unjail ${userId}`);
        prisoned.delete(userId);
      }, minutes * 60 * 1000);
    } else {
      console.log(`Spam offence #${spamOffences[userId]} from ${username} — permanent`);
      await sendDiscordAlert(username, userId, 'Spamming', spamOffences[userId]);
      sendRcon(`prison ${userId} Spamming`);
      sendRcon(`say [Ruscar Bot]: ${username} has been permanently prisoned for repeated spamming.`);
    }
  } else {
    console.log(`${reason} from ${username} — permanent prison`);
    await sendDiscordAlert(username, userId, reason, null);
    sendRcon(`prison ${userId} ${reason}`);
    sendRcon(`say [Ruscar Bot]: ${username} has been automatically prisoned for using hate speech.`);
  }
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
  if (text.length <= 2) return false;
  if (containsBlockedWord(text)) return true;
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

      const text = extractPlayerMessage(rawText).toLowerCase();
      console.log(`[CHAT] ${username}: ${text}`);

      if (prisoned.has(userId)) return;

      // Block spam attempts right after release
      if (releaseCooldowns.has(userId)) return;

      // Check for spam
      if (isSpamming(userId)) {
        await prisonPlayer(userId, username, 'Spamming');
        return;
      }

      // Check for repeat spam
      if (isRepeating(userId, text)) {
        await prisonPlayer(userId, username, 'Spamming');
        return;
      }

      // Check for slurs
      const isSlur = await checkSlur(text);
      if (isSlur) {
        // Blocklist words = instant prison, no warning
        if (containsBlockedWord(text)) {
          await prisonPlayer(userId, username, 'Hate Speech');
          return;
        }
        // AI detected borderline = warn first, prison on second offence
        if (warnedPlayers.has(userId)) {
          await prisonPlayer(userId, username, 'Hate Speech');
          warnedPlayers.delete(userId);
        } else {
          warnedPlayers.add(userId);
          console.log(`Warning issued to ${username}`);
          sendRcon(`say [Ruscar Bot]: ⚠️ ${username} — this is your first warning for inappropriate language. Next offence will result in automatic prison.`);
        }
        return;
      }

      // Info commands with per-player cooldown
      if (playerCooldowns.has(userId)) return;
      playerCooldowns.add(userId);
      setTimeout(() => playerCooldowns.delete(userId), 10000);

      const category = await classifyMessage(text);
      console.log('AI classified as:', category);

      const command = COMMANDS.find(c => c.id === category);
      if (command && command.reply) {
        console.log('Sending:', command.reply);
        sendRcon(command.reply);
      } else {
        playerCooldowns.delete(userId);
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
