// api/token.js
// Vercel function. It swaps the login code from Deriv for an access token.
// The browser sends the code and the PKCE verifier here, and this file forwards them to Deriv.
// Codes and tokens are never logged.

const SITE = "https://www.traderskit.site";
const ALLOWED_REDIRECT = SITE + "/callback.html";

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  // Only accept requests that come from our own site
  const origin = req.headers.origin;
  if (origin && origin !== SITE) {
    return res.status(403).json({ error: "forbidden_origin" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  const client_id = body.client_id;
  const code = body.code;
  const code_verifier = body.code_verifier;
  const redirect_uri = body.redirect_uri;

  const valid =
    typeof client_id === "string" && /^[A-Za-z0-9_-]{5,100}$/.test(client_id) &&
    typeof code === "string" && code.length > 0 && code.length <= 2000 &&
    typeof code_verifier === "string" && code_verifier.length >= 43 && code_verifier.length <= 128 &&
    redirect_uri === ALLOWED_REDIRECT;

  if (!valid) {
    return res.status(400).json({ error: "invalid_request", error_description: "Missing or invalid fields." });
  }

  try {
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client_id,
      code: code,
      code_verifier: code_verifier,
      redirect_uri: redirect_uri
    });

    const upstream = await fetch("https://auth.deriv.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form.toString()
    });

    const text = await upstream.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { data = {}; }

    if (!upstream.ok || !data.access_token) {
      return res.status(upstream.ok ? 502 : upstream.status).json({
        error: data.error || "token_error",
        error_description: data.error_description || "Deriv did not accept the login code."
      });
    }

    return res.status(200).json({
      access_token: data.access_token,
      expires_in: data.expires_in,
      token_type: data.token_type
    });
  } catch (e) {
    return res.status(502).json({ error: "upstream_unreachable", error_description: "Could not reach Deriv." });
  }
};