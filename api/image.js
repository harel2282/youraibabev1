// api/image.js
// Generates a photo "from" a companion using ByteDance Seedream v4.5 Edit on WaveSpeed.
// The companion's reference image (stored in Supabase Storage) is passed so she always
// looks the same. Because generation takes ~19s and Vercel Hobby caps functions at 10s,
// this is split into two quick calls:
//   POST  -> submit the job, returns { requestId }
//   GET ?id=... -> poll the job, returns { status, url }
//
// Required env var in Vercel: WAVESPEED_API_KEY

const WAVESPEED_SUBMIT = "https://api.wavespeed.ai/api/v3/bytedance/seedream-v4.5/edit";
const WAVESPEED_RESULT = "https://api.wavespeed.ai/api/v3/predictions/"; // + {id}/result

// Where the per-model reference images live (public Supabase Storage bucket "references").
const SUPABASE_URL = "https://nmkonmvcqcejhrqjmcqv.supabase.co";
const REFERENCE_BASE = SUPABASE_URL + "/storage/v1/object/public/references/";

function referenceUrlFor(profileId) {
  return REFERENCE_BASE + profileId + ".jpg";
}

// Wrap the model-written scene into a high-quality, identity-preserving edit prompt.
function buildPrompt(scene) {
  const s = (scene || "").trim();
  return (
    "Keep the exact same woman from the reference image — identical face, hair, skin tone and body. Do not change her identity. " +
    (s ? s + " " : "A natural, flattering candid photo of her. ") +
    "Anatomically correct: natural hands with exactly five fingers on each hand, normal proportional limbs, only one person in frame, no duplicated faces or bodies, no warped or distorted features, no extra limbs or fingers. " +
    "Sharp focus, clean realistic detail, natural realistic skin texture."
  );
}

// ---- Anatomy / quality gate ----
// Asks a Grok vision model whether the generated photo has obvious AI defects
// (3 hands, extra fingers, two people, melted face...). Returns true if the image
// looks OK. FAILS OPEN: if the check is disabled, times out, or errors, returns true
// so a photo is still sent (never blocks the flow). Reuses XAI_API_KEY.
// Env: IMAGE_QC=off to disable. GROK_VISION_MODEL to use a faster vision model.
async function verifyAnatomy(imageUrl) {
  if (String(process.env.IMAGE_QC || "on").toLowerCase() === "off") return true;
  const xaiKey = process.env.XAI_API_KEY;
  if (!xaiKey || !imageUrl) return true;
  const model = process.env.GROK_VISION_MODEL || process.env.GROK_MODEL || "grok-4.3";
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, 8000); // stay under Vercel's 10s function limit
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
    // ---- POLL: GET /api/image?id=REQUEST_ID ----
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

    // ---- SUBMIT: POST { profileId, scene, referenceUrl } ----
    if (req.method === "POST") {
      const body = req.body || {};
      const profileId = body.profileId;
      const scene = body.scene;
      if (profileId == null) return res.status(400).json({ error: "Missing profileId" });

      // The client passes the exact reference image URL (handles .png vs .jpg per girl);
      // fall back to the legacy "{id}.jpg" convention if it wasn't provided.
      const refUrl = (typeof body.referenceUrl === "string" && body.referenceUrl) ? body.referenceUrl : referenceUrlFor(profileId);

      const payload = {
        prompt: buildPrompt(scene),
        images: [refUrl],
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
      return res.status(200).json({ requestId: requestId });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
