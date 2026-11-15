
/* =========================================================
   TradersKit — Deriv OAuth 2.0 Authentication
   Canonical domain: https://traderskit.site
   Supports Demo and Real Options accounts.
   Includes Deriv Wallet balance retrieval.
   ========================================================= */

(function () {
  "use strict";

  // IMPORTANT:
  // Verify this Client ID against your Deriv registered app.
  // Preserved exactly as supplied in your existing file.
  const CLIENT_ID = "34XJmAXXrWNVS1Ya34OOv";

  const SITE = "https://traderskit.site";
  const REDIRECT_URI = SITE + "/callback.html";

  const AUTH_URL = "https://auth.deriv.com/oauth2/auth";
  const API_BASE = "https://api.derivws.com";

  // Wallet API requires the payment scope.
  const SCOPE = "trade payment";

  const TOKEN_KEY = "dp_access_token";
  const EXPIRY_KEY = "dp_token_expires";
  const VERIFIER_KEY = "dp_pkce_verifier";
  const STATE_KEY = "dp_oauth_state";
  const ACCOUNT_KEY = "dp_selected_account";

  // =========================================================
  // PKCE SECURITY
  // =========================================================

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

  // =========================================================
  // LOGIN
  // =========================================================

  async function login() {
    if (window.location.origin !== SITE) {
      alert(
        "Please open TradersKit using https://traderskit.site before logging in."
      );

      return;
    }

    if (!window.crypto || !crypto.subtle) {
      alert(
        "Secure browser features are unavailable. Please use HTTPS."
      );

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

      alert(
        "Could not start secure login. Please try again."
      );
    }
  }

  // =========================================================
  // TOKEN MANAGEMENT
  // =========================================================

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

      const expiry = Number(
        sessionStorage.getItem(EXPIRY_KEY)
      );

      if (!token || !expiry || Date.now() >= expiry) {
        logout();
        return null;
      }

      return token;

    } catch (error) {
      return null;
    }
  }

  // =========================================================
  // PKCE CALLBACK HELPERS
  // =========================================================

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

  // =========================================================
  // LOGOUT
  // =========================================================

  function logout() {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(EXPIRY_KEY);
      sessionStorage.removeItem(ACCOUNT_KEY);

      clearPkce();

    } catch (error) {
      console.error(
        "Could not clear login information:",
        error
      );
    }
  }

  // =========================================================
  // SHARED API RESPONSE HANDLER
  // =========================================================

  async function readApiResponse(response, fallbackMessage) {
    let result;

    try {
      result = await response.json();

    } catch (error) {
      throw new Error(
        "Deriv returned an invalid response."
      );
    }

    if (!response.ok) {
      const message =
        result?.errors?.[0]?.message ||
        result?.error?.message ||
        fallbackMessage;

      throw new Error(message);
    }

    return result;
  }

  // =========================================================
  // OPTIONS ACCOUNT RETRIEVAL
  // =========================================================

  async function getAccounts() {
    const token = getToken();

    if (!token) {
      throw new Error(
        "Your login has expired. Please log in again."
      );
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

    const result = await readApiResponse(
      response,
      "Could not retrieve your Deriv accounts."
    );

    if (Array.isArray(result.data)) {
      return result.data;
    }

    if (
      result.data &&
      typeof result.data === "object"
    ) {
      return [result.data];
    }

    return [];
  }

  // =========================================================
  // SELECTED ACCOUNT
  // =========================================================

  function setSelectedAccount(accountId) {
    if (!accountId || typeof accountId !== "string") {
      throw new Error("Invalid Deriv account ID.");
    }

    sessionStorage.setItem(
      ACCOUNT_KEY,
      accountId
    );
  }

  function getSelectedAccount() {
    try {
      return sessionStorage.getItem(ACCOUNT_KEY);

    } catch (error) {
      return null;
    }
  }

  // =========================================================
  // AUTHENTICATED OPTIONS WEBSOCKET
  // =========================================================

  async function getWebSocketUrl(accountId) {
    const token = getToken();

    if (!token) {
      throw new Error("Please log in again.");
    }

    if (!accountId || typeof accountId !== "string") {
      throw new Error(
        "Please select a Deriv account first."
      );
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

    const result = await readApiResponse(
      response,
      "Could not authenticate the trading connection."
    );

    const url = result?.data?.url;

    if (
      typeof url !== "string" ||
      !url.startsWith(
        "wss://api.derivws.com/trading/v1/options/ws/"
      )
    ) {
      throw new Error(
        "Deriv returned an invalid WebSocket URL."
      );
    }

    return url;
  }

  // =========================================================
  // DERIV WALLET API
  // =========================================================

  /*
    Retrieves all Wallets belonging to the authenticated user.

    Official endpoint:
    GET https://api.derivws.com/wallet/v1/wallets

    Requires OAuth scope:
    payment

    Optional:
    getWallets({ conversion_currency: "USD" })

    Returns the API's data object without assuming
    undocumented wallet response fields.
  */

  async function getWallets(options) {
    const token = getToken();

    if (!token) {
      throw new Error(
        "Your login has expired. Please log in again."
      );
    }

    const params = new URLSearchParams();

    if (
      options &&
      options.conversion_currency
    ) {
      const currency = String(
        options.conversion_currency
      ).toUpperCase();

      if (!/^[A-Z]{3}$/.test(currency)) {
        throw new Error(
          "Invalid conversion currency. Use a three-letter currency code."
        );
      }

      params.set(
        "conversion_currency",
        currency
      );
    }

    const query = params.toString();

    const endpoint =
      API_BASE +
      "/wallet/v1/wallets" +
      (query ? "?" + query : "");

    const response = await fetch(endpoint, {
      method: "GET",

      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/json"
      },

      cache: "no-store"
    });

    const result = await readApiResponse(
      response,
      "Could not retrieve your Deriv Wallet balances."
    );

    return result.data !== undefined
      ? result.data
      : result;
  }

  // =========================================================
  // PUBLIC AUTHENTICATION INTERFACE
  // =========================================================

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

    // Wallet API
    getWallets,

    isLoggedIn: function () {
      return !!getToken();
    }
  };

})();
