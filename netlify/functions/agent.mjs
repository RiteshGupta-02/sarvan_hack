const allowedIntents = new Set([
  "add_credit",
  "record_payment",
  "get_balance",
  "get_customer_history",
  "list_customers",
  "list_top_debtors",
  "get_summary",
  "clarify",
  "unknown"
]);

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify(body)
});

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST for this request." });
  const apiKey = process.env.SARVAM_API_KEY || process.env.API_KEY;
  if (!apiKey) return json(503, { error: "Sarvam is not configured yet. Add SARVAM_API_KEY in Netlify site settings." });

  let body;
  try {
    body = JSON.parse(event.body || "");
  } catch {
    return json(400, { error: "Invalid request. Please try again." });
  }
  if (typeof body.message !== "string" || !body.message.trim() || body.message.length > 500) {
    return json(400, { error: "Message is required and must be under 500 characters." });
  }
  const names = Array.isArray(body.customerNames)
    ? body.customerNames.filter((name) => typeof name === "string").slice(0, 100)
    : [];
  const system = `You extract bookkeeping intent for a small Indian shop. Return ONLY one JSON object with these fields:
{"intent":"add_credit|record_payment|get_balance|get_customer_history|list_customers|list_top_debtors|get_summary|clarify|unknown","customer_name":string|null,"amount_paise":integer|null,"description":string|null,"needs_clarification":boolean,"reply":string|null}
Understand Hindi, Hinglish, and English. Add-credit means customer took goods on credit; payment means money was paid to the shop. Amounts in rupees must be converted to integer paise. Never invent a missing amount or customer. If an amount/customer/direction is ambiguous, use intent "clarify", needs_clarification true, and reply with a short question in the user's language. For data questions select the matching read intent. Do not calculate or claim balances. Match customer names only from this list: ${JSON.stringify(names)}. If uncertain about the name, clarify.`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch("https://api.sarvam.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-subscription-key": apiKey
      },
      body: JSON.stringify({
        model: "sarvam-105b",
        messages: [
          { role: "system", content: system },
          { role: "user", content: body.message.trim() }
        ],
        temperature: 0
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      console.error("Sarvam request failed with status", response.status);
      return json(502, { error: "Sarvam AI request failed. Check the API key and try again." });
    }
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") return json(502, { error: "Sarvam returned an unreadable response. Please try again." });
    const parsed = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
    if (!parsed || typeof parsed !== "object" || !allowedIntents.has(parsed.intent)) {
      return json(502, { error: "Sarvam returned an unsupported request. Please rephrase and try again." });
    }
    const amount = parsed.amount_paise;
    if (amount !== null && amount !== undefined && (!Number.isSafeInteger(amount) || amount <= 0)) {
      return json(502, { error: "Sarvam could not identify a valid amount. Please rephrase." });
    }
    return json(200, {
      intent: parsed.intent,
      customer_name: typeof parsed.customer_name === "string" ? parsed.customer_name.slice(0, 80) : null,
      amount_paise: amount ?? null,
      description: typeof parsed.description === "string" ? parsed.description.slice(0, 120) : null,
      needs_clarification: parsed.needs_clarification === true,
      reply: typeof parsed.reply === "string" ? parsed.reply.slice(0, 300) : null
    });
  } catch (error) {
    if (error.name === "AbortError") return json(504, { error: "Sarvam AI took too long. Please retry; no entry was saved." });
    console.error("Sarvam response could not be processed:", error.message);
    return json(502, { error: "Sarvam response could not be processed. Please retry; no entry was saved." });
  } finally {
    clearTimeout(timeout);
  }
};
