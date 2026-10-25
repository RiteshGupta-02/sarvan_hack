import { requireOwner } from "./_lib/auth.mjs";
import { readLedger } from "./_lib/ledger.mjs";

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

const responseText = (data) => {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part?.text || "").join("");
  return null;
};

const parseIntent = (content) => {
  const cleaned = content.replace(/```(?:json)?/gi, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Sarvam returned no structured intent.");
  const intent = JSON.parse(match[0]);
  if (!intent || typeof intent !== "object" || !allowedIntents.has(intent.intent)) {
    throw new Error("Sarvam returned an unsupported intent.");
  }
  if (intent.amount_paise !== null && intent.amount_paise !== undefined &&
      (!Number.isSafeInteger(intent.amount_paise) || intent.amount_paise <= 0)) {
    throw new Error("Sarvam returned an invalid amount.");
  }
  return {
    intent: intent.intent,
    customer_name: typeof intent.customer_name === "string" ? intent.customer_name.slice(0, 80) : null,
    amount_paise: intent.amount_paise ?? null,
    description: typeof intent.description === "string" ? intent.description.slice(0, 120) : null,
    needs_clarification: intent.needs_clarification === true,
    reply: typeof intent.reply === "string" ? intent.reply.slice(0, 300) : null
  };
};

const retryableStatus = (status) => status === 408 || status === 429 || status >= 500;

const requestIntent = async ({ apiKey, message, history, customerNames }) => {
  const system = `You are UdhaarOS, a careful Hindi/Hinglish/English shop-ledger assistant. Interpret the LATEST user message and return exactly one JSON object:
{"intent":"add_credit|record_payment|get_balance|get_customer_history|list_customers|list_top_debtors|get_summary|clarify|unknown","customer_name":string|null,"amount_paise":integer|null,"description":string|null,"needs_clarification":boolean,"reply":string|null}
Use recent conversation only to understand a direct answer to your own clarification question. Never repeat an operation from an earlier user message. A customer takes goods on credit => add_credit. A customer gives money to the shop => record_payment. Convert rupees to integer paise (₹1 = 100). Never infer a missing amount, customer, or transaction direction. Ask one short, specific question in the user's language when unclear. Only use exact customer names from this list: ${JSON.stringify(customerNames)}; if more than one could match, clarify. For balance/history/top debtor/summary requests, return the appropriate intent; do not calculate or state any balance. Output JSON only.`;

  const messages = [
    { role: "system", content: system },
    ...history,
    { role: "user", content: message }
  ];
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch("https://api.sarvam.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-subscription-key": apiKey
        },
        body: JSON.stringify({
          model: "sarvam-105b-conversations",
          messages,
          temperature: 0,
          max_tokens: 500
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        if (attempt === 0 && retryableStatus(response.status)) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        const error = new Error("Sarvam AI is temporarily unavailable. Please retry.");
        error.statusCode = response.status === 429 ? 429 : 502;
        throw error;
      }
      const data = await response.json();
      const content = responseText(data);
      if (!content) throw new Error("Sarvam returned an empty response.");
      return parseIntent(content);
    } catch (error) {
      lastError = error;
      if (error.statusCode || attempt > 0) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error("Sarvam AI is temporarily unavailable. Please retry.");
};

export const handler = async (event) => {
  try {
    const access = await requireOwner(event);
    if (access.response) return access.response;
  } catch (error) {
    console.error("Owner session verification failed:", error.message);
    return json(503, { error: "Could not verify your sign-in. Please retry." });
  }
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST for this request." });

  const apiKey = process.env.SARVAM_API_KEY || process.env.API_KEY;
  if (!apiKey) return json(503, { error: "Add SARVAM_API_KEY to the Netlify environment variables." });

  if (typeof event.body !== "string" || event.body.length > 12_000) return json(413, { error: "Conversation is too long. Start a new request." });
  let body;
  try {
    body = JSON.parse(event.body || "");
  } catch {
    return json(400, { error: "Invalid message. Please try again." });
  }
  if (typeof body.message !== "string" || !body.message.trim() || body.message.length > 500) {
    return json(400, { error: "Message is required and must be under 500 characters." });
  }
  const history = Array.isArray(body.history)
    ? body.history.slice(-6).filter((turn) =>
      (turn?.role === "user" || turn?.role === "assistant") &&
      typeof turn.content === "string" && turn.content.length <= 500
    ).map((turn) => ({ role: turn.role, content: turn.content }))
    : [];

  try {
    const { ledger } = await readLedger();
    const customerNames = ledger.customers.map((customer) => customer.name).slice(0, 100);
    return json(200, await requestIntent({
      apiKey,
      message: body.message.trim(),
      history,
      customerNames
    }));
  } catch (error) {
    if (error.statusCode) return json(error.statusCode, { error: error.message });
    console.error("Sarvam agent failed:", error.message);
    return json(502, { error: "I could not understand that yet. Please retry or rephrase your request." });
  }
};
