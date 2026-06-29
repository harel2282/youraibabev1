// api/studio-image.js
// SEPARATE image endpoint used ONLY by the admin Studio page (admin.html).
// It does NOT touch the live chat — the chat keeps using api/image.js unchanged.
//
// Adds, on top of the chat's generator:
//   - optional LLM prompt-writing from a casual request (expand)
//   - up to 3 keyword-triggered extra reference images, described in the prompt
//   - returns the built prompt so the admin can see it
//
// Because generation takes ~19s and Vercel Hobby caps functions at 10s, this is split:
//   POST  { scene, referenceUrl, expand?, extraRefs? } -> { requestId, prompt, scene }
//   GET   ?id=REQUEST_ID                               -> { status, url, ok }
//
// Required env vars in Vercel (already set for the site): WAVESPEED_API_KEY, XAI_API_KEY.

const WAVESPEED_SUBMIT = "https://api.wavespeed.ai/api/v3/bytedance/seedream-v4.5/edit";
const WAVESPEED_RESULT = "https://api.wavespeed.ai/api/v3/predictions/"; // + {id}/result

// Wrap the scene into a high-quality, identity-preserving edit prompt.
// extraRefs: [{ url, label }] — additional reference images (objects/outfits) to incorporate.
function shotPhrase(shot) {
  if (shot === "mirror") return "Framed as a mirror selfie, front facing, phone visible in hand. ";
  if (shot === "selfie") return "Framed as a close, natural front-facing selfie at arm's length. ";
  if (shot === "full")   return "Framed as a full-body shot showing her head to feet. ";
  return "";
}

function buildPrompt(scene, extraRefs, shot) {
  const s = (scene || "").trim();
  const shotNote = shotPhrase(shot);
  let refNote = "";
  if (Array.isArray(extraRefs) && extraRefs.length) {
    const shows = extraRefs.map(function (e, i) {
      return "reference image " + (i + 2) + " shows " + ((e && e.label) ? e.label : "an item");
    });
    const incorporate = extraRefs.map(function (e) {
      return "the " + ((e && e.label) ? e.label : "item");
    });
    refNote = "Additional reference images are provided — " + shows.join("; ") + ". Accurately incorporate " +
      incorporate.join(", ") + " from those reference images into the scene, keeping each looking exactly like its own reference. ";
  }
  return (
    "Keep the exact same woman from the first reference image — identical face, hair, skin tone and body. Do not change her identity. " +
    shotNote +
    (s ? s + " " : "A natural, flattering candid photo of her. ") +
    refNote +
    "Anatomically correct: natural hands with exactly five fingers on each hand, normal proportional limbs, only one person in frame, no duplicated faces or bodies, no warped or distorted features, no extra limbs or fingers. " +
    "Sharp focus, clean realistic detail, natural realistic skin texture. Tasteful, non-explicit."
  );
}

// Analyze the request and rewrite it as a rich, photographic image prompt.
// Returns { ok, scene, error }. ok=false means analysis did NOT run (so the caller can
// warn instead of silently using the raw text). On failure, scene = the original message.
async function analyzeToScene(message) {
  const msg = (message || "").trim();
  if (!msg) return { ok: false, scene: msg, error: "empty message" };
  const xaiKey = process.env.XAI_API_KEY;
  if (!xaiKey) return { ok: false, scene: msg, error: "missing XAI_API_KEY on the server" };
  const model = process.env.STUDIO_MODEL || process.env.GROK_MODEL || "grok-4.3";
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, 8500);
  try {
    const r = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + xaiKey },
      signal: controller.signal,
      body: JSON.stringify({
        model: model,
        reasoning_effort: "none",
        messages: [
          { role: "system", content: "You are an expert prompt engineer for a photorealistic AI image generator that edits a reference photo of one specific woman. Read the user's request — it may be casual, short, vague, or in any language (e.g. Hebrew) — and understand the INTENT, then rewrite it as a single rich, concrete, photographic scene description in ENGLISH. Infer and add the specific realistic detail the request implies: exact setting and background, clothing and styling, pose and body language, facial expression, time of day, lighting, camera framing and overall mood. Keep her as the only person in frame, tasteful and non-explicit. Never copy the user's words verbatim — translate the idea into a vivid visual scene. Do not mention the reference image or the words photo/selfie/picture/send. Output ONLY the final scene description as one vivid paragraph: no preamble, no quotes, no lists, no explanations." },
          { role: "user", content: msg }
        ]
      })
    });
    if (!r.ok) {
      const detail = await r.text();
      return { ok: false, scene: msg, error: "LLM error " + r.status + ": " + detail.slice(0, 160) };
    }
    const j = await r.json();
    const txt = ((j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "").toString().trim();
    if (!txt) return { ok: false, scene: msg, error: "empty LLM response" };
    return { ok: true, scene: txt, error: "" };
  } catch (e) {
    const isAbort = e && (e.name === "AbortError");
    return { ok: false, scene: msg, error: isAbort ? "analysis timed out (try again)" : ("analysis failed: " + String((e && e.message) || e)) };
  } finally {
    clearTimeout(timer);
  }
}

// Anatomy / quality gate — asks a Grok vision model whether the photo has obvious AI defects.
// Returns true if OK. FAILS OPEN. Env: IMAGE_QC=off to disable, GROK_VISION_MODEL to override.
async function verifyAnatomy(imageUrl) {
  if (String(process.env.IMAGE_QC || "on").toLowerCase() === "off") return true;
  const xaiKey = process.env.XAI_API_KEY;
  if (!xaiKey || !imageUrl) return true;
  const model = process.env.GROK_VISION_MODEL || process.env.STUDIO_MODEL || process.env.GROK_MODEL || "grok-4.3";
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, 8000);
  try {
    const r = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + xaiKey },
      signal: controller.signal,
      body: JSON.stringify({
        model: model,
        reasoning_effort: "none",
        messages: [{
          role: "user",
          content: [
            { type: "image_url", image_url: { url: imageUrl, detail: "low" } },
            { type: "text", text: "You are a strict QA checker for AI-generated photos of a single person. Reply with ONLY one word. Say 'BAD' if the image has any clear anatomical defect: more than two hands or arms, extra/missing/fused fingers, extra legs, more than one person, duplicated or merged body parts, or a grossly distorted or melted hand or face. Say 'OK' if the person looks anatomically normal. If you are unsure, say 'OK'." }
          ]
        }]
      })
    });
    if (!r.ok) return true;
    const j = await r.json();
    const txt = ((j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "").toString().toUpperCase();
    return txt.indexOf("BAD") === -1;
  } catch (e) {
    return true;
  } finally {
    clearTimeout(timer);
  }
}

// Validate a "W*H" size string: integers, 256..4096 each, aspect ratio within 1:16..16:1.
function sanitizeSize(raw) {
  if (typeof raw !== "string") return "";
  const m = raw.replace(/\s+/g, "").match(/^(\d{2,4})[*x](\d{2,4})$/i);
  if (!m) return "";
  let w = parseInt(m[1], 10), h = parseInt(m[2], 10);
  if (!(w >= 256 && w <= 4096 && h >= 256 && h <= 4096)) return "";
  const ratio = w / h;
  if (ratio < (1 / 16) || ratio > 16) return "";
  return w + "*" + h;
}

export default async function handler(req, res) {
  const key = process.env.WAVESPEED_API_KEY;
  if (!key) {
    return res.status(500).json({ error: "Server is missing WAVESPEED_API_KEY. Add it in Vercel → Settings → Environment Variables, then redeploy." });
  }

  try {
    // ---- POLL: GET /api/studio-image?id=REQUEST_ID ----
    if (req.method === "GET") {
      const id = req.query && req.query.id;
      if (!id) return res.status(400).json({ error: "Missing id" });
      const r = await fetch(WAVESPEED_RESULT + encodeURIComponent(id) + "/result", {
        headers: { Authorization: "Bearer " + key },
      });
      if (!r.ok) {
        const detail = await r.text();
        return res.status(502).json({ error: "Poll failed", status: r.status, detail: detail.slice(0, 400) });
      }
      const json = await r.json();
      const data = json && json.data ? json.data : json;
      const status = data && data.status ? data.status : "unknown";
      let url = null;
      if (data && Array.isArray(data.outputs) && data.outputs.length) url = data.outputs[0];
      if (status === "failed") {
        return res.status(200).json({ status: "failed", error: (data && data.error) || "Generation failed" });
      }
      if (status === "completed" && url) {
        const ok = await verifyAnatomy(url);
        return res.status(200).json({ status: status, url: url, ok: ok });
      }
      return res.status(200).json({ status: status, url: url });
    }

    // ---- SUBMIT: POST { scene, referenceUrl, expand?, extraRefs? } ----
    if (req.method === "POST") {
      const body = req.body || {};
      const refUrl = (typeof body.referenceUrl === "string" && body.referenceUrl) ? body.referenceUrl : "";
      if (!refUrl) return res.status(400).json({ error: "Missing referenceUrl — upload a main reference image first." });

      // Always analyze the request into a rich prompt (this is the whole point of the studio).
      const analysis = await analyzeToScene(body.scene);
      const scene = analysis.scene;

      // Up to 3 keyword-triggered extra reference images.
      let extraRefs = [];
      if (Array.isArray(body.extraRefs)) {
        extraRefs = body.extraRefs
          .filter(function (e) { return e && typeof e.url === "string" && e.url; })
          .slice(0, 3)
          .map(function (e) { return { url: e.url, label: (typeof e.label === "string" ? e.label : "") }; });
      }

      const shot = (typeof body.shot === "string") ? body.shot : "";
      const finalPrompt = buildPrompt(scene, extraRefs, shot);
      const images = [refUrl].concat(extraRefs.map(function (e) { return e.url; }));

      const payload = {
        prompt: finalPrompt,
        images: images,
        enable_base64_output: false,
        enable_sync_mode: false,
      };
      // Optional output size "W*H" (Seedream accepts e.g. "1024*1024"; aspect 1:16..16:1, up to 4096).
      const size = sanitizeSize(body.size);
      if (size) payload.size = size;

      const r = await fetch(WAVESPEED_SUBMIT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const detail = await r.text();
        return res.status(502).json({ error: "Submit failed", status: r.status, detail: detail.slice(0, 400) });
      }
      const json = await r.json();
      const data = json && json.data ? json.data : json;
      const requestId = data && (data.id || data.request_id || data.requestId);
      if (!requestId) return res.status(502).json({ error: "No request id returned", detail: JSON.stringify(json).slice(0, 400) });
      return res.status(200).json({ requestId: requestId, prompt: finalPrompt, scene: scene, analyzed: analysis.ok, analyzeError: analysis.error });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
