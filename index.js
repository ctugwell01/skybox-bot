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
const SPAM_LIMIT  = 10;
const SPAM_WINDOW = 10000;

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
    console.e
