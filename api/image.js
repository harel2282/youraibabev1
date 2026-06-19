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
    "Sharp focus, clean realistic detail, natural realistic skin texture. Tasteful, non-explicit."
  );
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
      return res.status(200).json({ status: status, url: url });
    }

    // ---- SUBMIT: POST { profileId, scene } ----
    if (req.method === "POST") {
      const body = req.body || {};
      const profileId = body.profileId;
      const scene = body.scene;
      if (profileId == null) return res.status(400).json({ error: "Missing profileId" });

      const payload = {
        prompt: buildPrompt(scene),
        images: [referenceUrlFor(profileId)],
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
