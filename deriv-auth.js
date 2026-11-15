/* deriv-auth.js
   Shared login helper for Deriv's OAuth 2.0 login (authorization code with PKCE).
   Pages that need a login load this file. It never sees your password. */

(function () {
  "use strict";

  // ---------- Paste your App ID here ----------
  // Copy it with the copy icon on developers.deriv.com/dashboard (do not retype it).
  const CLIENT_ID = "34XJmAXXrWNVS1Ya34OOv";

  // ---------- Fixed settings ----------
  const SITE = "https://www.traderskit.site";
  const REDIRECT_URI = SITE + "/callback.html"; // must match the Redirect URL in your Deriv app exactly
  const AUTH_URL = "https://auth.deriv.com/oauth2/auth";
  const SCOPE = "trade";

  const TOKEN_KEY = "dp_access_token";
  const EXPIRY_KEY = "dp_token_expires";
  const VERIFIER_KEY = "dp_pkce_verifier";
  const STATE_KEY = "dp_oauth_state";

  // ---------- Random strings and the PKCE challenge ----------
  function randomString(length) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    return Array.from(bytes, function (b) { return chars[b % chars.length]; }).join("");
  }

  async function challengeFor(verifier) {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return btoa(String.fromCharCode.apply(null, new Uint8Array(hash)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  // ---------- Start the login ----------
  async function login() {
    if (CLIENT_ID.indexOf("PASTE") === 0) {
      alert("Add your App ID to deriv-auth.js first.");
      return;
    }
    if (window.location.origin !== SITE) {
      alert("Login only works on " + SITE + ". Open the site at that address and try again.");
      return;
    }

    const verifier = randomString(64);
    const state = randomString(24);
    const challenge = await challengeFor(verifier);

    try {
      sessionStorage.setItem(VERIFIER_KEY, verifier);
      sessionStorage.setItem(STATE_KEY, state);
    } catch (e) {
      alert("Your browser is blocking storage, so login cannot work. Turn off private mode and try again.");
      return;
    }

    const params = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: SCOPE,
      state: state,
      code_challenge: challenge,
      code_challenge_method: "S256"
    });
    window.location.href = AUTH_URL + "?" + params.toString();
  }

  // ---------- Token kept for this browser tab only ----------
  function saveToken(token, expiresIn) {
    const seconds = Number(expiresIn) > 0 ? Number(expiresIn) : 3600;
    try {
      sessionStorage.setItem(TOKEN_KEY, token);
      sessionStorage.setItem(EXPIRY_KEY, String(Date.now() + seconds * 1000 - 60000));
    } catch (e) { /* ignore */ }
  }

  function logout() {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(EXPIRY_KEY);
    } catch (e) { /* ignore */ }
  }

  function getToken() {
    try {
      const token = sessionStorage.getItem(TOKEN_KEY);
      const expires = Number(sessionStorage.getItem(EXPIRY_KEY));
      if (!token) return null;
      if (!expires || Date.now() >= expires) { logout(); return null; }
      return token;
    } catch (e) { return null; }
  }

  // ---------- Used by callback.html ----------
  function readPkce() {
    try {
      return {
        verifier: sessionStorage.getItem(VERIFIER_KEY),
        state: sessionStorage.getItem(STATE_KEY)
      };
    } catch (e) { return { verifier: null, state: null }; }
  }

  function clearPkce() {
    try {
      sessionStorage.removeItem(VERIFIER_KEY);
      sessionStorage.removeItem(STATE_KEY);
    } catch (e) { /* ignore */ }
  }

  window.DerivAuth = {
    CLIENT_ID: CLIENT_ID,
    SITE: SITE,
    REDIRECT_URI: REDIRECT_URI,
    login: login,
    logout: logout,
    getToken: getToken,
    saveToken: saveToken,
    isLoggedIn: function () { return !!getToken(); },
    readPkce: readPkce,
    clearPkce: clearPkce
  };
})();