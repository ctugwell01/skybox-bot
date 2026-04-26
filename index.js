const axios = require('axios');

const BM_TOKEN  = process.env.BM_TOKEN;
const SERVER_ID = process.env.SERVER_ID;
const POLL_MS   = parseInt(process.env.POLL_MS || '5000');

const SKYBOX_KEYWORDS = ['skybox', 'sky box', 'how u get in the sky', 'get in sky'];

if (!BM_TOKEN || !SERVER_ID) {
  console.error('Missing BM_TOKEN or SERVER_ID!');
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${BM_TOKEN}`,
  'Content-Type': 'application/json',
};

const seenIds = new Set();

async function fetchChat() {
  try {
    const res = await axios.get(
      `https://api.battlemetrics.com/servers/${SERVER_ID}/relationships/rconLog`,
      { headers, params: { 'page[size]': 20 } }
    );
    return res.data.data || [];
  } catch (err) {
    console.error('Error fetching chat:', err.response?.status, err.message);
    // Log full error details to help debug
    if (err.response?.data) console.error(JSON.stringify(err.response.data));
    return [];
  }
}

async function sendRcon(command) {
  try {
    await axios.post(
      `https://api.battlemetrics.com/servers/${SERVER_ID}/command`,
      { data: { type: 'rconCommand', attributes: { command, blocked: false } } },
      { headers }
    );
    console.log('Sent: ' + command);
  } catch (err) {
    console.error('Error sending RCON:', err.response?.status, err.message);
  }
}

async function poll() {
  const messages = await fetchChat();
  for (const msg of messages) {
    const id   = msg.id;
    const text = (msg.attributes?.message || msg.attributes?.log || '').toLowerCase();
    const player = msg.attributes?.player || msg.attributes?.name || 'Unknown';
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    if (text) console.log(`[LOG] ${player}: ${text}`);
    if (SKYBOX_KEYWORDS.some(kw => text.includes(kw))) {
      console.log('Triggered! Sending /view...');
      await sendRcon('say /view');
    }
  }
}

console.log('Bot started...');
setInterval(poll, POLL_MS);
poll();
