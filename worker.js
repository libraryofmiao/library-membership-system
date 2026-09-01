const NOCODB_BASE = "https://app.nocodb.com/api/v3/data/pjqnbrcq6h8tuig/my00qyl601nwq3i/records";
const MAX_BODY_BYTES = 3 * 1024 * 1024;

const ALLOWED_FIELDS = [
  "fullName", "guardian", "gender", "dob", "occupation", "address", "district", "state",
  "pincode", "mobile", "email", "membershipType", "duration", "idType", "idNumber",
  "issueDate", "status", "photoUrl", "timestamp"
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
    if (url.pathname === "/api/health" && request.method === "GET") return json({ success: true, service: "sdlm-membership-backend" }, 200, request);
    if (url.pathname === "/api/register" && request.method === "POST") return handleRegistration(request, env);
    if (url.pathname === "/api/members" && request.method === "GET") return handleMembers(request, env);
    if (url.pathname === "/api/member" && request.method === "GET") return handleGetMember(request, env);
    if (url.pathname === "/api/member" && request.method === "DELETE") return handleDeleteMember(request, env);
    if (url.pathname === "/api/verify" && request.method === "GET") return handleVerify(request, env);
    return new Response("Not Found", { status: 404, headers: corsHeaders(request) });
  }
};

async function handleRegistration(request, env) {
  if (!env.NOCODB_TOKEN) return json({ success: false, message: "Backend is not configured: NOCODB_TOKEN is missing." }, 500, request);
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) return json({ success: false, message: "Registration payload is too large." }, 413, request);
  let input;
  try { input = await request.json(); } catch { return json({ success: false, message: "Invalid JSON request." }, 400, request); }
  const incoming = input?.fields && typeof input.fields === "object" ? input.fields : input;
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return json({ success: false, message: "Invalid registration data." }, 400, request);
  const fields = {};
  for (const key of ALLOWED_FIELDS) if (Object.prototype.hasOwnProperty.call(incoming, key)) fields[key] = incoming[key];
  const required = ["fullName", "gender", "dob", "address", "mobile", "membershipType"];
  const missing = required.filter((key) => !String(fields[key] ?? "").trim());
  if (missing.length) return json({ success: false, message: `Missing required fields: ${missing.join(", ")}` }, 400, request);
  fields.verify = generateVerify();
  fields.issueDate = new Date().toISOString().slice(0, 10);
  fields.status = "Active";
  fields.timestamp = new Date().toISOString();

  const createResponse = await nocodbFetch(env, { method: "POST", body: JSON.stringify([{ fields }]) });
  if (!createResponse.ok) return forwardNocoDBError(createResponse, request);
  const created = await safeJson(createResponse);
  const recordId = created?.records?.[0]?.id;
  if (recordId === undefined || recordId === null) return json({ success: false, message: "NocoDB created the record but did not return its record ID." }, 502, request);
  const memberId = `SDLM${String(recordId).padStart(4, "0")}`;
  const updateResponse = await nocodbFetch(env, { method: "PATCH", body: JSON.stringify([{ id: recordId, fields: { memberId } }]) });
  if (!updateResponse.ok) return json({ success: false, message: "Member record was created, but assigning the Membership ID failed.", verify: fields.verify, recordId }, 502, request);
  return json({ success: true, memberId, verify: fields.verify, recordId }, 200, request);
}

async function handleMembers(request, env) {
  if (!env.NOCODB_TOKEN) return json({ success: false, message: "Backend is not configured." }, 500, request);
  try {
    const data = await getAllRecords(env);
    const members = data.map(r => ({ id: r.id, ...(r.fields || {}) }));
    return json({ success: true, members, stats: { total: members.length } }, 200, request);
  } catch (e) {
    return json({ success: false, message: e?.message || "Unable to load member data." }, 502, request);
  }
}

async function handleGetMember(request, env) {
  const url = new URL(request.url);
  const memberId = String(url.searchParams.get("memberId") || "").trim();
  if (!memberId) return json({ success: false, message: "memberId is required." }, 400, request);
  try {
    const records = await findByField(env, "memberId", memberId);
    if (!records.length) return json({ success: false, message: "Member not found." }, 404, request);
    const r = records[0];
    return json({ success: true, member: { id: r.id, ...(r.fields || {}) } }, 200, request);
  } catch (e) { return json({ success: false, message: e?.message || "Unable to load member." }, 502, request); }
}

async function handleDeleteMember(request, env) {
  const url = new URL(request.url);
  const memberId = String(url.searchParams.get("memberId") || "").trim();
  if (!memberId) return json({ success: false, message: "memberId is required." }, 400, request);
  try {
    const records = await findByField(env, "memberId", memberId);
    if (!records.length) return json({ success: false, message: "Member not found." }, 404, request);
    const response = await nocodbFetch(env, { method: "DELETE", body: JSON.stringify([{ id: records[0].id }]) });
    if (!response.ok) return forwardNocoDBError(response, request);
    return json({ success: true, message: `Member ${memberId} deleted successfully.` }, 200, request);
  } catch (e) { return json({ success: false, message: e?.message || "Delete failed." }, 502, request); }
}

async function handleVerify(request, env) {
  const url = new URL(request.url);
  const verify = String(url.searchParams.get("verify") || "").trim();
  if (!verify || !/^[A-Za-z0-9]{6}$/.test(verify)) {
    return json({ success: false, message: "Invalid verification code." }, 400, request);
  }
  try {
    const records = await findByField(env, "verify", verify);
    if (!records.length) return json({ success: false, message: "Member not found. The QR code may be invalid." }, 404, request);
    const r = records[0];
    return json({ success: true, member: { id: r.id, ...(r.fields || {}) } }, 200, request);
  } catch (e) {
    return json({ success: false, message: e?.message || "Unable to verify member." }, 502, request);
  }
}

async function getAllRecords(env) {
  const records = [];
  let nextUrl = NOCODB_BASE;
  while (nextUrl) {
    const response = await fetch(nextUrl, { headers: { "xc-token": env.NOCODB_TOKEN, "Accept": "application/json" } });
    if (!response.ok) throw new Error(`NocoDB returned HTTP ${response.status}`);
    const data = await response.json();
    if (Array.isArray(data?.records)) records.push(...data.records);
    nextUrl = data?.next || null;
    if (nextUrl) {
      const parsed = new URL(nextUrl);
      if (parsed.origin !== new URL(NOCODB_BASE).origin) throw new Error("Invalid NocoDB pagination URL.");
    }
  }
  return records;
}

async function findByField(env, field, value) {
  const url = new URL(NOCODB_BASE);
  url.searchParams.set("where", `(${field},eq,${JSON.stringify(value)})`);
  const response = await fetch(url.toString(), { headers: { "xc-token": env.NOCODB_TOKEN, "Accept": "application/json" } });
  if (!response.ok) throw new Error(`NocoDB returned HTTP ${response.status}`);
  const data = await response.json();
  return Array.isArray(data?.records) ? data.records : [];
}

async function nocodbFetch(env, options) {
  return fetch(NOCODB_BASE, { method: options.method, headers: { "xc-token": env.NOCODB_TOKEN, "Content-Type": "application/json", "Accept": "application/json" }, body: options.body });
}

async function forwardNocoDBError(response, request) {
  const data = await safeJson(response);
  return json({ success: false, message: data?.message || data?.msg || "NocoDB rejected the request.", error: data }, response.status || 502, request);
}

function generateVerify() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(6); crypto.getRandomValues(bytes);
  let result = ""; for (let i = 0; i < bytes.length; i++) result += chars[bytes[i] % chars.length];
  return result;
}

async function safeJson(response) { try { return await response.json(); } catch { return null; } }

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  return { "Access-Control-Allow-Origin": origin || "*", "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Vary": "Origin", "Cache-Control": "no-store" };
}

function json(data, status = 200, request = null) {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  for (const [key, value] of Object.entries(corsHeaders(request || new Request("https://example.invalid")))) headers.set(key, value);
  return new Response(JSON.stringify(data), { status, headers });
}
