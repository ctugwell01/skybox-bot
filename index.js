const WebSocket = require('ws');
const fs = require('fs');

const RCON_HOST = process.env.RCON_HOST;
const RCON_PORT = process.env.RCON_PORT || '28152';
const RCON_PASS = process.env.RCON_PASS;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;

const EXAMPLES_FILE  = '/tmp/bot_examples.json';
const BLOCKED_FILE   = '/tmp/blocked_words.json';
const OFFENCES_FILE  = '/tmp/spam_offences.json';

let savedExamples = {};
try {
  if (fs.existsSync(EXAMPLES_FILE)) {
    savedExamples = JSON.parse(fs.readFileSync(EXAMPLES_FILE, 'utf8'));
    console.log('Loaded ' + Object.keys(savedExamples).length + ' saved example categories');
  }
} catch (e) { console.log('No saved examples found'); }

function saveExamples() { fs.writeFileSync(EXAMPLES_FILE, JSON.stringify(savedExamples, null, 2)); }

function addExample(category, phrase) {
  if (!savedExamples[category]) savedExamples[category] = [];
  if (!savedExamples[category].includes(phrase)) { savedExamples[category].push(phrase); saveExamples(); return true; }
  return false;
}

function buildExamplesPrompt() {
  if (Object.keys(savedExamples).length === 0) return '';
  let prompt = '\n\nAdditional examples learned from admins:';
  for (const [category, phrases] of Object.entries(savedExamples)) {
    prompt += '\n- "' + category + '": ' + phrases.map(p => '"' + p + '"').join(', ');
  }
  return prompt;
}

const COMMANDS = [
  { id: 'skybox',  reply: 'say [Ruscar Bot]: First go through the track portal, then type /view in chat to get into the skybox!' },
  { id: 'leader',  reply: 'say [Ruscar Bot]: To see who is winning type /pos in chat! If there is no active race type /race leaders instead!' },
  { id: 'portal',  reply: 'say [Ruscar Bot]: Not sure which portal? Check the MIDDLE board at the race hub — it shows the current/next league race map!' },
  { id: 'modtool', reply: 'say [Ruscar Bot]: Ask 5HeadNN and he will give you one, please be patient!' },
  { id: 'food',    reply: 'say [Ruscar Bot]: Type /kit in chat and redeem the food kit!' },
  { id: 'none',    reply: null }
];

const spamOffences   = {};
const prisoned       = new Set();
const playerCooldowns = new Set();
const releaseCooldowns = new Set();
const warnedPlayers  = new Set();
const messageHistory = {};

// Load persisted spam offences
try {
  if (fs.existsSync(OFFENCES_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(OFFENCES_FILE, 'utf8'));
    Object.assign(spamOffences, loaded);
    console.log('Loaded spam offences for ' + Object.keys(loaded).length + ' players');
  }
} catch (e) { console.log('No spam offences file found'); }

function saveOffences() { fs.writeFileSync(OFFENCES_FILE, JSON.stringify(spamOffences, null, 2)); }

let BLOCKED_WORDS = [
  'retard', 'retarded', 'spastic', 'spaz',
  'nigger', 'nigga', 'faggot', 'fag', 'tranny',
  'chink', 'kike', 'gook', 'wetback', 'beaner'
];

try {
  if (fs.existsSync(BLOCKED_FILE)) {
    const extra = JSON.parse(fs.readFileSync(BLOCKED_FILE, 'utf8'));
    BLOCKED_WORDS = [...new Set([...BLOCKED_WORDS, ...extra])];
    console.log('Loaded ' + extra.length + ' extra blocked words');
  }
} catch (e) { console.log('No extra blocked words file found'); }

const HARDCODED_WORDS = [...BLOCKED_WORDS];

const THREAT_WORDS = [
  'kys', 'kill yourself', 'go die', 'go kill yourself',
  'end yourself', 'neck yourself', 'rope yourself',
  'drink bleach', 'i will kill you', 'ill kill you',
  'i hope you die', 'hope you die', 'you should die',
  'kill ur self', 'kill your self'
];

function containsThreat(text) {
  if (THREAT_WORDS.some(phrase => text.includes(phrase))) return true;
  const noSpaces = text.replace(/[\s\-_]+/g, '');
  if (THREAT_WORDS.some(phrase => noSpaces.includes(phrase.replace(/\s/g, '')))) return true;
  return false;
}

function saveBlockedWords() {
  const custom = BLOCKED_WORDS.filter(w => !HARDCODED_WORDS.includes(w));
  fs.writeFileSync(BLOCKED_FILE, JSON.stringify(custom, null, 2));
}

const SPAM_TIMERS = [5, 10, 30];

let ws;
let counter = 1;

function containsBlockedWord(text) {
  if (BLOCKED_WORDS.some(word => text.includes(word))) return true;
  const noSpaces = text.replace(/[\s\-_.,\/\\]+/g, '');
  if (BLOCKED_WORDS.some(word => noSpaces.includes(word))) return true;
  const normalised = text.replace(/3/g,'e').replace(/4/g,'a').replace(/0/g,'o').replace(/1/g,'i').replace(/@/g,'a').replace(/\$/g,'s').replace(/[\s\-_.,\/\\]+/g,'');
  if (BLOCKED_WORDS.some(word => normalised.includes(word))) return true;
  const words = text.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    for (let j = i + 1; j <= Math.min(i + 3, words.length); j++) {
      const joined = words.slice(i, j).join('');
      if (BLOCKED_WORDS.some(word => joined.includes(word))) return true;
    }
  }
  return false;
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

function trackMessage(userId, text) {
  if (!messageHistory[userId]) messageHistory[userId] = [];
  messageHistory[userId].push(text);
  if (messageHistory[userId].length > 8) messageHistory[userId].shift();
}

function sendRcon(command) {
  ws.send(JSON.stringify({ Identifier: counter++, Message: command, Name: 'Bot' }));
}

async function sendDiscordAlert(username, userId, reason, offence) {
  if (!DISCORD_WEBHOOK) return;
  const body = {
    embeds: [{
      title: '🚨 Player Auto Prisoned',
      color: reason === 'Hate Speech' ? 15158332 : 15105570,
      fields: [
        { name: 'Player', value: username, inline: true },
        { name: 'Reason', value: reason, inline: true },
        { name: 'Steam Profile', value: 'https://steamcommunity.com/profiles/' + userId, inline: false },
        { name: 'Offence', value: offence ? '#' + offence : 'Permanent', inline: true }
      ],
      timestamp: new Date().toISOString()
    }]
  };
  try {
    await fetch(DISCORD_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    console.log('Discord alert sent for ' + username);
  } catch (e) { console.error('Discord alert error:', e.message); }
}

async function prisonPlayer(userId, username, reason) {
  if (prisoned.has(userId)) return;
  prisoned.add(userId);
  delete messageHistory[userId];

  if (reason === 'Spamming') {
    const minutes = getSpamMinutes(userId);
    spamOffences[userId] = (spamOffences[userId] || 0) + 1;
    saveOffences();
    if (minutes !== null) {
      console.log('Spam offence #' + spamOffences[userId] + ' from ' + username + ' — ' + minutes + ' mins');
      await sendDiscordAlert(username, userId, 'Spamming', spamOffences[userId]);
      sendRcon('prison ' + userId + ' Spamming');
      sendRcon('say [Ruscar Bot]: ' + username + ' has been automatically prisoned for spamming. You have ' + minutes + ' minute(s) remaining.');
      setTimeout(function() {
        console.log('Auto releasing ' + username);
        sendRcon('unjail ' + userId);
        prisoned.delete(userId);
        releaseCooldowns.add(userId);
        setTimeout(function() { releaseCooldowns.delete(userId); }, 60000);
      }, minutes * 60 * 1000);
    } else {
      console.log('Spam offence #' + spamOffences[userId] + ' from ' + username + ' — permanent');
      await sendDiscordAlert(username, userId, 'Spamming', spamOffences[userId]);
      sendRcon('prison ' + userId + ' Spamming');
      sendRcon('say [Ruscar Bot]: ' + username + ' has been permanently prisoned for repeated spamming.');
    }
  } else {
    console.log(reason + ' from ' + username + ' — permanent prison');
    await sendDiscordAlert(username, userId, reason, null);
    sendRcon('prison ' + userId + ' ' + reason);
    const msg = reason === 'Threats'
      ? 'say [Ruscar Bot]: ' + username + ' has been automatically prisoned for making threats.'
      : 'say [Ruscar Bot]: ' + username + ' has been automatically prisoned for using hate speech.';
    sendRcon(msg);
  }
}

async function isAISpam(userId) {
  const history = messageHistory[userId] || [];
  if (history.length < 3) return false;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(function() { controller.abort(); }, 5000);
    const historyText = history.map(function(m, i) { return (i + 1) + '. "' + m + '"'; }).join('\n');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      signal: controller.signal,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 5,
        messages: [{
          role: 'user',
          content: 'You are a spam detector for a Rust game server chat. Look at this player\'s recent messages and decide if they are spamming.\n\nSpamming means: sending the same message repeatedly, sending random letters/characters, flooding chat with meaningless content.\nNOT spamming: celebrating after a race (ggs, lets go, wp), normal conversation, asking questions, even if repeated a couple times naturally.\n\nRecent messages from this player:\n' + historyText + '\n\nIs this spam? Reply ONLY with "yes" or "no".'
        }]
      })
    });
    clearTimeout(timeout);
    const data = await res.json();
    return data.content[0].text.trim().toLowerCase() === 'yes';
  } catch (e) {
    console.error('AI spam check error:', e.message);
    return false;
  }
}

async function classifyMessage(text) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 10,
        messages: [{
          role: 'user',
          content: 'You are a classifier for a Rust game server chat bot. Classify this player message into one of these categories:\n- "skybox" if the player is asking how to get into the skybox or sky area\n- "leader" if the player is asking who is winning, about race positions or leaderboard\n- "portal" if the player is asking which portal to go through, which map the race is on, which track, or which race to join\n- "modtool" if the player is asking for a mod tool, modular car, vehicle tool, or says things like "can i get a mod tool", "can we have a mod tool", "give me a mod tool", "need a mod tool"\n- "food" if the player is asking for food, how to eat, how to get food, or saying they are hungry\n- "none" if it doesn\'t match any of the above' + buildExamplesPrompt() + '\n\nReply with ONLY the category word, nothing else.\n\nPlayer message: "' + text + '"'
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
    const controller = new AbortController();
    const timeout = setTimeout(function() { controller.abort(); }, 5000);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      signal: controller.signal,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'You are a moderation bot for a Rust game server. Does this message contain racial slurs, hate speech or discriminatory language including intentional misspellings or variations?\n\nReply with ONLY "yes" or "no".\n\nMessage: "' + text + '"' }]
      })
    });
    clearTimeout(timeout);
    const data = await res.json();
    return data.content[0].text.trim().toLowerCase() === 'yes';
  } catch (e) {
    console.error('AI moderation error:', e.message);
    return false;
  }
}

// Graceful shutdown message
process.on('SIGTERM', function() {
  console.log('SIGTERM received — sending shutdown message...');
  try {
    sendRcon('say [Ruscar Bot]: Updating code, back in a moment!');
    setTimeout(function() { process.exit(0); }, 1500);
  } catch (e) {
    process.exit(0);
  }
});

process.on('SIGINT', function() {
  console.log('SIGINT received — sending shutdown message...');
  try {
    sendRcon('say [Ruscar Bot]: Updating code, back in a moment!');
    setTimeout(function() { process.exit(0); }, 1500);
  } catch (e) {
    process.exit(0);
  }
});

function connect() {
  const url = 'ws://' + RCON_HOST + ':' + RCON_PORT + '/' + RCON_PASS;
  console.log('Connecting...');
  ws = new WebSocket(url);

  ws.on('open', function() {
    console.log('Connected to Rust RCON!');
    setTimeout(function() {
      sendRcon('say [Ruscar Bot]: Update complete! Ruscar Bot is back online and monitoring chat!');
    }, 2000);
  });

  ws.on('message', async function(data) {
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
      console.log('[CHAT] ' + username + ': ' + text);

      // Admin teach command
      if (text.startsWith('!teach ')) {
        const parts = text.slice(7).trim().split(' ');
        const category = parts[0].toLowerCase();
        const phrase = parts.slice(1).join(' ');
        const validCategories = COMMANDS.map(function(c) { return c.id; }).filter(function(c) { return c !== 'none'; });
        if (!phrase) { sendRcon('say [Ruscar Bot]: Usage: !teach <category> <phrase>. Categories: ' + validCategories.join(', ')); return; }
        if (!validCategories.includes(category)) { sendRcon('say [Ruscar Bot]: Unknown category "' + category + '". Valid: ' + validCategories.join(', ')); return; }
        const added = addExample(category, phrase);
        sendRcon(added ? 'say [Ruscar Bot]: Got it! I will now recognise "' + phrase + '" as a ' + category + ' question.' : 'say [Ruscar Bot]: I already know that one!');
        return;
      }

      // Admin block command
      if (text.startsWith('!block ')) {
        const word = text.slice(7).trim().toLowerCase();
        if (!word) { sendRcon('say [Ruscar Bot]: Usage: !block <word>'); return; }
        if (BLOCKED_WORDS.includes(word)) { sendRcon('say [Ruscar Bot]: "' + word + '" is already blocked!'); return; }
        BLOCKED_WORDS.push(word);
        saveBlockedWords();
        console.log('New blocked word added: "' + word + '"');
        sendRcon('say [Ruscar Bot]: "' + word + '" has been added to the blocklist.');
        return;
      }

      // Admin unblock command
      if (text.startsWith('!unblock ')) {
        const word = text.slice(9).trim().toLowerCase();
        if (HARDCODED_WORDS.includes(word)) { sendRcon('say [Ruscar Bot]: Cannot remove hardcoded blocked words.'); return; }
        const idx = BLOCKED_WORDS.indexOf(word);
        if (idx === -1) { sendRcon('say [Ruscar Bot]: "' + word + '" is not in the blocklist.'); return; }
        BLOCKED_WORDS.splice(idx, 1);
        saveBlockedWords();
        sendRcon('say [Ruscar Bot]: "' + word + '" has been removed from the blocklist.');
        return;
      }

      // Admin blocklist view
      if (text === '!blocklist') {
        const custom = BLOCKED_WORDS.filter(function(w) { return !HARDCODED_WORDS.includes(w); });
        sendRcon(custom.length === 0 ? 'say [Ruscar Bot]: No custom blocked words yet. Use !block <word> to add one.' : 'say [Ruscar Bot]: Custom blocked words: ' + custom.join(', '));
        return;
      }

      if (prisoned.has(userId)) return;
      if (releaseCooldowns.has(userId)) return;

      // Blocklist instant check
      console.log('[BLOCKLIST CHECK] text: "' + text + '" caught: ' + containsBlockedWord(text));
      if (containsBlockedWord(text)) {
        await prisonPlayer(userId, username, 'Hate Speech');
        return;
      }

      // Threat check — instant prison
      if (containsThreat(text)) {
        console.log('Threat detected from ' + username);
        await prisonPlayer(userId, username, 'Threats');
        return;
      }

      // Track message then AI spam check
      trackMessage(userId, text);
      const spamDetected = await isAISpam(userId);
      console.log('[AI SPAM] ' + username + ': ' + (spamDetected ? 'SPAM' : 'ok'));
      if (spamDetected) {
        await prisonPlayer(userId, username, 'Spamming');
        return;
      }

      // AI slur check
      const isSlur = await checkSlur(text);
      if (isSlur) {
        if (warnedPlayers.has(userId)) {
          await prisonPlayer(userId, username, 'Hate Speech');
          warnedPlayers.delete(userId);
        } else {
          warnedPlayers.add(userId);
          console.log('Warning issued to ' + username);
          sendRcon('say [Ruscar Bot]: WARNING ' + username + ' — inappropriate language detected. Next offence will result in automatic prison.');
        }
        return;
      }

      // Info commands with per-player cooldown
      if (playerCooldowns.has(userId)) return;
      playerCooldowns.add(userId);
      setTimeout(function() { playerCooldowns.delete(userId); }, 10000);

      const category = await classifyMessage(text);
      console.log('AI classified as: ' + category);

      const command = COMMANDS.find(function(c) { return c.id === category; });
      if (command && command.reply) {
        console.log('Sending: ' + command.reply);
        sendRcon(command.reply);
      } else {
        playerCooldowns.delete(userId);
      }
    } catch (e) {
      console.log('Error:', e.message);
    }
  });

  ws.on('close', function() {
    console.log('Disconnected, reconnecting in 5s...');
    setTimeout(connect, 5000);
  });

  ws.on('error', function(err) { console.error('WS Error:', err.message); });
}

if (!RCON_HOST || !RCON_PASS) { console.error('Missing RCON_HOST or RCON_PASS!'); process.exit(1); }

console.log('Bot started...');
connect();
