// server/index.js
require("dotenv").config();
const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory stores
let messageStore = {};    // { [userId]: [{ from, text }] }
let userMapping  = {};    // { [userId]: { contactId, conversationId, lastAgentMessageId } }
let agentNameMapping = {}; // { [userId]: agentName }

app.use(cors());
app.use(bodyParser.json());
app.use(express.static("public"));

// 1) Simulated AI response
function getAIResponse(msg) {
  return `AI: I heard you say "${msg}"`;
}

// 2) Find-or-create Chatwoot contact
async function findOrCreateContact(userId) {
  const email = `${userId}@example.com`;
  try {
    let resp = await axios.get(
      `https://app.chatwoot.com/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/contacts/search`,
      {
        headers: { api_access_token: process.env.CHATWOOT_API_KEY },
        params: { q: email }
      }
    );
    if (resp.data.payload?.length) {
      return resp.data.payload[0];
    }
  } catch (e) {/* ignore */}
  // Otherwise create new
  const payload = {
    inbox_id: Number(process.env.CHATWOOT_INBOX_ID),
    name: `User ${userId}`,
    email,
    identifier: `${userId}_${Date.now()}`
  };
  let createRes = await axios.post(
    `https://app.chatwoot.com/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/contacts`,
    payload,
    { headers: { api_access_token: process.env.CHATWOOT_API_KEY } }
  );
  return createRes.data.payload.contact;
}

// 3) Create conversation & send user→agent
async function sendUserMessageToAgent(userId, text) {
  let map = userMapping[userId];
  if (!map) {
    const contact = await findOrCreateContact(userId);
    map = { contactId: contact.id };
  }
  if (!map.conversationId) {
    let convoRes = await axios.post(
      `https://app.chatwoot.com/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/conversations`,
      {
        contact_id: map.contactId,
        inbox_id: Number(process.env.CHATWOOT_INBOX_ID)
      },
      { headers: { api_access_token: process.env.CHATWOOT_API_KEY } }
    );
    // ⚠️ use payload.id here
    map.conversationId = convoRes.data.payload?.id || convoRes.data.id;
    if (!map.conversationId) {
      throw new Error('Could not find conversationId in Chatwoot response: ' + JSON.stringify(convoRes.data));
      }
    map.lastAgentMessageId = null;
  }
  userMapping[userId] = map;
  // Send incoming user message
  await axios.post(
    `https://app.chatwoot.com/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/conversations/${map.conversationId}/messages`,
    { content: text, message_type: 1 },  // 1 = incoming
    { headers: { api_access_token: process.env.CHATWOOT_API_KEY } }
  );
}

// 4) Poll for new agent replies (sender.type==='user')
//    Announce agent name if it changes or first appears
async function pollAgentReplies(userId) {
  let map = userMapping[userId];
  if (!map?.conversationId) return;
  let res = await axios.get(
    `https://app.chatwoot.com/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/conversations/${map.conversationId}/messages`,
    { headers: { api_access_token: process.env.CHATWOOT_API_KEY } }
  );
  let msgs = res.data.payload || [];
  // Only new agent messages
  let newAgent = msgs.filter(m =>
    m.sender?.type === "user" &&
    (!map.lastAgentMessageId || m.id > map.lastAgentMessageId)
  );
  if (!messageStore[userId]) messageStore[userId] = [];

  newAgent.forEach(m => {
    const agentName = m.sender.name || "Agent";
    if (agentNameMapping[userId] !== agentName) {
      messageStore[userId].push({
        from: "system",
        text: `Agent ${agentName} has joined the chat.`
      });
      agentNameMapping[userId] = agentName;
    }
    messageStore[userId].push({ from: "agent", text: m.content });
  });

  if (newAgent.length) {
    map.lastAgentMessageId = newAgent[newAgent.length - 1].id;
    userMapping[userId] = map;
  }
}

// 5) Poll for conversation status; if resolved, hand back to AI
async function pollConversationStatus(userId) {
  let map = userMapping[userId];
  if (!map?.conversationId) return;
  try {
    let res = await axios.get(
      `https://app.chatwoot.com/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/conversations/${map.conversationId}`,
      { headers: { api_access_token: process.env.CHATWOOT_API_KEY } }
    );
    let status = res.data.payload.status;
    if (status === "resolved") {
      messageStore[userId] = messageStore[userId] || [];
      messageStore[userId].push({
        from: "system",
        text: "The Agent marked this conversation as resolved; we are directing you back to AI Powered Agent."
      });
      delete userMapping[userId];
      delete agentNameMapping[userId];
    }
    } catch (e) {
      console.warn("Error polling conversation status for", userId, e.response?.data || e.message);
    }
}

// 6) User sends a message (ALWAYS check live status)
app.post("/chat", async (req, res) => {
  const { userId, message } = req.body;
  messageStore[userId] = messageStore[userId] || [];
  messageStore[userId].push({ from: "user", text: message });

  // Check if conversation exists and its status
  let status = null;
  let convId = userMapping[userId]?.conversationId;
  if (convId) {
    try {
      const convRes = await axios.get(
        `https://app.chatwoot.com/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/conversations/${convId}`,
        { headers: { api_access_token: process.env.CHATWOOT_API_KEY } }
      );
      status = convRes.data.payload?.status || convRes.data.status;
    } catch (e) {
      status = null;
    }
  }

  // If conversation exists but is resolved, clear mapping
  if (convId && status === "resolved") {
    messageStore[userId].push({
      from: "system",
      text: "The Agent marked this conversation as resolved; we are directing you back to AI Powered Agent."
    });
    delete userMapping[userId];
    delete agentNameMapping[userId];
  }

  // If still an active human session, forward the message
  if (userMapping[userId]?.conversationId) {
    await sendUserMessageToAgent(userId, message);
    messageStore[userId].push({ from: "system", text: "Sent to human agent." });
    return res.json({ from: "system", text: "Sent to human agent." });
  }

  // Initial handoff trigger
  if (/human|agent/i.test(message)) {
    await sendUserMessageToAgent(userId, message);
    messageStore[userId].push({ from: "system", text: "Connecting you to a human agent..." });
    return res.json({ from: "system", text: "Connecting you to a human agent..." });
  }

  // AI response path
  let aiReply = getAIResponse(message);
  messageStore[userId].push({ from: "AI", text: aiReply });
  return res.json({ from: "AI", text: aiReply });
});

// 7) Frontend polls for messages + status
app.get("/messages/:userId", async (req, res) => {
  let userId = req.params.userId;
  await pollAgentReplies(userId);
  await pollConversationStatus(userId);
  res.json(messageStore[userId] || []);
});

app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
