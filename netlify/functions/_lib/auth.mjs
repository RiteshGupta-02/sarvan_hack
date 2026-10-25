import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";

const sessions = getStore("udhaaros-sessions");
const cookieName = "udhaaros_session";
const sessionLifetimeSeconds = 60 * 60 * 24 * 30;
const validOwnerPassword = () => typeof process.env.OWNER_PASSWORD === "string" && process.env.OWNER_PASSWORD.length >= 16;

const json = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  body: JSON.stringify(body)
});

const sessionCookie = (value, maxAge) =>
  `${cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

const getCookie = (event, name) => {
  const cookieHeader = Object.entries(event.headers || {}).find(([key]) => key.toLowerCase() === "cookie")?.[1] || "";
  const encodedName = `${name}=`;
  return cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith(encodedName))?.slice(encodedName.length) || null;
};

const tokenHash = (token) => createHash("sha256").update(token).digest("hex");

export const verifyOwner = async (event) => {
  if (!validOwnerPassword()) return { configured: false, authenticated: false };
  const token = getCookie(event, cookieName);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return { configured: true, authenticated: false };
  const key = tokenHash(token);
  const session = await sessions.get(key, { type: "json", consistency: "strong" });
  if (!session || !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now() ||
      session.passwordHash !== tokenHash(process.env.OWNER_PASSWORD)) {
    if (session) await sessions.delete(key);
    return { configured: true, authenticated: false };
  }
  return { configured: true, authenticated: true };
};

export const requireOwner = async (event) => {
  const auth = await verifyOwner(event);
  if (!auth.configured) return { response: json(503, { error: "Set OWNER_PASSWORD in Netlify environment variables first." }) };
  if (!auth.authenticated) return { response: json(401, { error: "Please sign in to access your shop ledger." }) };
  return { authenticated: true };
};

export const handleAuth = async (event) => {
  const ownerPassword = process.env.OWNER_PASSWORD;
  if (!validOwnerPassword()) {
    return json(503, { authenticated: false, error: "Set OWNER_PASSWORD to a private password with at least 16 characters." });
  }

  if (event.httpMethod === "GET") {
    const auth = await verifyOwner(event);
    return json(200, auth);
  }
  if (event.httpMethod !== "POST") return json(405, { error: "Use GET or POST for this request." });

  let body;
  try {
    body = JSON.parse(event.body || "");
  } catch {
    return json(400, { error: "Invalid sign-in request." });
  }

  if (body.action === "logout") {
    const token = getCookie(event, cookieName);
    if (token && /^[a-f0-9]{64}$/.test(token)) await sessions.delete(tokenHash(token));
    return json(200, { authenticated: false }, { "Set-Cookie": sessionCookie("", 0) });
  }
  if (typeof body.password !== "string" || body.password.length > 256) {
    return json(400, { error: "Enter your owner password." });
  }

  const expected = Buffer.from(ownerPassword);
  const provided = Buffer.from(body.password);
  const valid = expected.length === provided.length && expected.length > 0 && timingSafeEqual(expected, provided);
  if (!valid) return json(401, { error: "Password did not match. Please try again." });

  const token = randomBytes(32).toString("hex");
  await sessions.setJSON(tokenHash(token), {
    expiresAt: Date.now() + sessionLifetimeSeconds * 1000,
    passwordHash: tokenHash(ownerPassword)
  });
  return json(200, { authenticated: true }, { "Set-Cookie": sessionCookie(token, sessionLifetimeSeconds) });
};
