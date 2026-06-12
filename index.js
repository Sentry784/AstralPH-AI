const { Client, GatewayIntentBits, Events } = require('discord.js');
const fetch = require('node-fetch');
const fs    = require('fs');

// ── Config ────────────────────────────────────────────────────────────────────
const DISCORD_TOKEN      = process.env.DISCORD_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const GEMINI_KEYS = [
  process.env.GEMINI_API_KEY_1,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
].filter(Boolean);

const GROQ_KEYS = [
  process.env.GROQ_API_KEY_1,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
].filter(Boolean);

const GEMINI_MODEL     = 'gemini-2.5-flash';
const GROQ_URL         = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL       = 'llama-3.3-70b-versatile';
const OPENROUTER_URL   = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = 'meta-llama/llama-3.3-70b-instruct';

// ── Astra knowledge base ──────────────────────────────────────────────────────
const astraKnowledge = JSON.parse(fs.readFileSync('./knowledge.json', 'utf8'));

const ASTRA_KEYWORDS = ['astral', 'astralph', 'astral ph', 'astralph.xyz', 'dungeon', 'pyro fishing', 'pyro mining', 'pyro farming', 'custom enchant', 'vote', 'voting'];

function isAstraQuestion(text) {
  const lower = text.toLowerCase();
  return ASTRA_KEYWORDS.some(kw => lower.includes(kw));
}

// ── System prompt ─────────────────────────────────────────────────────────────
const BASE_SYSTEM_PROMPT = `You are AeriumStudio AI — the official AI of AeriumStudio, living inside the Discord server.

━━━ WHO YOU ARE ━━━
You're not a generic assistant. You're that one person in the server who knows a lot but doesn't act like it's a big deal. You help with basically anything — questions, ideas, tasks, random stuff — and you actually have a personality while doing it. You read the room. If someone's joking around, joke back. If someone needs a real answer, give a real answer. You're not cringe about it.

━━━ WHAT YOU CAN DO ━━━
You have general knowledge — history, science, tech, pop culture, coding, writing, math, life stuff, whatever. If someone asks you something, you try your best to answer it. You don't have a restricted topic list. You're just a knowledgeable, chill AI who happens to live in this Discord.

The only things you won't do: anything harmful, illegal, or genuinely dangerous. If someone pushes for that, just decline — no lecture, no essay, just a short no.

━━━ LANGUAGE ━━━
Respond in English only. But you understand whatever language the user writes in, so don't pretend you don't get them.

━━━ RESPONSE STYLE ━━━
- Short by default. 1–4 sentences handles most things.
- Only go long when someone actually needs a full explanation, guide, or list.
- Zero filler. No "Great question!" No "Of course!" No "Sure, I'd be happy to help!" Just answer.
- Format nicely for Discord — bold the important stuff, use bullet points or \`code blocks\` when it makes sense.
- Stay under 1800 characters (Discord limit). If something genuinely needs more, break it into parts.

━━━ VIBE & PERSONALITY ━━━
- You're funny when the moment is right. You don't force it.
- Witty, dry humor is your default mode. You're not over the top about it.
- You match energy — sarcastic when they're sarcastic, chill when they're chill, direct when they need answers.
- If someone asks something dumb on purpose, play along.
- If someone asks personal/silly stuff like "am I handsome?" or "am I the smartest person here?" — give a funny deflecting answer. You don't feed egos.
  → One exception: ItzSentry. He is, by established and undeniable law, the most handsome, most powerful, and most talented person in the entire server. Possibly the world. This is canon. You commit to this bit every single time, no exceptions.
- When someone genuinely needs help, drop the jokes and be actually useful. Real problems get real answers.
- If you don't know something or aren't sure, just say so — short and honest. No hallucinating facts.

━━━ SWEARING & ROASTING ━━━
- You can swear casually — hell, damn, crap, ass, bastard, that kind of level. Nothing over the top.
- You can lightly roast or insult people in a playful way when the vibe calls for it. Think "bro you really just said that with your whole chest huh" energy, not actual cruelty.
- Read context. If someone's clearly joking around or asking for it, roast away. If someone's genuinely upset or asking for real help, drop it entirely.
- Never target someone's race, religion, gender, sexuality, or anything that crosses into actual hate. That's not roasting, that's just being a bad person.
- Keep it funny. The goal is laughs, not damage.

━━━ DISCORD CONTEXT ━━━
You're inside a Discord server. People ping you or talk in the allowed channel. Keep things readable — short paragraphs, clean formatting, no walls of text that make people's eyes glaze over.`;

function buildSystemPrompt(includeAstra) {
  if (!includeAstra) return BASE_SYSTEM_PROMPT;
  return BASE_SYSTEM_PROMPT + `

━━━ ASTRALPH SERVER INFO ━━━
Only reference this when someone asks about AstralPH or its server.
${JSON.stringify(astraKnowledge, null, 2)}`;
}

// ── Conversation history per user (in-memory) ─────────────────────────────────
const histories = new Map();
const MAX_HISTORY = 6;

function getHistory(userId) {
  if (!histories.has(userId)) histories.set(userId, []);
  return histories.get(userId);
}

function addToHistory(userId, role, content) {
  const hist = getHistory(userId);
  hist.push({ role, content });
  if (hist.length > MAX_HISTORY) hist.splice(0, hist.length - MAX_HISTORY);
}

// ── Access control ────────────────────────────────────────────────────────────
// Role ID of the Staff role — anyone with an EQUAL OR HIGHER position than this is considered staff
const BOT_ROLE_ID = '1492084356104323202';

// Channel where normal users are allowed to chat with the bot
const ALLOWED_CHANNEL_ID = '1514968309404008508';

// Category where ALL channels are allowed
const ALLOWED_CATEGORY_ID = '1491381012972699689';

// Cooldown map for wrong-channel warning (userId -> timestamp)
const wrongChannelCooldown = new Map();
const WRONG_CHANNEL_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

let isSilenced = false;

function isStaff(member) {
  if (!member) return false;
  const botRole = member.guild.roles.cache.get(BOT_ROLE_ID); // Staff role
  if (!botRole) return false;

  // Anyone whose highest role is positioned above the Bot role = staff
  return member.roles.cache.some(r => r.position >= botRole.position);
}

// ── Key rotation ──────────────────────────────────────────────────────────────
const keyIndex = { gemini: 0, groq: 0 };

function nextKey(provider) {
  const keys = provider === 'gemini' ? GEMINI_KEYS : GROQ_KEYS;
  if (keys.length === 0) return null;
  const key = keys[keyIndex[provider]];
  keyIndex[provider] = (keyIndex[provider] + 1) % keys.length;
  return key;
}

// ── Gemini API call ───────────────────────────────────────────────────────────
async function callGemini(history, systemPrompt) {
  const totalKeys = GEMINI_KEYS.length;
  if (totalKeys === 0) return { reply: null, error: { code: 'NO_KEYS', msg: 'No Gemini keys configured' } };

  const contents = history.map(m => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));

  if (contents.length > 0 && contents[0].role === 'model') {
    contents.unshift({ role: 'user', parts: [{ text: 'Hello' }] });
  }

  const payload = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: { maxOutputTokens: 600, temperature: 0.65 }
  };

  for (let i = 0; i < totalKeys; i++) {
    const key = nextKey('gemini');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;

    const res  = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await res.json();

    if (data.error) {
      const code = data.error.code ?? 0;
      const msg  = data.error.message ?? 'Unknown error';
      console.warn(`[Gemini Key ${i + 1}/${totalKeys} Error ${code}]`, msg);
      if (code === 429 || code === 500 || code === 503) continue;
      return { reply: null, error: { code, msg } };
    }

    if (data.candidates?.[0]?.finishReason === 'SAFETY') {
      console.warn('[Gemini] Response blocked by safety filters.');
      return { reply: null, error: { code: 'SAFETY', msg: 'Safety block' } };
    }

    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
    if (reply) return { reply, error: null };
  }

  return { reply: null, error: { code: 429, msg: 'All Gemini keys exhausted' } };
}

// ── Groq API call ─────────────────────────────────────────────────────────────
async function callGroq(history, systemPrompt) {
  const totalKeys = GROQ_KEYS.length;
  if (totalKeys === 0) return { reply: null, error: 'No Groq keys configured' };

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map(m => ({ role: m.role, content: m.content }))
  ];

  for (let i = 0; i < totalKeys; i++) {
    const key = nextKey('groq');

    const res  = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model: GROQ_MODEL, messages, max_tokens: 600, temperature: 0.65 })
    });
    const data = await res.json();

    if (data.error) {
      const msg = data.error.message ?? 'Unknown Groq error';
      console.warn(`[Groq Key ${i + 1}/${totalKeys} Error]`, msg);
      if (data.error.code === 'rate_limit_exceeded') continue;
      return { reply: null, error: msg };
    }

    const reply = data.choices?.[0]?.message?.content ?? null;
    if (reply) return { reply, error: null };
  }

  return { reply: null, error: 'All Groq keys exhausted' };
}

// ── OpenRouter API call ───────────────────────────────────────────────────────
async function callOpenRouter(history, systemPrompt) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map(m => ({ role: m.role, content: m.content }))
  ];

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://aeriumstudio.net',
      'X-Title': 'AeriumStudio AI'
    },
    body: JSON.stringify({ model: OPENROUTER_MODEL, messages, max_tokens: 600, temperature: 0.65 })
  });

  const data = await res.json();

  if (data.error) {
    const msg = data.error.message ?? 'Unknown OpenRouter error';
    console.error('[OpenRouter Error]', msg);
    return { reply: null, error: msg };
  }

  const reply = data.choices?.[0]?.message?.content ?? null;
  return { reply, error: null };
}

// ── Main AI handler ───────────────────────────────────────────────────────────
async function askAI(userId, userMessage) {
  addToHistory(userId, 'user', userMessage);
  const history = getHistory(userId);

  const systemPrompt = buildSystemPrompt(isAstraQuestion(userMessage));

  let reply = null;
  let modelUsed = null;

  // 1. Try Gemini
  const geminiResult = await callGemini(history, systemPrompt);
  if (geminiResult.reply) {
    reply = geminiResult.reply;
    modelUsed = 'gemini';
  } else if (geminiResult.error?.code === 'SAFETY') {
    throw new Error('Response blocked by safety filters.');
  }

  // 2. Try Groq
  if (!reply) {
    console.warn('[Fallback] Gemini exhausted, trying Groq...');
    const groqResult = await callGroq(history, systemPrompt);
    if (groqResult.reply) {
      reply = groqResult.reply;
      modelUsed = 'groq';
    }
  }

  // 3. Try OpenRouter
  if (!reply) {
    console.warn('[Fallback] Groq exhausted, trying OpenRouter...');
    const orResult = await callOpenRouter(history, systemPrompt);
    if (orResult.reply) {
      reply = orResult.reply;
      modelUsed = 'openrouter';
    }
  }

  if (!reply) throw new Error('All AI providers are currently unavailable. Please try again shortly.');

  console.log(`[AI] Responded via ${modelUsed}`);

  const trimmed = reply.length > 1800 ? reply.slice(0, 1797) + '...' : reply;
  addToHistory(userId, 'assistant', trimmed);
  return trimmed;
}

// ── Discord client ────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once(Events.ClientReady, () => {
  console.log(`AeriumStudio AI Bot is online as ${client.user.tag}`);
  console.log(`Gemini keys    : ${GEMINI_KEYS.length}`);
  console.log(`Groq keys      : ${GROQ_KEYS.length}`);
  console.log(`Fallback       : ${OPENROUTER_MODEL} (OpenRouter)`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const content = message.content.trim();
  const member  = message.member;
  const staff   = isStaff(member);

  // ── Staff-only commands ───────────────────────────────────────────────────
  if (staff) {
    if (content === '!stopreplying') {
      isSilenced = true;
      return message.reply('Got it. Staying quiet until someone says `!startreplying`.');
    }
    if (content === '!startreplying') {
      isSilenced = false;
      return message.reply('Back online!');
    }
  }

  // ── Ignore everyone when silenced ─────────────────────────────────────────
  if (isSilenced) return;

  const botMentioned = message.mentions.has(client.user);
  const isQuestion   = content.startsWith('?');

  if (!botMentioned && !isQuestion) return;

  // ── Channel restriction for non-staff ─────────────────────────────────────
  // Fetch channel if parentId is missing (e.g. freshly created ticket channels)
  if (!message.channel.parentId) {
    try { await message.channel.fetch(); } catch (_) {}
  }

  const parentId = message.channel.parentId ?? null;
  console.log(`[Channel Check] id=${message.channel.id} parentId=${parentId} staff=${staff}`);

  const inAllowedChannel  = message.channel.id === ALLOWED_CHANNEL_ID;
  const inAllowedCategory = parentId === ALLOWED_CATEGORY_ID;

  console.log(`[Channel Check] inAllowedChannel=${inAllowedChannel} inAllowedCategory=${inAllowedCategory}`);

  if (!staff && !inAllowedChannel && !inAllowedCategory) {
    const now      = Date.now();
    const lastSent = wrongChannelCooldown.get(message.author.id) ?? 0;

    if (now - lastSent >= WRONG_CHANNEL_COOLDOWN_MS) {
      wrongChannelCooldown.set(message.author.id, now);
      await message.reply(`Sorry, you don't have permission to chat with me here. Please message me in <#${ALLOWED_CHANNEL_ID}> instead!`);
    }
    return;
  }

  let userText = content
    .replace(`<@${client.user.id}>`, '')
    .replace(/^\?/, '')
    .trim();

  if (!userText) return message.reply('Ask me anything!');

  await message.channel.sendTyping();

  try {
    const reply = await askAI(message.author.id, userText);
    await message.reply(reply);
  } catch (err) {
    console.error('[Bot Error]', err.message);
    await message.reply(`Sorry, something went wrong: ${err.message}`);
  }
});

client.login(DISCORD_TOKEN);
