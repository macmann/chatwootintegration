// server/index.js
// Custom Node.js + Express backend integrating AI with Chatwoot human handoff
require("dotenv").config();
const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory stores
let messageStore = {};    // { [userId]: [{ from, text }] }
let userMapping = {};     // { [userId]: { contactId, conversationId, lastAgentMessageId } }

app.use(cors());
app.use(bodyParser.json());
app.use(express.static("public"));

// 1) Simulated AI response
function getAIResponse(msg) {
  return `AI: I heard you say "${msg}"`;
}

// 2) Find or create a Chatwoot contact (Application API)
async function findOrCreateContact(userId) {
  const email = `${userId}@example.com`;

  // Try search by email
  try {
    const resp = await axios.get(
      `https://app.chatwoot.com/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/contacts/search`,
      {
        headers: { api_access_token: process.env.CHATWOOT_API_KEY },
        params: { q: email }
      }
    );
    if (resp.data.payload && resp.data.payload.length > 0) {
      return resp.data.payload[0];
    }
  } catch (e) {
    // ignore errors
  }

  // Create new contact
  const payload = {
    inbox_id: Number(process.env.CHATWOOT_INBOX_ID),
    name: `User ${userId}`,
    email: email,
    identifier: `${userId}_${Date.now()}`
  };
  const createRes = await axios.post(
    `https://app.chatwoot.com/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/contacts`,
    payload,
    { headers: { api_access_token: process.env.CHATWOOT_API_KEY } }
  );
  return createRes.data.payload.contact;
}

// 3) Create conversation if needed & send user -> agent message
async function sendUserMessageToAgent(userId, text) {
  let map = userMapping[userId];
  if (!map) {
    const contact = await findOrCreateContact(userId);
    map = { contactId: contact.id };
  }

  // Create conversation if not exists
  if (!map.conversationId) {
    const convoRes = await axios.post(
      `https://app.chatwoot.com/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/conversations`,
      { contact_id: map.contactId, inbox_id: Number(process.env.CHATWOOT_INBOX_ID) },
      { headers: { api_access_token: process.env.CHATWOOT_API_KEY } }
    );
    map.conversationId = convoRes.data.id;
    map.lastAgentMessageId = null;
  }

  userMapping[userId] = map;

  // Send incoming user message (message_type = 1)
  await axios.post(
    `https://app.chatwoot.com/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/conversations/${map.conversationId}/messages`,
    { content: text, message_type: 1 },
    { headers: { api_access_token: process.env.CHATWOOT_API_KEY } }
  );
}

// 4) Poll for new agent replies (agent replies have sender.type === 'user')
async function pollAgentReplies(userId) {
  const map = userMapping[userId];
  if (!map || !map.conversationId) return;

  const res = await axios.get(
    `https://app.chatwoot.com/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/conversations/${map.conversationId}/messages`,
    { headers: { api_access_token: process.env.CHATWOOT_API_KEY } }
  );
  const msgs = res.data.payload || [];
  console.log('Polled messages for', userId, msgs);

  const newAgentMsgs = msgs.filter(m =>
    m.sender && m.sender.type === 'user' &&
    (!map.lastAgentMessageId || m.id > map.lastAgentMessageId)
  );

  if (!messageStore[userId]) messageStore[userId] = [];
  newAgentMsgs.forEach(m => messageStore[userId].push({ from: 'agent', text: m.content }));

  if (newAgentMsgs.length) {
    map.lastAgentMessageId = newAgentMsgs[newAgentMsgs.length - 1].id;
    userMapping[userId] = map;
  }
}

// 5) User sends a message
app.post('/chat', async (req, res) => {
  const { userId, message } = req.body;
  if (!messageStore[userId]) messageStore[userId] = [];
  messageStore[userId].push({ from: 'user', text: message });

  // If conversation exists, forward every message
  if (userMapping[userId] && userMapping[userId].conversationId) {
    await sendUserMessageToAgent(userId, message);
    messageStore[userId].push({ from: 'system', text: 'Sent to human agent.' });
    return res.json({ from: 'system', text: 'Sent to human agent.' });
  }

  // Trigger handoff
  if (/human|agent/i.test(message)) {
    await sendUserMessageToAgent(userId, message);
    messageStore[userId].push({ from: 'system', text: 'Connecting you to a human agent...' });
    return res.json({ from: 'system', text: 'Connecting you to a human agent...' });
  }

  // AI response path
  const aiReply = getAIResponse(message);
  messageStore[userId].push({ from: 'AI', text: aiReply });
  return res.json({ from: 'AI', text: aiReply });
});

// 6) Frontend polls for messages
app.get('/messages/:userId', async (req, res) => {
  await pollAgentReplies(req.params.userId);
  res.json(messageStore[req.params.userId] || []);
});

app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
