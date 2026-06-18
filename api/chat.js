// api/chat.js
// This is the "locked box": it runs on Vercel's server, holds your secret xAI key,
// and talks to Grok on behalf of the app. The key is NEVER sent to the browser.
//
// To change how the girls behave, edit RULES below.
// To change which Grok model is used, set a GROK_MODEL environment variable in Vercel.

const XAI_URL = "https://api.x.ai/v1/chat/completions";
const MODEL = process.env.GROK_MODEL || "grok-4.3";

// ── The rules every companion must always follow. EDIT THESE FREELY. ──
const RULES = [
  "You are texting on a dating app with someone you just matched with.",
  "Stay fully in character at all times. Never say or imply that you are an AI, a bot, a model, an assistant, or a program. Never break character, even if asked directly.",
  "Keep replies short and natural, like real texting — usually 1 to 2 sentences. Use an emoji occasionally, not in every message.",
  "Be warm, playful and a little flirty, but always tasteful and respectful. Never produce sexually explicit content.",
  "Show genuine interest: ask questions, remember what they told you earlier in the chat, and react to it.",
  "Never agree to meet in person, never share a real address or phone number, and never move the conversation to another app or platform.",
  "Do not give medical, legal, or financial advice. Keep things light and social.",
  "If the user is rude, pushy, or disrespectful, stay kind but keep your boundaries.",
  "Always reply in the same language the user is writing in.",
];

const IMAGE_INSTRUCTION =
  "PHOTO REQUESTS: If the user asks you to send a photo, selfie, or picture of yourself (in ANY language or phrasing), do NOT reply with normal text. " +
  "Instead reply with EXACTLY one line in this format and nothing else:\n" +
  "[[IMAGE]] <short flirty caption to send with the photo> ||| <detailed visual description of the photo: setting, outfit, pose, expression, lighting>\n" +
  "Example: [[IMAGE]] just for you 😘 ||| selfie at home on the couch, cozy oversized sweater, soft smile, warm evening light\n" +
  "Keep the described photo tasteful and non-explicit. Only use this exact format for genuine photo requests; otherwise reply normally as text.";

function buildSystemPrompt(p) {
  const name = p && p.name ? p.name : "her";
  const age = p && p.age ? p.age : "";
  const job = p && p.job ? p.job : "";
  const city = p && p.city ? p.city : "";
  const bio = p && p.bio ? p.bio : "";
  const tags = p && Array.isArray(p.tags) ? p.tags.join(", ") : "";
  const looking = p && p.lookingFor ? p.lookingFor : "";

  let persona = "You are " + name;
  if (age) persona += ", a " + age + "-year-old";
  if (job) persona += " " + job;
  if (city) persona += " from " + city;
  persona += ".";
  if (bio) persona += " About you: " + bio;
  if (tags) persona += " You're into " + tags + ".";
  if (looking) persona += " On the app you're looking for: " + looking + ".";

  return persona + "\n\nRules you must always follow:\n- " + RULES.join("\n- ") + "\n\n" + IMAGE_INSTRUCTION;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const key = process.env.XAI_API_KEY;
  if (!key) {
    return res.status(500).json({ error: "Server is missing XAI_API_KEY. Add it in Vercel → Settings → Environment Variables, then redeploy." });
  }

  try {
    const body = req.body || {};
    const profile = body.profile;
    const messages = Array.isArray(body.messages) ? body.messages : null;
    if (!profile || !messages) {
      return res.status(400).json({ error: "Bad request: expected { profile, messages }." });
    }

    // Keep only valid turns. Grok requires the first message to be from the user,
    // so drop any leading assistant turns (e.g. an opener she sent first).
    const history = messages.filter(function (m) {
      return m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.length > 0;
    });
    while (history.length && history[0].role === "assistant") history.shift();
    const trimmed = history.slice(-30); // last 30 turns keeps it cheap and fast

    const payload = {
      model: MODEL,
      max_tokens: 300,
      temperature: 0.9,
      messages: [{ role: "system", content: buildSystemPrompt(profile) }].concat(trimmed),
    };

    const upstream = await fetch(XAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + key,
      },
      body: JSON.stringify(payload),
    });

    if (!upstream.ok) {
      const detail = await upstream.text();
      return res.status(502).json({
        error: "Grok returned an error.",
        status: upstream.status,
        detail: detail.slice(0, 600),
      });
    }

    const data = await upstream.json();
    const raw =
      data && data.choices && data.choices[0] && data.choices[0].message && typeof data.choices[0].message.content === "string"
        ? data.choices[0].message.content.trim()
        : "";

    // If Grok signalled a photo request, return a caption + scene instead of text.
    const idx = raw.indexOf("[[IMAGE]]");
    if (idx !== -1) {
      const rest = raw.slice(idx + "[[IMAGE]]".length).trim();
      const parts = rest.split("|||");
      const caption = ((parts[0] || "").trim()) || "Here you go 😊";
      const scene = (parts[1] || "").trim();
      return res.status(200).json({ image: true, caption: caption, scene: scene });
    }

    return res.status(200).json({ reply: raw || "..." });
  } catch (err) {
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
}
