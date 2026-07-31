// Proxy: DWG bytes → high-fidelity WebP via ConvertAPI (secret stays server-side).

import { convertDwgToWebp } from "./convert-dwg-core.mjs";

const MAX_DWG_BYTES = 80 * 1024 * 1024; // 80 MiB

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(), body: "" };
  }
  if (event.httpMethod !== "POST") {
    return json(405, { error: "POST required" });
  }
  const secret = process.env.CONVERTAPI_SECRET || "";
  if (!secret) {
    return json(501, { error: "DWG conversion is not configured (set CONVERTAPI_SECRET on the server)" });
  }
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64")
    : Buffer.from(event.body || "", event.isBase64Encoded ? "base64" : "utf8");
  if (!raw.length) return json(400, { error: "Empty body" });
  if (raw.length > MAX_DWG_BYTES) return json(413, { error: "DWG file too large" });

  const qs = event.queryStringParameters || {};
  const filename = sanitizeFilename(qs.filename || "drawing.dwg");
  const dpi = qs.dpi;

  try {
    const webp = await convertDwgToWebp(raw, filename, secret, { dpi });
    return {
      statusCode: 200,
      headers: { ...corsHeaders(), "Content-Type": "image/webp", "Cache-Control": "private, max-age=3600" },
      body: webp.toString("base64"),
      isBase64Encoded: true,
    };
  } catch (e) {
    return json(502, { error: (e && e.message) || "Conversion failed" });
  }
}

function sanitizeFilename(name) {
  const base = String(name).split(/[/\\]/).pop() || "drawing.dwg";
  return base.replace(/[^\w.\- ()[\]]+/g, "_").slice(0, 200);
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
