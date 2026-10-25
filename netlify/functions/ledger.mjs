import { createCustomer, createTransaction, readLedger } from "./_lib/ledger.mjs";
import { requireOwner } from "./_lib/auth.mjs";

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify(body)
});

const parseBody = (event) => {
  if (typeof event.body !== "string" || event.body.length > 32_000) {
    const error = new Error("Request is too large.");
    error.statusCode = 413;
    throw error;
  }
  return JSON.parse(event.body || "");
};

export const handler = async (event) => {
  try {
    const access = await requireOwner(event);
    if (access.response) return access.response;
  } catch (error) {
    console.error("Owner session verification failed:", error.message);
    return json(503, { error: "Could not verify your sign-in. Please retry." });
  }
  if (event.httpMethod === "GET") {
    try {
      const { ledger } = await readLedger();
      return json(200, ledger);
    } catch (error) {
      console.error("Persistent ledger read failed:", error.message);
      return json(503, { error: "Could not load your saved ledger. Please retry." });
    }
  }
  if (event.httpMethod !== "POST") return json(405, { error: "Use GET or POST for this request." });

  try {
    const body = parseBody(event);
    if (body.action === "create_customer") {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const phone = typeof body.phone === "string" ? body.phone.trim() : "";
      if (!name || name.length > 80) return json(400, { error: "Customer name must be 1–80 characters." });
      if (phone.length > 20) return json(400, { error: "Phone number must be under 20 characters." });
      const result = await createCustomer({ name, phone });
      return json(201, { customer: result.customer, ...result.ledger });
    }
    if (body.action === "create_transaction") {
      const { customerId, type, amountPaise, description, requestId } = body;
      if (typeof customerId !== "string" || !/^[\w-]{1,80}$/.test(customerId)) return json(400, { error: "Choose a valid customer." });
      if (type !== "credit" && type !== "payment") return json(400, { error: "Choose credit or payment." });
      if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0 || amountPaise > 100_000_000_000) {
        return json(400, { error: "Enter a valid positive amount." });
      }
      if (typeof requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(requestId)) return json(400, { error: "Transaction request ID is invalid." });
      const result = await createTransaction({
        customerId,
        type,
        amountPaise,
        description: typeof description === "string" ? description.trim().slice(0, 120) : "",
        requestId
      });
      return json(200, { transaction: result.transaction, balancePaise: result.balancePaise, ...result.ledger });
    }
    return json(400, { error: "Unsupported ledger action." });
  } catch (error) {
    if (error instanceof SyntaxError) return json(400, { error: "Invalid JSON request." });
    if (error.statusCode) return json(error.statusCode, { error: error.message });
    console.error("Persistent ledger write failed:", error.message);
    return json(503, { error: "Your change could not be saved. Please retry." });
  }
};
