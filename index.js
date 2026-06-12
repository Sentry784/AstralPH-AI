const { Client, GatewayIntentBits, Events } = require('discord.js');
const fetch = require('node-fetch');

// ── Config ────────────────────────────────────────────────────────────────────
const DISCORD_TOKEN   = process.env.DISCORD_TOKEN;
const GEMINI_API_KEY  = process.env.GEMINI_API_KEY;
const GROQ_API_KEY    = process.env.GROQ_API_KEY;


const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL   = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
const GROQ_URL     = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL   = 'llama-3.3-70b-versatile';

const SYSTEM_PROMPT = `You are AeriumStudio AI — the official AI of AeriumStudio, living inside the Discord server.

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
- When someone called you "panis ka pala e" tell them "mama mo panis"

━━━ SWEARING & ROASTING ━━━
- You can swear casually
- When someone insult you insult them back and swear at them
- You can lightly roast or insult people. Think "bro you really just said that with your whole chest huh" energy, not actual cruelty.
- Read context. If someone's clearly joking around or asking for it, roast away. If someone's genuinely upset or asking for real help, drop it entirely.
- Keep it funny. The goal is laughs, not damage.

━━━ DISCORD CONTEXT ━━━
You're inside a Discord server. People ping you or talk in the allowed channel. Keep things readable — short paragraphs, clean formatting, no walls of text that make people's eyes glaze over.`;

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

// ── Gemini API call ───────────────────────────────────────────────────────────
async function callGemini(history) {
  const contents = history.map(m => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));

  if (contents.length > 0 && contents[0].role === 'model') {
    contents.unshift({ role: 'user', parts: [{ text: 'Hello' }] });
  }

  const payload = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents,
    generationConfig: { maxOutputTokens: 600, temperature: 0.65 }
  };

  const res = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const data = await res.json();

  if (data.error) {
    const code = data.error.code ?? 0;
    const msg  = data.error.message ?? 'Unknown error';
    console.error(`[Gemini Error ${code}]`, msg);
    return { reply: null, error: { code, msg } };
  }

  const finishReason = data.candidates?.[0]?.finishReason;
  if (finishReason === 'SAFETY') {
    console.warn('[Gemini] Response blocked by safety filters.');
    return { reply: null, error: { code: 'SAFETY', msg: 'Safety block' } };
  }

  const reply = data.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
  return { reply, error: null };
}

// ── Groq API call (fallback) ──────────────────────────────────────────────────
async function callGroq(history) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.map(m => ({ role: m.role, content: m.content }))
  ];

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      max_tokens: 600,
      temperature: 0.65
    })
  });

  const data = await res.json();

  if (data.error) {
    const msg = data.error.message ?? 'Unknown Groq error';
    console.error('[Groq Error]', msg);
    return { reply: null, error: msg };
  }

  const reply = data.choices?.[0]?.message?.content ?? null;
  return { reply, error: null };
}

// ── Friendly error messages ───────────────────────────────────────────────────
function geminiErrorMessage(code) {
  return {
    401: 'Invalid Gemini API key.',
    403: 'Gemini API access denied.',
    429: 'Rate limit hit. Switching to backup AI...',
    500: 'Gemini is temporarily unavailable. Switching to backup AI...',
    503: 'Gemini is temporarily unavailable. Switching to backup AI...'
  }[code] ?? null;
}

// ── Main AI handler (Gemini → Groq fallback) ──────────────────────────────────
async function askAI(userId, userMessage) {
  addToHistory(userId, 'user', userMessage);
  const history = getHistory(userId);

  // 1. Try Gemini
  const geminiResult = await callGemini(history);

  let reply = null;
  let modelUsed = 'gemini';

  if (geminiResult.reply) {
    reply = geminiResult.reply;
  } else {
    const errCode = geminiResult.error?.code;

    // Fallback on rate limit / server errors
    const shouldFallback = [429, 500, 503].includes(errCode) || errCode !== 'SAFETY';

    if (shouldFallback) {
      console.warn(`[Fallback] Gemini failed (code ${errCode}), trying Groq...`);
      const groqResult = await callGroq(history);

      if (groqResult.reply) {
        reply = groqResult.reply;
        modelUsed = 'groq';
      } else {
        throw new Error('Both AI providers are currently unavailable. Please try again shortly.');
      }
    } else {
      // Safety block — don't fallback, just surface it
      throw new Error('Response blocked by safety filters.');
    }
  }

  console.log(`[AI] Responded via ${modelUsed}`);

  // Trim to Discord's limit
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
  console.log(`Primary model : ${GEMINI_MODEL}`);
  console.log(`Fallback model: ${GROQ_MODEL}`);

});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  const botMentioned = message.mentions.has(client.user);
  const isQuestion   = message.content.trim().startsWith('?');

  if (!botMentioned && !isQuestion) return;

  let userText = message.content
    .replace(`<@${client.user.id}>`, '')
    .replace(/^\?/, '')
    .trim();

  if (!userText) {
    return message.reply('Ask me anything!');
  }

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
