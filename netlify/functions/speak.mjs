import { requireOwner } from "./_lib/auth.mjs";

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify(body)
});

const supportedLanguages = new Set([
  "hi-IN", "bn-IN", "ta-IN", "te-IN", "kn-IN", "ml-IN",
  "mr-IN", "gu-IN", "pa-IN", "od-IN", "en-IN"
]);

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST for this request." });
  try {
    const access = await requireOwner(event);
    if (access.response) return access.response;
  } catch (error) {
    console.error("Owner session verification failed:", error.message);
    return json(503, { error: "Could not verify your sign-in. Please retry." });
  }
  const apiKey = process.env.SARVAM_API_KEY || process.env.API_KEY;
  if (!apiKey) return json(503, { error: "Sarvam is not configured yet. Add SARVAM_API_KEY in Netlify site settings." });

  let body;
  try {
    body = JSON.parse(event.body || "");
  } catch {
    return json(400, { error: "Invalid speech request." });
  }
  if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 500) {
    return json(400, { error: "Speech text must be between 1 and 500 characters." });
  }
  if (!supportedLanguages.has(body.languageCode)) {
    return json(400, { error: "Spoken replies are not available for this language yet." });
  }
  const languageCode = body.languageCode;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch("https://api.sarvam.ai/text-to-speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-subscription-key": apiKey
      },
      body: JSON.stringify({
        text: body.text.trim(),
        language_code: languageCode,
        model: "bulbul:v3",
        speaker: "shubh"
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      console.error("Sarvam text-to-speech failed with status", response.status);
      return json(502, { error: "Sarvam could not create spoken audio." });
    }
    const result = await response.json();
    if (!Array.isArray(result.audios) || !result.audios.every((audio) => typeof audio === "string")) {
      return json(502, { error: "Sarvam returned invalid speech audio." });
    }
    return json(200, { audio: result.audios.join(""), languageCode });
  } catch (error) {
    if (error.name === "AbortError") return json(504, { error: "Speech generation took too long." });
    console.error("Text-to-speech request could not be processed:", error.message);
    return json(502, { error: "Spoken audio could not be processed." });
  } finally {
    clearTimeout(timeout);
  }
};
