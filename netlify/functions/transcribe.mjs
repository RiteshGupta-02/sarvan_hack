const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify(body)
});

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST for this request." });
  const apiKey = process.env.SARVAM_API_KEY || process.env.API_KEY;
  if (!apiKey) return json(503, { error: "Sarvam is not configured yet. Add SARVAM_API_KEY in Netlify site settings." });

  try {
    if (typeof event.body !== "string" || event.body.length > 8 * 1024 * 1024) {
      return json(413, { error: "Audio recording is too large. Please try a shorter recording." });
    }
    const body = JSON.parse(event.body || "");
    if (typeof body.audioBase64 !== "string" || body.audioBase64.length > 8 * 1024 * 1024) {
      return json(400, { error: "Audio recording is missing or too large. Please try a shorter recording." });
    }
    const audioBytes = Buffer.from(body.audioBase64, "base64");
    if (!audioBytes.length || audioBytes.length > 6 * 1024 * 1024) {
      return json(400, { error: "Audio recording is missing or too large. Please try a shorter recording." });
    }
    const allowedTypes = new Set(["audio/webm", "audio/mp4", "audio/ogg", "audio/wav", "audio/mpeg"]);
    const audioType = typeof body.audioType === "string" && allowedTypes.has(body.audioType.split(";")[0])
      ? body.audioType.split(";")[0]
      : "audio/webm";
    const filename = typeof body.filename === "string" && /^[\w.-]{1,80}$/.test(body.filename)
      ? body.filename
      : "recording.webm";
    const customerNames = Array.isArray(body.customerNames)
      ? body.customerNames.filter((name) => typeof name === "string").map((name) => name.slice(0, 64))
        .slice(0, 50)
      : [];
    const audio = new FormData();
    audio.append("file", new Blob([audioBytes], { type: audioType }), filename);
    audio.append("model", "saaras:v4");
    audio.append("language_code", "unknown");
    if (customerNames.length) audio.append("keyterms", JSON.stringify(customerNames));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch("https://api.sarvam.ai/speech-to-text", {
        method: "POST",
        headers: { "api-subscription-key": apiKey },
        body: audio,
        signal: controller.signal
      });
      if (!response.ok) {
        console.error("Sarvam speech-to-text failed with status", response.status);
        return json(502, { error: "Sarvam could not transcribe this recording. Please try again." });
      }
      const result = await response.json();
      if (typeof result.transcript !== "string" || !result.transcript.trim()) {
        return json(422, { error: "I could not hear any words. Please try speaking a little louder." });
      }
      return json(200, {
        transcript: result.transcript.slice(0, 500),
        languageCode: typeof result.language_code === "string" ? result.language_code : null
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    if (error instanceof SyntaxError) return json(400, { error: "Invalid audio request. Please record again." });
    if (error.name === "AbortError") return json(504, { error: "Transcription took too long. Please try again." });
    console.error("Audio transcription request could not be processed:", error.message);
    return json(502, { error: "Audio could not be processed. Please try again." });
  }
};
