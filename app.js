
/* ==========================================================
   TradersKit — Deriv Options API Dashboard
   Canonical domain: https://traderskit.site

   This version:
   - Uses the new Deriv Options API WebSocket
   - Uses DerivAuth for OAuth and account authentication
   - Supports demo-account connections
   - Streams market ticks and calculates digit statistics
   - Displays account balance
   - Keeps the existing dashboard controls
   - DOES NOT PLACE TRADES YET
   ========================================================== */

// ---------- Settings ----------
const API_BASE = "https://api.derivws.com";
const PUBLIC_WS_URL =
  "wss://api.derivws.com/trading/v1/options/ws/public";

const MAX_TICKS = 50;
const MAX_STAKE = 10;
const MAX_SESSION_LOSS = 10;
const MAX_TRADES = 50;

const RECONNECT_DELAY = 5000;

// ---------- State ----------
let ws = null;
let digitHistory = [];
let pipSize = 2;
let currentSymbol = "1HZ100V";

let isAuthorized = false;
let botRunning = false;
let tradeInProgress = false;

let sessionProfit = 0;
let tradesDone = 0;

let reconnectTimer = null;
let connectionAttempt = 0;
let manuallyDisconnected = false;

const handledContracts = new Set();

// ---------- Helpers ----------
function getElement(id) {
  return document.getElementById(id);
}

function sendMessage(message) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    logMessage("WebSocket is not connected.", "#ff3b30");
    return false;
  }

  ws.send(JSON.stringify(message));
  return true;
}

function formatMoney(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return "0.00";
  }

  return number.toFixed(2);
}

// ---------- Log box ----------
function logMessage(message, color) {
  const box = getElement("trade-log");

  if (!box) return;

  if (!box.dataset.started) {
    box.textContent = "";
    box.dataset.started = "1";
  }

  const line = document.createElement("div");

  line.textContent =
    `[${new Date().toLocaleTimeString()}] ${message}`;

  if (color) {
    line.style.color = color;
  }

  box.appendChild(line);

  while (box.children.length > 100) {
    box.removeChild(box.firstChild);
  }

  box.scrollTop = box.scrollHeight;
}

// ---------- Dashboard initialization ----------
function initApp() {
  buildDigitGrid();
  setupEventListeners();

  const marketSelect = getElement("market-select");

  if (marketSelect && marketSelect.value) {
    currentSymbol = marketSelect.value;
  }

  const loginBtn = getElement("oauth-login-btn");

  if (loginBtn) {
    loginBtn.addEventListener("click", async function (event) {
      event.preventDefault();

      if (!window.DerivAuth) {
        logMessage(
          "Authentication helper is missing. Check deriv-auth.js.",
          "#ff3b30"
        );
        return;
      }

      try {
        await DerivAuth.login();
      } catch (error) {
        logMessage(
          "Could not start Deriv login: " + error.message,
          "#ff3b30"
        );
      }
    });
  }

  connectWebSocket();
}

// ---------- Digit grid ----------
function buildDigitGrid() {
  const grid = getElement("digit-grid");

  if (!grid) return;

  grid.innerHTML = "";

  for (let i = 0; i <= 9; i++) {
    const card = document.createElement("div");

    card.className = "digit-box-card";
    card.id = `digit-card-${i}`;

    card.innerHTML = `
      <strong style="font-size:1.2rem;">${i}</strong>
      <br>
      <span
        id="digit-pct-${i}"
        style="font-size:0.78rem;color:var(--text-muted);"
      >0.0%</span>
    `;

    grid.appendChild(card);
  }
}

// ---------- Account information ----------
async function getDemoAccountDetails() {
  if (!window.DerivAuth || !DerivAuth.isLoggedIn()) {
    return null;
  }

  const selectedAccount = DerivAuth.getSelectedAccount();

  if (!selectedAccount) {
    throw new Error(
      "No selected account. Please log in and select a demo account."
    );
  }

  const accounts = await DerivAuth.getAccounts();

  const account = accounts.find(function (item) {
    return String(item.account_id) === String(selectedAccount);
  });

  if (!account) {
    throw new Error(
      "The selected account could not be found. Please log in again."
    );
  }

  const accountType = String(account.account_type || "").toLowerCase();

  if (accountType !== "demo") {
    throw new Error(
      "TradersKit currently permits demo accounts only."
    );
  }

  return account;
}

function displayAccount(account) {
  const loginBtn = getElement("oauth-login-btn");
  const accountPill = getElement("account-pill");
  const currencyElement = getElement("acc-currency");
  const balanceElement = getElement("acc-balance");

  if (loginBtn) {
    loginBtn.style.display = "none";
  }

  if (accountPill) {
    accountPill.style.display = "flex";
  }

  if (currencyElement) {
    currencyElement.textContent = account.currency || "USD";
  }

  if (balanceElement && account.balance !== undefined) {
    balanceElement.textContent = formatMoney(account.balance);
  }

  logMessage(
    "Selected demo account: " +
    (account.account_id || "Demo account"),
    "#34c759"
  );
}

function updateBalance(balanceData) {
  const balanceElement = getElement("acc-balance");

  if (!balanceElement || !balanceData) return;

  balanceElement.textContent = formatMoney(balanceData.balance);

  const currencyElement = getElement("acc-currency");

  if (currencyElement && balanceData.currency) {
    currencyElement.textContent = balanceData.currency;
  }
}

// ---------- WebSocket connection ----------
async function connectWebSocket() {
  if (manuallyDisconnected) return;

  const attempt = ++connectionAttempt;

  try {
    let socketUrl = PUBLIC_WS_URL;
    let demoAccount = null;

    // If logged in, obtain an authenticated demo connection.
    if (
      window.DerivAuth &&
      DerivAuth.isLoggedIn() &&
      DerivAuth.getSelectedAccount()
    ) {
      logMessage(
        "Checking selected Deriv demo account...",
        "#32ade6"
      );

      demoAccount = await getDemoAccountDetails();

      if (attempt !== connectionAttempt) return;

      displayAccount(demoAccount);

      socketUrl = await DerivAuth.getWebSocketUrl(
        String(demoAccount.account_id)
      );

      if (attempt !== connectionAttempt) return;

      isAuthorized = true;
    } else {
      isAuthorized = false;

      logMessage(
        "Connecting to public market data. Log in to connect your demo account.",
        "#94a3b8"
      );
    }

    logMessage(
      "Connecting to Deriv Options WebSocket...",
      "#32ade6"
    );

    ws = new WebSocket(socketUrl);

    ws.onopen = function () {
      if (attempt !== connectionAttempt) return;

      logMessage(
        isAuthorized
          ? "Connected to your Deriv demo account."
          : "Connected to public Deriv market data.",
        "#34c759"
      );

      // Request account balance only on an authenticated connection.
      if (isAuthorized) {
        sendMessage({
          balance: 1,
          subscribe: 1,
          req_id: 1001
        });
      }

      subscribeTicks(currentSymbol);
    };

    ws.onmessage = function (event) {
      if (attempt !== connectionAttempt) return;

      let data;

      try {
        data = JSON.parse(event.data);
      } catch (error) {
        logMessage("Received an unreadable API response.", "#ff3b30");
        return;
      }

      handleWebSocketMessage(data);
    };

    ws.onerror = function () {
      if (attempt !== connectionAttempt) return;

      logMessage(
        "WebSocket connection error. Check your internet connection.",
        "#ff3b30"
      );
    };

    ws.onclose = function () {
      if (attempt !== connectionAttempt) return;

      isAuthorized = false;
      tradeInProgress = false;

      if (botRunning) {
        stopBot("Connection lost. Bot stopped for safety.");
      }

      logMessage(
        "Connection closed. Reconnecting shortly...",
        "#ff3b30"
      );

      scheduleReconnect();
    };

  } catch (error) {
    if (attempt !== connectionAttempt) return;

    isAuthorized = false;

    logMessage(
      "Connection setup failed: " + error.message,
      "#ff3b30"
    );

    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (manuallyDisconnected) return;

  clearTimeout(reconnectTimer);

  reconnectTimer = setTimeout(function () {
    connectWebSocket();
  }, RECONNECT_DELAY);
}

// ---------- WebSocket message handling ----------
function handleWebSocketMessage(data) {
  if (data.error) {
    const message =
      data.error.message || "Unknown Deriv API error.";

    logMessage("Deriv API: " + message, "#ff3b30");

    if (data.msg_type === "balance") {
      logMessage(
        "Could not retrieve account balance.",
        "#ff3b30"
      );
    }

    if (data.msg_type === "buy") {
      tradeInProgress = false;
      stopBot("Bot stopped after a trade error.");
    }

    return;
  }

  // Historical tick data
  if (data.msg_type === "history") {
    handleHistory(data);
    return;
  }

  // Live tick
  if (data.msg_type === "tick") {
    if (data.tick) {
      handleTick(data.tick);
    }
    return;
  }

  // Account balance
  if (data.msg_type === "balance") {
    updateBalance(data.balance);
    return;
  }

  // Connection and subscription information
  if (data.msg_type === "ping") {
    return;
  }

  // Trading messages are intentionally not activated in this version.
  if (
    data.msg_type === "proposal" ||
    data.msg_type === "buy" ||
    data.msg_type === "proposal_open_contract"
  ) {
    logMessage(
      "Trading response received. Order execution is currently disabled.",
      "#f59e0b"
    );
  }
}

// ---------- Tick history ----------
function handleHistory(data) {
  if (!data.history || !Array.isArray(data.history.prices)) {
    return;
  }

  if (
    data.echo_req &&
    data.echo_req.ticks_history &&
    data.echo_req.ticks_history !== currentSymbol
  ) {
    return;
  }

  if (data.pip_size !== undefined) {
    pipSize = Number(data.pip_size);
  }

  const prices = data.history.prices;

  digitHistory = prices
    .slice(-MAX_TICKS)
    .map(lastDigitOf);

  if (prices.length > 0) {
    const quoteElement = getElement("live-quote-display");

    if (quoteElement) {
      quoteElement.textContent =
        Number(prices[prices.length - 1]).toFixed(pipSize);
    }
  }

  updateDigitAnalytics(
    digitHistory[digitHistory.length - 1]
  );

  logMessage(
    "Loaded " + digitHistory.length + " historical ticks.",
    "#94a3b8"
  );
}

// ---------- Subscribe to market ticks ----------
function subscribeTicks(symbol) {
  if (!symbol) return;

  currentSymbol = symbol;
  digitHistory = [];

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }

  // Clear the previous tick subscription.
  sendMessage({
    forget_all: "ticks"
  });

  // Load recent history.
  sendMessage({
    ticks_history: symbol,
    count: MAX_TICKS,
    end: "latest",
    style: "ticks"
  });

  // Subscribe to new ticks.
  sendMessage({
    ticks: symbol,
    subscribe: 1
  });

  logMessage(
    "Subscribed to market: " + symbol,
    "#32ade6"
  );
}

// ---------- Last digit ----------
function lastDigitOf(price) {
  const formatted = Number(price).toFixed(pipSize);

  return parseInt(formatted.slice(-1), 10);
}

// ---------- Live tick handling ----------
function handleTick(tick) {
  if (!tick || tick.symbol !== currentSymbol) {
    return;
  }

  if (tick.pip_size !== undefined) {
    pipSize = Number(tick.pip_size);
  }

  const quote = Number(tick.quote);

  if (!Number.isFinite(quote)) return;

  const quoteString = quote.toFixed(pipSize);
  const lastDigit = parseInt(quoteString.slice(-1), 10);

  const quoteElement = getElement("live-quote-display");

  if (quoteElement) {
    quoteElement.textContent = quoteString;
  }

  digitHistory.push(lastDigit);

  if (digitHistory.length > MAX_TICKS) {
    digitHistory.shift();
  }

  updateDigitAnalytics(lastDigit);
}

// ---------- Digit analytics ----------
function updateDigitAnalytics(latestDigit) {
  if (digitHistory.length === 0) return;

  const counts = Array(10).fill(0);

  digitHistory.forEach(function (digit) {
    if (digit >= 0 && digit <= 9) {
      counts[digit]++;
    }
  });

  const total = digitHistory.length;
  const maxCount = Math.max(...counts);
  const minCount = Math.min(...counts);

  for (let i = 0; i <= 9; i++) {
    const percentage =
      ((counts[i] / total) * 100).toFixed(1);

    const percentageElement = getElement(`digit-pct-${i}`);
    const card = getElement(`digit-card-${i}`);

    if (percentageElement) {
      percentageElement.textContent = percentage + "%";
    }

    if (!card) continue;

    card.style.borderColor = "var(--border)";
    card.style.transform = "scale(1)";

    if (counts[i] === maxCount && maxCount > 0) {
      card.style.borderColor = "var(--green)";
    }

    if (counts[i] === minCount) {
      card.style.borderColor = "var(--red)";
    }

    if (i === latestDigit) {
      card.style.borderColor = "var(--cyan)";
      card.style.transform = "scale(1.05)";
    }
  }
}

// ---------- Bot controls ----------
function setRunButton(running) {
  const runBtn = getElement("run-bot-btn");

  if (!runBtn) return;

  if (running) {
    runBtn.textContent = "■ Stop Bot";
    runBtn.style.background = "var(--red)";
  } else {
    runBtn.textContent = "▶ Run Bot";
    runBtn.style.background = "";
  }
}

function stopBot(reason) {
  botRunning = false;
  setRunButton(false);

  if (reason) {
    logMessage(reason, "#f59e0b");
  }
}

function checkLimits() {
  if (!botRunning) return;

  if (sessionProfit <= -MAX_SESSION_LOSS) {
    stopBot(
      `Loss limit reached (${MAX_SESSION_LOSS}). Bot stopped.`
    );
  } else if (tradesDone >= MAX_TRADES) {
    stopBot(
      `Trade limit reached (${MAX_TRADES}). Bot stopped.`
    );
  }
}

function readStake() {
  const input = getElement("stake-input");

  if (!input) return NaN;

  return parseFloat(input.value);
}

// Trading intentionally disabled until contract compatibility
// and the complete proposal/buy workflow have been verified.
function executeTrade() {
  stopBot(
    "Automated trading is not enabled in this dashboard version."
  );
}

// ---------- Event listeners ----------
function setupEventListeners() {
  // Mobile menu
  const menuToggle = getElement("menu-toggle-btn");
  const navTabs = getElement("nav-tabs-container");

  if (menuToggle && navTabs) {
    menuToggle.addEventListener("click", function () {
      navTabs.classList.toggle("mobile-open");
    });
  }

  // Market selector
  const marketSelect = getElement("market-select");

  if (marketSelect) {
    marketSelect.addEventListener("change", function (event) {
      subscribeTicks(event.target.value);
    });
  }

  // Run / Stop button
  const runBtn = getElement("run-bot-btn");

  if (runBtn) {
    runBtn.addEventListener("click", function () {
      if (botRunning) {
        stopBot("Bot stopped by user.");
        return;
      }

      if (!isAuthorized) {
        alert(
          "Please log in and select your Deriv demo account first."
        );
        return;
      }

      const stake = readStake();

      if (!(stake > 0) || stake > MAX_STAKE) {
        logMessage(
          `Enter a stake above 0 and up to ${MAX_STAKE}.`,
          "#f59e0b"
        );
        return;
      }

      logMessage(
        "The bot interface is ready, but order execution is disabled while the new API trading workflow is being verified.",
        "#f59e0b"
      );
    });
  }

  // Withdraw
  const withdrawBtn = getElement("withdraw-btn");

  if (withdrawBtn) {
    withdrawBtn.addEventListener("click", function () {
      window.location.href = "https://app.deriv.com/cashier";
    });
  }

  // AI statistics button
  const aiBtn = getElement("ai-assistant-btn");

  if (aiBtn) {
    aiBtn.addEventListener("click", function () {
      const count = digitHistory.length;

      if (count < 2) {
        logMessage(
          "Pro AI: waiting for more market ticks...",
          "#8b5cf6"
        );
        return;
      }

      const evenCount = digitHistory.filter(function (digit) {
        return digit % 2 === 0;
      }).length;

      const evenPercentage =
        ((evenCount / count) * 100).toFixed(1);

      const oddPercentage =
        (100 - Number(evenPercentage)).toFixed(1);

      logMessage(
        `Pro AI: last ${count} ticks were ${evenPercentage}% even and ${oddPercentage}% odd. Statistics only, not a prediction.`,
        "#8b5cf6"
      );
    });
  }
}

// ---------- Start dashboard ----------
document.addEventListener("DOMContentLoaded", initApp);
