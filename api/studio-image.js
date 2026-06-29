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
function buildPrompt(scene, extraRefs) {
  const s = (scene || "").trim();
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
    (s ? s + " " : "A natural, flattering candid photo of her. ") +
    refNote +
    "Anatomically correct: natural hands with exactly five fingers on each hand, normal proportional limbs, only one person in frame, no duplicated faces or bodies, no warped or distorted features, no extra limbs or fingers. " +
    "Sharp focus, clean realistic detail, natural realistic skin texture."
  );
}

// Optional: turn a casual request into a vivid image scene (like the chat's LLM does).
// FAILS SAFE: on missing key / timeout / error, returns the original message.
async function expandScene(message) {
  const msg = (message || "").trim();
  if (!msg) return msg;
  const xaiKey = process.env.XAI_API_KEY;
  if (!xaiKey) return msg;
  const model = process.env.GROK_MODEL || "grok-4.3";
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, 7000);
  try {
    const r = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + xaiKey },
      signal: controller.signal,
      body: JSON.stringify({
        model: model,
        messages: [
          { role: "system", content: "You write concise scene descriptions for an AI image generator that edits a reference photo of one woman. Turn the user's request into a single vivid, concrete visual scene: setting, clothing, pose, expression, lighting, mood. Keep it tasteful and non-explicit. Do not mention the reference image, the camera, or phrases like 'send a photo'. Output ONLY the scene description as one short paragraph, no preamble, no quotes." },
          { role: "user", content: msg }
        ]
      })
    });
    if (!r.ok) return msg;
    const j = await r.json();
    const txt = ((j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "").toString().trim();
    return txt || msg;
  } catch (e) {
    return msg;
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
  const model = process.env.GROK_VISION_MODEL || process.env.GROK_MODEL || "grok-4.3";
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, 8000);
  try {
    const r = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + xaiKey },
      signal: controller.signal,
      body: JSON.stringify({
        model: model,
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

      // Optionally let the LLM turn a casual request into a detailed scene (exactly like the chat does).
      let scene = body.scene;
      if (body.expand) scene = await expandScene(scene);

      // Up to 3 keyword-triggered extra reference images.
      let extraRefs = [];
      if (Array.isArray(body.extraRefs)) {
        extraRefs = body.extraRefs
          .filter(function (e) { return e && typeof e.url === "string" && e.url; })
          .slice(0, 3)
          .map(function (e) { return { url: e.url, label: (typeof e.label === "string" ? e.label : "") }; });
      }

      const finalPrompt = buildPrompt(scene, extraRefs);
      const images = [refUrl].concat(extraRefs.map(function (e) { return e.url; }));

      const payload = {
        prompt: finalPrompt,
        images: images,
        enable_base64_output: false,
        enable_sync_mode: false,
      };

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
      return res.status(200).json({ requestId: requestId, prompt: finalPrompt, scene: scene });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
