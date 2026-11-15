
/* =========================================================
   TradersKit — Deriv OAuth 2.0 Authentication
   Canonical domain: https://traderskit.site
   Supports demo and real Options accounts.
   ========================================================= */

(function () {
  "use strict";

  const CLIENT_ID = "34XJmAXXrWNVS1Ya34OOv";

  const SITE = "https://traderskit.site";
  const REDIRECT_URI = SITE + "/callback.html";

  const AUTH_URL = "https://auth.deriv.com/oauth2/auth";
  const API_BASE = "https://api.derivws.com";

  // Request only the permissions needed at this stage.
  const SCOPE = "trade payment";

  const TOKEN_KEY = "dp_access_token";
  const EXPIRY_KEY = "dp_token_expires";
  const VERIFIER_KEY = "dp_pkce_verifier";
  const STATE_KEY = "dp_oauth_state";
  const ACCOUNT_KEY = "dp_selected_account";

  function randomString(length) {
    const chars =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

    const bytes = crypto.getRandomValues(new Uint8Array(length));

    return Array.from(bytes, function (byte) {
      return chars[byte % chars.length];
    }).join("");
  }

  async function challengeFor(verifier) {
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier)
    );

    return btoa(
      String.fromCharCode.apply(null, new Uint8Array(hash))
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  async function login() {
    if (window.location.origin !== SITE) {
      alert(
        "Please open TradersKit using https://traderskit.site before logging in."
      );
      return;
    }

    if (!window.crypto || !crypto.subtle) {
      alert("Secure browser features are unavailable. Please use HTTPS.");
      return;
    }

    try {
      const verifier = randomString(64);
      const state = randomString(32);
      const challenge = await challengeFor(verifier);

      sessionStorage.setItem(VERIFIER_KEY, verifier);
      sessionStorage.setItem(STATE_KEY, state);

      const params = new URLSearchParams({
        response_type: "code",
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        scope: SCOPE,
        state: state,
        code_challenge: challenge,
        code_challenge_method: "S256"
      });

      window.location.assign(
        AUTH_URL + "?" + params.toString()
      );

    } catch (error) {
      console.error("Deriv login failed:", error);
      alert("Could not start secure login. Please try again.");
    }
  }

  function saveToken(token, expiresIn) {
    if (!token || typeof token !== "string") {
      throw new Error("Invalid access token.");
    }

    const seconds = Number(expiresIn);

    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new Error("Invalid token expiry.");
    }

    sessionStorage.setItem(TOKEN_KEY, token);

    sessionStorage.setItem(
      EXPIRY_KEY,
      String(Date.now() + seconds * 1000 - 60000)
    );
  }

  function getToken() {
    try {
      const token = sessionStorage.getItem(TOKEN_KEY);
      const expiry = Number(sessionStorage.getItem(EXPIRY_KEY));

      if (!token || !expiry || Date.now() >= expiry) {
        logout();
        return null;
      }

      return token;

    } catch (error) {
      return null;
    }
  }

  function readPkce() {
    try {
      return {
        verifier: sessionStorage.getItem(VERIFIER_KEY),
        state: sessionStorage.getItem(STATE_KEY)
      };
    } catch (error) {
      return {
        verifier: null,
        state: null
      };
    }
  }

  function clearPkce() {
    sessionStorage.removeItem(VERIFIER_KEY);
    sessionStorage.removeItem(STATE_KEY);
  }

  function logout() {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(EXPIRY_KEY);
      sessionStorage.removeItem(ACCOUNT_KEY);
      clearPkce();
    } catch (error) {
      console.error("Could not clear login information:", error);
    }
  }

  async function getAccounts() {
    const token = getToken();

    if (!token) {
      throw new Error("Your login has expired. Please log in again.");
    }

    const response = await fetch(
      API_BASE + "/trading/v1/options/accounts",
      {
        method: "GET",
        headers: {
          Authorization: "Bearer " + token,
          Accept: "application/json"
        },
        cache: "no-store"
      }
    );

    const result = await response.json();

    if (!response.ok) {
      throw new Error(
        result?.errors?.[0]?.message ||
        "Could not retrieve your Deriv accounts."
      );
    }

    // Normalize the API response into an array.
    if (Array.isArray(result.data)) {
      return result.data;
    }

    if (result.data && typeof result.data === "object") {
      return [result.data];
    }

    return [];
  }

  function setSelectedAccount(accountId) {
    if (!accountId || typeof accountId !== "string") {
      throw new Error("Invalid Deriv account ID.");
    }

    sessionStorage.setItem(ACCOUNT_KEY, accountId);
  }

  function getSelectedAccount() {
    try {
      return sessionStorage.getItem(ACCOUNT_KEY);
    } catch (error) {
      return null;
    }
  }

  async function getWebSocketUrl(accountId) {
    const token = getToken();

    if (!token) {
      throw new Error("Please log in again.");
    }

    if (!accountId || typeof accountId !== "string") {
      throw new Error("Please select a Deriv account first.");
    }

    const endpoint =
      API_BASE +
      "/trading/v1/options/accounts/" +
      encodeURIComponent(accountId) +
      "/otp";

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/json"
      },
      cache: "no-store"
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(
        result?.errors?.[0]?.message ||
        "Could not authenticate the trading connection."
      );
    }

    const url = result?.data?.url;

    if (
      typeof url !== "string" ||
      !url.startsWith(
        "wss://api.derivws.com/trading/v1/options/ws/"
      )
    ) {
      throw new Error("Deriv returned an invalid WebSocket URL.");
    }

    return url;
  }

  window.DerivAuth = {
    CLIENT_ID,
    SITE,
    REDIRECT_URI,

    login,
    logout,
    saveToken,
    getToken,

    readPkce,
    clearPkce,

    getAccounts,
    setSelectedAccount,
    getSelectedAccount,
    getWebSocketUrl,

    isLoggedIn: function () {
      return !!getToken();
    }
  };

})();
