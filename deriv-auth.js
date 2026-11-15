
/* deriv-auth.js
   TradersKit — Deriv OAuth 2.0 with PKCE
   Canonical domain: https://traderskit.site
*/

(function () {
  "use strict";

  // Your registered Deriv OAuth Client ID
  const CLIENT_ID = "34XJmAXXrWNVS1Ya34OOv";

  // Canonical website settings
  const SITE = "https://traderskit.site";
  const REDIRECT_URI = SITE + "/callback.html";

  // Deriv endpoints
  const AUTH_URL = "https://auth.deriv.com/oauth2/auth";
  const API_BASE = "https://api.derivws.com";

  // Permissions needed for account access and trading
  const SCOPE = "trade";

  // Browser-tab storage keys
  const TOKEN_KEY = "dp_access_token";
  const EXPIRY_KEY = "dp_token_expires";
  const VERIFIER_KEY = "dp_pkce_verifier";
  const STATE_KEY = "dp_oauth_state";
  const ACCOUNT_KEY = "dp_selected_account";

  // Generate a cryptographically secure random string
  function randomString(length) {
    const chars =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

    const bytes = crypto.getRandomValues(new Uint8Array(length));

    return Array.from(bytes, function (b) {
      return chars[b % chars.length];
    }).join("");
  }

  // Generate the SHA-256 PKCE challenge
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

  // Start Deriv OAuth login
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

      window.location.assign(AUTH_URL + "?" + params.toString());

    } catch (error) {
      console.error("Deriv login initialization failed:", error);
      alert("Could not start secure login. Please try again.");
    }
  }

  // Save the OAuth access token for this browser tab
  function saveToken(token, expiresIn) {
    if (!token || typeof token !== "string") {
      throw new Error("Invalid access token.");
    }

    const seconds = Number(expiresIn);

    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new Error("Deriv returned an invalid token expiry.");
    }

    sessionStorage.setItem(TOKEN_KEY, token);

    // Expire one minute early to avoid using an almost-expired token
    sessionStorage.setItem(
      EXPIRY_KEY,
      String(Date.now() + seconds * 1000 - 60000)
    );
  }

  // Read a valid token
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

  // Clear login information
  function logout() {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(EXPIRY_KEY);
      sessionStorage.removeItem(ACCOUNT_KEY);
      clearPkce();
    } catch (error) {
      // Ignore browser storage errors
    }
  }

  // Read PKCE information for callback.html
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

  // Remove PKCE information after successful exchange
  function clearPkce() {
    try {
      sessionStorage.removeItem(VERIFIER_KEY);
      sessionStorage.removeItem(STATE_KEY);
    } catch (error) {
      // Ignore browser storage errors
    }
  }

  // Retrieve the user's Deriv Options accounts
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

    return Array.isArray(result.data) ? result.data : [];
  }

  // Save the selected Deriv account
  function setSelectedAccount(accountId) {
    if (!accountId || typeof accountId !== "string") {
      throw new Error("Invalid Deriv account ID.");
    }

    sessionStorage.setItem(ACCOUNT_KEY, accountId);
  }

  // Read the selected account
  function getSelectedAccount() {
    try {
      return sessionStorage.getItem(ACCOUNT_KEY);
    } catch (error) {
      return null;
    }
  }

  // Request a fresh authenticated WebSocket URL
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

  // Public interface used by the other website files
  window.DerivAuth = {
    CLIENT_ID: CLIENT_ID,
    SITE: SITE,
    REDIRECT_URI: REDIRECT_URI,

    login: login,
    logout: logout,
    saveToken: saveToken,
    getToken: getToken,

    readPkce: readPkce,
    clearPkce: clearPkce,

    getAccounts: getAccounts,
    setSelectedAccount: setSelectedAccount,
    getSelectedAccount: getSelectedAccount,
    getWebSocketUrl: getWebSocketUrl,

    isLoggedIn: function () {
      return !!getToken();
    }
  };

})();
