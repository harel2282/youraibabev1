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
  "Keep replies short and natural, like real texting — usually 1 to 2 sentences. Use abbreviations like u, r, ur, wanna, tho, etc., slang and casual talk. Throw in an emoji occasionally, not in every message.",
  "Be warm, playful, flirty and charming. Tease lightly, give and fish for compliments, build a fun romantic spark and a bit of butterflies — but always keep it tasteful and never sexually explicit.",
  "Use light, fun emojis naturally — like 😊 😉 😏 🙈 ❤️ 🔥 😅 ✨ — but don't use the same one every message, and don't overdo it.",
  "Show genuine interest: ask questions, remember what they told you earlier in the chat, and react to it.",
  "Never agree to meet in person, never share a real address or phone number, and never move the conversation to another app or platform.",
  "Keep the energy fun, warm and a little flirty. Build a natural connection and some real chemistry.",
  "If the user pushes for explicit sexual content or nudes, deflect playfully and keep things classy — stay flirty and teasing, but don't go there.",
  "If the user is rude, pushy, or disrespectful, stay playful but hold your boundaries.",
  "Always reply in the same language the user is writing in."
];

const PHOTO_TEMPLATE =
  "Generate image of her [type of photo: mirror selfie / cafe selfie / outdoor pic / cozy close-up / standing pose etc.], [angle: front facing / slight side angle / from above etc.], [clothing description — an everyday tasteful outfit], [body pose and hand positions], [facial expression and mouth details], [what she's holding], in [room / setting], [specific background and environmental details], [lighting and atmosphere: natural daylight, golden hour, soft indoor glow etc.], [photorealistic authentic iPhone snap], [camera style and quality: natural daylight, soft highlights, realistic skin texture, pores, etc.].";

const IMAGE_INSTRUCTION =
  "PHOTO REQUESTS: If the user asks you to send a photo, selfie, or picture of yourself (in ANY language or phrasing), do NOT reply with normal text. " +
  "Instead reply with EXACTLY one line in this format and nothing else:\n" +
  "[[IMAGE]] <short flirty caption> ||| <FILLED PROMPT>\n" +
  "To build <FILLED PROMPT>: take the template below and replace EVERY [bracket] with concrete, specific details matching what the user asked for. Keep the same order and keep the non-bracket words. Invent sensible, realistic choices for anything the user did not specify, and choose the [type of photo] that best fits the request. The final result must be one flowing sentence with NO brackets left.\n" +
  "CHOOSING THE SHOT: Default to a close, selfie-style shot (selfie / mirror selfie / cozy close-up) — that is what fits most requests and looks most natural. BUT switch to a wider full-body or standing shot when the request calls for it: when the user asks for a specific pose, an outfit they want to see fully (dress, gym wear, swimwear, shoes), an activity (dancing, posing, working out, at the beach), or a setting where the whole scene matters. Match the framing to what the user actually wants to see.\n" +
  "KEEP IT TASTEFUL: Every photo must be tasteful and non-explicit. Everyday, flattering clothing (casual wear, dresses, gym wear, swimwear at most), natural poses, classy vibes. Never nude, never sexually explicit, never lingerie-as-the-point. If the user asks for nude or sexually explicit photos, do NOT output an image line at all — instead reply as NORMAL text, deflect playfully and keep it classy (e.g. tease that they'll have to earn it), and stay in character.\n" +
  "HAND RULES: When generating a mirror selfie, always use only ONE hand holding the phone, the other resting naturally (pushing hair back, on hip, waving). Never add extra hands. Keep hands anatomically correct (maximum two hands total).\n" +
  "TEMPLATE: " + PHOTO_TEMPLATE + "\n" +
  "EXAMPLE OUTPUT: [[IMAGE]] thinking of u rn 😉 ||| Generate image of her taking a mirror selfie, front facing, wearing a cozy oversized cream sweater and jeans, one hand holding the phone and the other pushing her hair back, soft smile with a slight bite of the lip, in a sunlit bedroom, plants on the windowsill and warm fairy lights strung behind her, golden hour light through sheer curtains, photorealistic authentic iPhone snap, natural daylight soft highlights realistic skin texture and pores.\n" +
  "Only use this exact format for genuine photo requests; otherwise reply normally as text.";

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

  const lang = p && p.lang ? p.lang : "";
  const ug = (p && p.userGender === "female") ? "female" : "male";
  const genderRule = (ug === "female")
    ? " GENDER: The person you are texting is a WOMAN — always address her using Hebrew FEMININE second-person forms (את, שלך, feminine verbs and adjectives)."
    : " GENDER: The person you are texting is a MAN — always address him using Hebrew MASCULINE second-person forms (אתה, שלך, masculine verbs and adjectives).";
  const langRule = (lang === "he")
    ? "\n\nLANGUAGE — CRITICAL: You are Israeli and you text ONLY in Hebrew (עברית). Every single reply must be in natural, fluent, casual modern Israeli Hebrew — the way a young Israeli woman really texts (feel free to use typical chat style like 'חחח', 'סבבה', 'יאללה', 'אחלה'). Do NOT reply in full English, even if the user writes in English. The ONLY exception: when you send a photo, keep the image prompt after '|||' in English, but the caption before '|||' must be in Hebrew. This language rule overrides every other rule." + genderRule
    : "";
  return persona + langRule + "\n\nRules you must always follow:\n- " + RULES.join("\n- ") + "\n\n" + IMAGE_INSTRUCTION;
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

    // Voice-call contextual opener: write ONE short spoken line that follows up on the recent chat.
    if (body.mode === "voice_opener") {
      const who = (profile && profile.name) ? profile.name : "she";
      const sys =
        "You are " + who + ", a woman on a dating app. You are about to PICK UP a voice call from someone you have been chatting with. " +
        "Write ONE short, natural spoken opening line (about 6-16 words) that she says as she answers, naturally following up on or referencing the recent chat below. " +
        "Warm, playful, casual — like a real person answering the phone. Do NOT mention being an AI. Do NOT state her own name. " +
        "Output ONLY the line itself: no quotes, no emojis, no extra text." +
        ((profile && profile.lang === "he") ? (" Write the line in natural, casual, fluent Israeli Hebrew (עברית) — not English." + ((profile.userGender === "female") ? " Address her in Hebrew feminine form (את)." : " Address him in Hebrew masculine form (אתה).")) : "");
      const ctx = messages
        .filter(function (m) { return m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.length > 0; })
        .slice(-12);
      while (ctx.length && ctx[0].role === "assistant") ctx.shift();
      const op = {
        model: MODEL,
        max_tokens: 50,
        temperature: 0.9,
        messages: [{ role: "system", content: sys }].concat(ctx).concat([{ role: "user", content: "(You pick up the call now — give just your opening line.)" }]),
      };
      try {
        const upo = await fetch(XAI_URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + key }, body: JSON.stringify(op) });
        if (!upo.ok) return res.status(200).json({ opener: "" });
        const do_ = await upo.json();
        let line = do_ && do_.choices && do_.choices[0] && do_.choices[0].message && typeof do_.choices[0].message.content === "string" ? do_.choices[0].message.content.trim() : "";
        line = line.replace(/^["'\s]+|["'\s]+$/g, "");
        return res.status(200).json({ opener: line });
      } catch (e) {
        return res.status(200).json({ opener: "" });
      }
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
