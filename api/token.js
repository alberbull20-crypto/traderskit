
const SITE = "https://traderskit.site";
const ALLOWED_REDIRECT = `${SITE}/callback.html`;
const CLIENT_ID = "34XJmAXXrWNVS1Ya34OOv";

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      error: "method_not_allowed"
    });
  }

  // Accept requests only from the canonical website.
  const origin = req.headers.origin;

  if (origin !== SITE) {
    return res.status(403).json({
      error: "invalid_origin"
    });
  }

  try {
    const {
      client_id,
      code,
      code_verifier,
      redirect_uri
    } = req.body || {};

    // Validate all required fields.
    if (
      client_id !== CLIENT_ID ||
      redirect_uri !== ALLOWED_REDIRECT ||
      typeof code !== "string" ||
      typeof code_verifier !== "string" ||
      code.length === 0 ||
      code_verifier.length < 43 ||
      code_verifier.length > 128
    ) {
      return res.status(400).json({
        error: "invalid_request",
        error_description: "Invalid or missing OAuth parameters."
      });
    }

    // Exchange the authorization code with Deriv.
    const tokenResponse = await fetch(
      "https://auth.deriv.com/oauth2/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: CLIENT_ID,
          code: code,
          code_verifier: code_verifier,
          redirect_uri: ALLOWED_REDIRECT
        })
      }
    );

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || !tokenData.access_token) {
      return res.status(tokenResponse.status || 502).json({
        error: tokenData.error || "token_exchange_failed",
        error_description:
          tokenData.error_description ||
          "Deriv could not complete the token exchange."
      });
    }

    // Return only the required token information.
    return res.status(200).json({
      access_token: tokenData.access_token,
      expires_in: tokenData.expires_in,
      token_type: tokenData.token_type || "Bearer"
    });

  } catch (error) {
    console.error("OAuth token exchange failed:", error.message);

    return res.status(500).json({
      error: "server_error",
      error_description: "The authentication server encountered an error."
    });
  }
};
