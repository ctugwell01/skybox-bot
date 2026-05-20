const WebSocket = require('ws');
const fs = require('fs');

const RCON_HOST = process.env.RCON_HOST;
const RCON_PORT = process.env.RCON_PORT || '28152';
const RCON_PASS = process.env.RCON_PASS;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;

const EXAMPLES_FILE = '/tmp/bot_examples.json';
const BLOCKED_FILE  = '/tmp/blocked_words.json';
const OFFENCES_FILE = '/tmp/spam_offences.json';

let savedExamples = {};
try { if (fs.existsSync(EXAMPLES_FILE)) { savedExamples = JSON.parse(fs.readFileSync(EXAMPLES_FILE, 'utf8')); console.log('Loaded ' + Object.keys(savedExamples).length + ' example categories'); } } catch(e) {}

function saveExamples() { fs.writeFileSync(EXAMPLES_FILE, JSON.stringify(savedExamples, null, 2)); }
function addExample(category, phrase) {
  if (!savedExamples[category]) savedExamples[category] = [];
  if (!savedExamples[category].includes(phrase)) { savedExamples[category].push(phrase); saveExamples(); return true; }
  return false;
}
function buildExamplesPrompt() {
  if (Object.keys(savedExamples).length === 0) return '';
  let p = '\n\nAdditional examples learned from admins:';
  for (const [cat, phrases] of Object.entries(savedExamples)) p += '\n- "' + cat + '": ' + phrases.map(function(x) { return '"' + x + '"'; }).join(', ');
  return p;
}

const COMMANDS = [
  { id: 'skybox',  reply: 'say [Ruscar Bot]: First go through the track portal, then type /view in chat to get into the skybox!' },
  { id: 'leader',  reply: 'say [Ruscar Bot]: To see who is winning type /pos in chat! If there is no active race type /race leaders instead!' },
  { id: 'portal',  reply: 'say [Ruscar Bot]: Not sure which portal? Check the MIDDLE board at the race hub -- it shows the current/next league race map!' },
  { id: 'modtool', reply: 'say [Ruscar Bot]: Ask 5HeadNN and he will give you one, please be patient!' },
  { id: 'food',    reply: 'say [Ruscar Bot]: Type /kit in chat and redeem the food kit!' },
  { id: 'none',    reply: null }
];

const spamOffences    = {};
const prisoned        = new Set();
const playerCooldowns = new Set();
const releaseCooldowns = new Set();
const warnedPlayers   = new Set();
const messageHistory  = {};

try { if (fs.existsSync(OFFENCES_FILE)) { const l = JSON.parse(fs.readFileSync(OFFENCES_FILE, 'utf8')); Object.assign(spamOffences, l); console.log('Loaded offences for ' + Object.keys(l).length + ' players'); } } catch(e) {}
function saveOffences() { fs.writeFileSync(OFFENCES_FILE, JSON.stringify(spamOffences, null, 2)); }

let BLOCKED_WORDS = ['retard','retarded','spastic','spaz','nigger','nigga','faggot','fag','tranny','chink','kike','gook','wetback','beaner'];
try { if (fs.existsSync(BLOCKED_FILE)) { const extra = JSON.parse(fs.readFileSync(BLOCKED_FILE, 'utf8')); BLOCKED_WORDS = [...new Set([...BLOCKED_WORDS, ...extra])]; console.log('Loaded ' + extra.length + ' extra blocked words'); } } catch(e) {}
const HARDCODED_WORDS = [...BLOCKED_WORDS];
function saveBlockedWords() { const custom = BLOCKED_WORDS.filter(function(w) { return !HARDCODED_WORDS.includes(w); }); fs.writeFileSync(BLOCKED_FILE, JSON.stringify(custom, null, 2)); }

const SPAM_TIMERS = [5, 10, 30];
let ws;
let counter = 1;

function containsBlockedWord(text) {
  if (BLOCKED_WORDS.some(function(w) { return text.includes(w); })) return true;
  const noSpaces = text.replace(/[\s\-_.,/\\]+/g, '');
  if (BLOCKED_WORDS.some(function(w) { return noSpaces.includes(w); })) return true;
  const norm = text.replace(/3/g,'e').replace(/4/g,'a').replace(/0/g,'o').replace(/1/g,'i').replace(/@/g,'a').replace(/\$/g,'s').replace(/[\s\-_.,/\\]+/g,'');
  if (BLOCKED_WORDS.some(function(w) { return norm.includes(w); })) return true;
  const words = text.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    for (let j = i + 1; j <= Math.min(i + 3, words.length); j++) {
      const joined = words.slice(i, j).join('');
      if (BLOCKED_WORDS.some(function(w) { return joined.includes(w); })) return true;
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
  return offence < SPAM_TIMERS.length ? SPAM_TIMERS[offence] : null;
}

function trackMessage(userId, text) {
  if (!messageHistory[userId]) messageHistory[userId] = [];
  messageHistory[userId].push(text);
  if (messageHistory[userId].length > 8) messageHistory[userId].shift();
}

function sendRcon(command) {
  ws.send(JSON.stringify({ Identifier: counter++, Message: command, Name: 'Bot' }));
}

async function callAI(prompt, maxTokens) {
  try {
    const controller = new AbortController();
    const t = setTimeout(function() { controller.abort(); }, 5000);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      signal: controller.signal,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] })
    });
    clearTimeout(t);
    const data = await res.json();
    return data.content[0].text.trim().toLowerCase();
  } catch(e) {
    console.error('AI error:', e.message);
    return '';
  }
}

async function sendDiscordAlert(username, userId, reason, offence) {
  if (!DISCORD_WEBHOOK) return;
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [{ title: 'Player Auto Prisoned', color: reason === 'Hate Speech' ? 15158332 : 15105570, fields: [{ name: 'Player', value: username, inline: true }, { name: 'Reason', value: reason, inline: true }, { name: 'Steam Profile', value: 'https://steamcommunity.com/profiles/' + userId, inline: false }, { name: 'Offence', value: offence ? '#' + offence : 'Permanent', inline: true }], timestamp: new Date().toISOString() }] })
    });
    console.log('Discord alert sent for ' + username);
  } catch(e) { console.error('Discord error:', e.message); }
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
      await sendDiscordAlert(username, userId, 'Spamming', spamOffences[userId]);
      sendRcon('prison ' + userId + ' Spamming');
      sendRcon('say [Ruscar Bot]: ' + username + ' has been automatically prisoned for spamming. You have ' + minutes + ' minute(s) remaining.');
      setTimeout(function() {
        sendRcon('unjail ' + userId);
        prisoned.delete(userId);
        releaseCooldowns.add(userId);
        setTimeout(function() { releaseCooldowns.delete(userId); }, 60000);
      }, minutes * 60 * 1000);
    } else {
      await sendDiscordAlert(username, userId, 'Spamming', spamOffences[userId]);
      sendRcon('prison ' + userId + ' Spamming');
      sendRcon('say [Ruscar Bot]: ' + username + ' has been permanently prisoned for repeated spamming.');
    }
  } else {
    await sendDiscordAlert(username, userId, reason, null);
    sendRcon('prison ' + userId + ' ' + reason);
    if (reason === 'Threats') {
      sendRcon('say [Ruscar Bot]: ' + username + ' has been automatically prisoned for making threats.');
    } else {
      sendRcon('say [Ruscar Bot]: ' + username + ' has been automatically prisoned for using hate speech.');
    }
  }
}

process.on('SIGTERM', function() {
  try { sendRcon('say [Ruscar Bot]: Updating code, back in a moment!'); setTimeout(function() { process.exit(0); }, 1500); } catch(e) { process.exit(0); }
});
process.on('SIGINT', function() {
  try { sendRcon('say [Ruscar Bot]: Updating code, back in a moment!'); setTimeout(function() { process.exit(0); }, 1500); } catch(e) { process.exit(0); }
});

function connect() {
  const url = 'ws://' + RCON_HOST + ':' + RCON_PORT + '/' + RCON_PASS;
  console.log('Connecting...');
  ws = new WebSocket(url);

  ws.on('open', function() {
    console.log('Connected to Rust RCON!');
    setTimeout(function() { sendRcon('say [Ruscar Bot]: Update complete! Ruscar Bot is back online and monitoring chat!'); }, 2000);
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
      if (!rawText || userId === '0' || username === 'SERVER') return;

      const text = extractPlayerMessage(rawText).toLowerCase();
      console.log('[CHAT] ' + username + ': ' + text);

      // Admin commands
      if (text.startsWith('!teach ')) {
        const parts = text.slice(7).trim().split(' ');
        const cat = parts[0]; const phrase = parts.slice(1).join(' ');
        const valid = COMMANDS.map(function(c) { return c.id; }).filter(function(c) { return c !== 'none'; });
        if (!phrase) { sendRcon('say [Ruscar Bot]: Usage: !teach <category> <phrase>'); return; }
        if (!valid.includes(cat)) { sendRcon('say [Ruscar Bot]: Unknown category. Valid: ' + valid.join(', ')); return; }
        sendRcon(addExample(cat, phrase) ? 'say [Ruscar Bot]: Got it! I now know "' + phrase + '" is a ' + cat + ' question.' : 'say [Ruscar Bot]: I already know that one!');
        return;
      }
      if (text.startsWith('!block ')) {
        const word = text.slice(7).trim();
        if (BLOCKED_WORDS.includes(word)) { sendRcon('say [Ruscar Bot]: "' + word + '" is already blocked!'); return; }
        BLOCKED_WORDS.push(word); saveBlockedWords();
        sendRcon('say [Ruscar Bot]: "' + word + '" added to blocklist.'); return;
      }
      if (text.startsWith('!unblock ')) {
        const word = text.slice(9).trim();
        if (HARDCODED_WORDS.includes(word)) { sendRcon('say [Ruscar Bot]: Cannot remove hardcoded words.'); return; }
        const idx = BLOCKED_WORDS.indexOf(word);
        if (idx === -1) { sendRcon('say [Ruscar Bot]: "' + word + '" not in blocklist.'); return; }
        BLOCKED_WORDS.splice(idx, 1); saveBlockedWords();
        sendRcon('say [Ruscar Bot]: "' + word + '" removed from blocklist.'); return;
      }
      if (text === '!blocklist') {
        const custom = BLOCKED_WORDS.filter(function(w) { return !HARDCODED_WORDS.includes(w); });
        sendRcon(custom.length === 0 ? 'say [Ruscar Bot]: No custom blocked words yet.' : 'say [Ruscar Bot]: Custom words: ' + custom.join(', ')); return;
      }

      if (prisoned.has(userId) || releaseCooldowns.has(userId)) return;

      // Handle voice transcripts from VoiceMonitor plugin
      if (msg.Type === 'Generic' && rawText && rawText.startsWith('voicetranscript ')) {
        const parts = rawText.slice(16).split(' ');
        const voiceUserId = parts[0];
        const voiceUsername = parts[1];
        const voiceText = parts.slice(2).join(' ').toLowerCase();
        console.log('[VOICE TRANSCRIPT] ' + voiceUsername + ': ' + voiceText);

        if (containsBlockedWord(voiceText)) {
          await prisonPlayer(voiceUserId, voiceUsername, 'Hate Speech (Voice)');
          return;
        }
        const vThreat = await callAI('You are a multilingual content moderator. Does this voice chat transcript contain threats, telling someone to harm themselves, death wishes, or violent threats? Reply yes or no only. Message: "' + voiceText + '"', 5);
        if (vThreat === 'yes') { await prisonPlayer(voiceUserId, voiceUsername, 'Threats (Voice)'); return; }
        const vSlur = await callAI('You are a multilingual content moderator. Does this voice chat transcript contain racial slurs, hate speech or discriminatory language in any language? Reply yes or no only. Message: "' + voiceText + '"', 5);
        if (vSlur === 'yes') {
          if (warnedPlayers.has(voiceUserId)) { await prisonPlayer(voiceUserId, voiceUsername, 'Hate Speech (Voice)'); warnedPlayers.delete(voiceUserId); }
          else { warnedPlayers.add(voiceUserId); sendRcon('say [Ruscar Bot]: WARNING ' + voiceUsername + ' - inappropriate language in voice chat. Next offence = prison.'); }
        }
        return;
      }

      // 1. Instant blocklist check
      if (containsBlockedWord(text)) {
        console.log('[BLOCKLIST] caught: ' + text);
        await prisonPlayer(userId, username, 'Hate Speech'); return;
      }

      // 2. AI spam check
      trackMessage(userId, text);
      const history = messageHistory[userId] || [];
      if (history.length >= 3) {
        const histText = history.map(function(m, i) { return (i+1) + '. "' + m + '"'; }).join(' | ');
        const spamPrompt = 'Spam detector for Rust game server. Recent messages: ' + histText + ' Is this spam? Spam = same message repeated, random chars, flooding. NOT spam = ggs, celebrating, normal chat. Reply yes or no only.';
        const spamResult = await callAI(spamPrompt, 5);
        console.log('[AI SPAM] ' + username + ': ' + spamResult);
        if (spamResult === 'yes') { await prisonPlayer(userId, username, 'Spamming'); return; }
      }

      // 3. AI threat check
      const threatPrompt = 'You are a multilingual content moderator for a game server. Analyze this message in ANY language. Does it contain: death wishes, telling someone to kill/harm themselves, serious violent threats, or wishing harm on someone? You must detect this in English, French, Spanish, German, Portuguese, Italian, Dutch, Russian, Arabic, Turkish, Polish, Romanian, or any other language. Subtle variations and slang count too. Casual trash talk like noob or you suck does NOT count. Answer yes or no only. Message: "' + text + '"';
      const threatResult = await callAI(threatPrompt, 5);
      console.log('[THREAT] ' + username + ': ' + threatResult);
      if (threatResult === 'yes') { await prisonPlayer(userId, username, 'Threats'); return; }

      // 4. AI slur check
      const slurPrompt = 'You are a multilingual content moderator for a game server. Analyze this message in ANY language. Does it contain racial slurs, hate speech, homophobic slurs, discriminatory language, or derogatory terms targeting someone based on race, ethnicity, religion, sexuality, or nationality? You must detect this in English, French, Spanish, German, Portuguese, Italian, Dutch, Russian, Arabic, Turkish, Polish, Romanian, or any other language. Intentional misspellings and leetspeak count too. Answer yes or no only. Message: "' + text + '"';
      const slurResult = await callAI(slurPrompt, 5);
      console.log('[SLUR] ' + username + ': ' + slurResult);
      if (slurResult === 'yes') {
        if (warnedPlayers.has(userId)) { await prisonPlayer(userId, username, 'Hate Speech'); warnedPlayers.delete(userId); }
        else { warnedPlayers.add(userId); sendRcon('say [Ruscar Bot]: WARNING ' + username + ' - inappropriate language. Next offence = prison.'); }
        return;
      }

      // 5. Info commands
      if (playerCooldowns.has(userId)) return;
      playerCooldowns.add(userId);
      setTimeout(function() { playerCooldowns.delete(userId); }, 10000);

      const classifyPrompt = 'Classifier for Rust game server chat bot. Categories: "skybox" = asking about skybox/sky area, "leader" = asking who is winning/leaderboard/positions, "portal" = asking which portal/map/track, "modtool" = asking for mod tool/vehicle tool, "food" = asking for food/hungry, "none" = nothing matches.' + buildExamplesPrompt() + ' Reply with ONLY the category word. Message: "' + text + '"';
      const category = await callAI(classifyPrompt, 10);
      console.log('AI classified as: ' + category);

      const command = COMMANDS.find(function(c) { return c.id === category; });
      if (command && command.reply) { sendRcon(command.reply); }
      else { playerCooldowns.delete(userId); }

    } catch(e) { console.log('Error:', e.message); }
  });

  ws.on('close', function() { console.log('Disconnected, reconnecting in 5s...'); setTimeout(connect, 5000); });
  ws.on('error', function(err) { console.error('WS Error:', err.message); });
}

if (!RCON_HOST || !RCON_PASS) { console.error('Missing RCON_HOST or RCON_PASS!'); process.exit(1); }
console.log('Bot started...');
connect();
