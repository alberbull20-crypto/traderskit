
/* =========================================================
   TradersKit — Trading Dashboard
   Deriv Options API
   Demo and Real account connection
   Order execution remains disabled during testing.
   ========================================================= */

(function () {
  "use strict";

  const API_BASE = "https://api.derivws.com";

  const PUBLIC_WS_URL =
    "wss://api.derivws.com/trading/v1/options/ws/public";

  const MAX_TICKS = 50;
  const MAX_STAKE = 10;
  const MAX_SESSION_LOSS = 10;
  const MAX_TRADES = 50;
  const RECONNECT_DELAY = 5000;

  let ws = null;
  let digitHistory = [];
  let pipSize = 2;
  let currentSymbol = "1HZ100V";

  let isAuthorized = false;
  let isConnecting = false;
  let botRunning = false;
  let tradeInProgress = false;

  let sessionProfit = 0;
  let tradesDone = 0;

  let reconnectTimer = null;
  let connectionAttempt = 0;
  let manuallyDisconnected = false;

  let currentAccount = null;
  let currentAccountType = null;

  const handledContracts = new Set();

  const $ = function (id) {
    return document.getElementById(id);
  };

  function setText(id, value) {
    const element = $(id);
    if (element) element.textContent = value;
  }

  function showMessage(message) {
    console.log("[TradersKit]", message);

    const log = $("trade-log");

    if (log) {
      const entry = document.createElement("div");
      entry.textContent =
        new Date().toLocaleTimeString() + " — " + message;

      log.prepend(entry);
    }
  }

  function setConnectionStatus(message, connected) {
    setText("connection-status", message);

    const indicator = $("connection-indicator");

    if (indicator) {
      indicator.style.background = connected
        ? "#20c997"
        : "#ef5350";
    }
  }

  // =========================================================
  // DEPOSIT AND WITHDRAWAL ACCOUNT RESTRICTIONS
  // =========================================================

  function updateFinancialButtons() {
    const depositButton = $("deposit-btn");
    const withdrawButton = $("withdraw-btn");

    const isReal =
      Boolean(currentAccountType) &&
      currentAccountType.includes("real");

    [depositButton, withdrawButton].forEach(function (button) {
      if (!button) return;

      button.disabled = !isReal;

      button.setAttribute(
        "aria-disabled",
        String(!isReal)
      );

      button.style.opacity = isReal ? "1" : "0.5";

      button.style.cursor = isReal
        ? "pointer"
        : "not-allowed";
    });

    let notice = $("account-funding-notice");

    if (!notice) {
      notice = document.createElement("p");

      notice.id = "account-funding-notice";

      notice.style.fontSize = "13px";
      notice.style.marginTop = "8px";
      notice.style.color = "#f59e0b";

      const container =
        (depositButton && depositButton.parentElement) ||
        (withdrawButton && withdrawButton.parentElement);

      if (container) {
        container.appendChild(notice);
      }
    }

    if (notice) {
      if (isReal) {
        notice.textContent = "";
        notice.style.display = "none";
      } else if (
        currentAccountType &&
        currentAccountType.includes("demo")
      ) {
        notice.textContent =
          "Demo account: deposits and withdrawals are unavailable.";

        notice.style.display = "block";
      } else {
        notice.textContent =
          "Connect a Real Deriv account to access deposits and withdrawals.";

        notice.style.display = "block";
      }
    }
  }

  // =========================================================
  // ACCOUNT DISPLAY
  // =========================================================

  function updateAccountDisplay(account) {
    currentAccount = account;

    currentAccountType = String(
      account.account_type || account.type || ""
    ).toLowerCase();

    const loginButton = $("oauth-login-btn");
    const accountPill = $("account-pill");

    if (loginButton) {
      loginButton.style.display = "none";
    }

    if (accountPill) {
      accountPill.style.display = "inline-flex";

      accountPill.textContent =
        currentAccountType.toUpperCase() +
        " • " +
        (account.account_id || "");
    }

    setText(
      "account-balance",
      Number(account.balance || 0).toFixed(2) +
      " " +
      (account.currency || "")
    );

    setText(
      "account-type",
      currentAccountType.toUpperCase()
    );

    updateFinancialButtons();
  }

  function clearAccountDisplay() {
    currentAccount = null;
    currentAccountType = null;
    isAuthorized = false;

    const loginButton = $("oauth-login-btn");
    const accountPill = $("account-pill");

    if (loginButton) {
      loginButton.style.display = "inline-flex";
    }

    if (accountPill) {
      accountPill.style.display = "none";
    }

    setText("account-balance", "--");
    setText("account-type", "NOT CONNECTED");

    updateFinancialButtons();
  }

  async function getSelectedAccountDetails() {
    if (!DerivAuth.isLoggedIn()) {
      return null;
    }

    const selectedAccountId = DerivAuth.getSelectedAccount();

    if (!selectedAccountId) {
      return null;
    }

    const accounts = await DerivAuth.getAccounts();

    const account = accounts.find(function (item) {
      return item.account_id === selectedAccountId;
    });

    if (!account) {
      throw new Error(
        "The selected account was not found. Please select an account again."
      );
    }

    const type = String(
      account.account_type || account.type || ""
    ).toLowerCase();

    if (!type.includes("demo") && !type.includes("real")) {
      throw new Error(
        "Deriv did not identify this account as demo or real."
      );
    }

    return account;
  }

  // =========================================================
  // DIGIT GRID
  // =========================================================

  function createDigitGrid() {
    const grid = $("digit-grid");

    if (!grid) return;

    grid.innerHTML = "";

    for (let digit = 0; digit <= 9; digit++) {
      const item = document.createElement("div");

      item.className = "digit-item";
      item.dataset.digit = digit;

      item.innerHTML =
        '<span class="digit-number">' +
        digit +
        '</span><span class="digit-count">0</span>';

      grid.appendChild(item);
    }
  }

  function updateDigitAnalytics() {
    const counts = Array(10).fill(0);

    digitHistory.forEach(function (digit) {
      counts[digit]++;
    });

    const total = digitHistory.length;

    counts.forEach(function (count, digit) {
      const element = document.querySelector(
        '.digit-item[data-digit="' + digit + '"]'
      );

      if (!element) return;

      const countElement = element.querySelector(".digit-count");

      if (countElement) {
        countElement.textContent =
          total ? ((count / total) * 100).toFixed(0) + "%" : "0%";
      }
    });

    const lastDigit = digitHistory[digitHistory.length - 1];

    if (lastDigit !== undefined) {
      document.querySelectorAll(".digit-item").forEach(function (item) {
        item.classList.remove("last-digit");
      });

      const lastElement = document.querySelector(
        '.digit-item[data-digit="' + lastDigit + '"]'
      );

      if (lastElement) {
        lastElement.classList.add("last-digit");
      }
    }
  }

  function lastDigitOf(quote, precision) {
    const formatted = Number(quote).toFixed(precision);
    const digits = formatted.replace(".", "");

    return Number(digits.slice(-1));
  }

  function handleHistory(message) {
    const history = message.history;

    if (!history || !Array.isArray(history.prices)) return;

    pipSize = Number(message.pip_size || pipSize);

    digitHistory = history.prices.map(function (price) {
      return lastDigitOf(price, pipSize);
    });

    digitHistory = digitHistory.slice(-MAX_TICKS);

    updateDigitAnalytics();
  }

  function handleTick(message) {
    if (!message.tick) return;

    const tick = message.tick;

    const quote = Number(tick.quote);

    if (!Number.isFinite(quote)) return;

    pipSize = Number(tick.pip_size || pipSize);

    const digit = lastDigitOf(quote, pipSize);

    digitHistory.push(digit);

    if (digitHistory.length > MAX_TICKS) {
      digitHistory.shift();
    }

    setText("current-quote", quote.toFixed(pipSize));

    updateDigitAnalytics();
  }

  function handleBalance(message) {
    if (!message.balance) return;

    const balance = message.balance;

    setText(
      "account-balance",
      Number(balance.balance || 0).toFixed(2) +
      " " +
      (balance.currency || "")
    );
  }

  // =========================================================
  // MARKET DATA SUBSCRIPTIONS
  // =========================================================

  function subscribeTicks() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    ws.send(JSON.stringify({
      forget_all: "ticks",
      req_id: 1000
    }));

    ws.send(JSON.stringify({
      ticks_history: currentSymbol,
      count: MAX_TICKS,
      end: "latest",
      style: "ticks",
      req_id: 1001
    }));

    ws.send(JSON.stringify({
      ticks: currentSymbol,
      subscribe: 1,
      req_id: 1002
    }));
  }

  function handleWebSocketMessage(event) {
    let message;

    try {
      message = JSON.parse(event.data);
    } catch (error) {
      console.error("Invalid WebSocket message:", error);
      return;
    }

    if (message.error) {
      showMessage(
        message.error.message || "Deriv API returned an error."
      );

      return;
    }

    if (message.history) {
      handleHistory(message);
      return;
    }

    if (message.tick) {
      handleTick(message);
      return;
    }

    if (message.balance) {
      handleBalance(message);
    }
  }

  // =========================================================
  // WEBSOCKET CONNECTION
  // =========================================================

  async function connectWebSocket() {
    if (isConnecting) return;

    isConnecting = true;
    manuallyDisconnected = false;

    const attempt = ++connectionAttempt;

    clearTimeout(reconnectTimer);

    if (ws) {
      try {
        ws.close();
      } catch (error) {
        console.warn(error);
      }
    }

    isAuthorized = false;

    setConnectionStatus("Connecting...", false);

    try {
      let socketUrl = PUBLIC_WS_URL;
      let account = null;
      let authenticated = false;

      if (DerivAuth.isLoggedIn()) {
        account = await getSelectedAccountDetails();

        if (account) {
          if (attempt !== connectionAttempt) return;

          socketUrl = await DerivAuth.getWebSocketUrl(
            account.account_id
          );

          authenticated = true;
        }
      }

      if (attempt !== connectionAttempt) return;

      const socket = new WebSocket(socketUrl);

      ws = socket;

      socket.onopen = function () {
        if (attempt !== connectionAttempt) {
          socket.close();
          return;
        }

        isConnecting = false;
        isAuthorized = authenticated;

        if (authenticated && account) {
          updateAccountDisplay(account);

          setConnectionStatus(
            "Connected — " + currentAccountType.toUpperCase(),
            true
          );

          socket.send(JSON.stringify({
            balance: 1,
            subscribe: 1,
            req_id: 1001
          }));

          showMessage(
            "Connected to selected " +
            currentAccountType +
            " account."
          );

        } else {
          clearAccountDisplay();

          setConnectionStatus(
            "Connected — Public Market Data",
            true
          );

          showMessage("Connected to public market data.");
        }

        subscribeTicks();
      };

      socket.onmessage = handleWebSocketMessage;

      socket.onerror = function (error) {
        console.error("WebSocket error:", error);

        setConnectionStatus("Connection error", false);
      };

      socket.onclose = function () {
        if (attempt !== connectionAttempt) return;

        isConnecting = false;
        isAuthorized = false;

        setConnectionStatus("Disconnected", false);

        if (!manuallyDisconnected) {
          reconnectTimer = setTimeout(function () {
            connectWebSocket();
          }, RECONNECT_DELAY);
        }
      };

    } catch (error) {
      isConnecting = false;
      isAuthorized = false;

      console.error("Connection failed:", error);

      showMessage(error.message);

      setConnectionStatus("Connection failed", false);

      if (!manuallyDisconnected) {
        reconnectTimer = setTimeout(function () {
          connectWebSocket();
        }, RECONNECT_DELAY);
      }
    }
  }

  function disconnectWebSocket() {
    manuallyDisconnected = true;

    clearTimeout(reconnectTimer);

    connectionAttempt++;

    if (ws) {
      ws.close();
      ws = null;
    }

    isAuthorized = false;
    isConnecting = false;

    setConnectionStatus("Disconnected", false);
  }

  // =========================================================
  // MARKET SELECTION
  // =========================================================

  function changeMarket() {
    const selector = $("market-select");

    if (!selector) return;

    currentSymbol = selector.value;

    digitHistory = [];

    updateDigitAnalytics();

    if (ws && ws.readyState === WebSocket.OPEN) {
      subscribeTicks();
    }
  }

  // =========================================================
  // BOT SAFETY CONTROLS
  // =========================================================

  function validateStake() {
    const input = $("stake-input");

    if (!input) return false;

    const stake = Number(input.value);

    if (
      !Number.isFinite(stake) ||
      stake <= 0 ||
      stake > MAX_STAKE
    ) {
      alert(
        "Stake must be greater than zero and no more than " +
        MAX_STAKE +
        "."
      );

      return false;
    }

    return true;
  }

  function stopBot(reason) {
    botRunning = false;

    const runButton = $("run-bot-btn");

    if (runButton) {
      runButton.textContent = "Run Bot";
      runButton.classList.remove("running");
    }

    if (reason) {
      showMessage(reason);
    }
  }

  function executeTrade() {
    stopBot(
      "Automated trading is currently disabled. " +
      "We are verifying the Deriv Options trading workflow first."
    );

    return false;
  }

  function toggleBot() {
    if (botRunning) {
      stopBot("Bot stopped.");
      return;
    }

    if (!isAuthorized || !currentAccount) {
      showMessage(
        "Please connect a Deriv demo or real account first."
      );

      return;
    }

    if (!validateStake()) return;

    if (currentAccountType.includes("real")) {
      showMessage(
        "Real account connected. Automated trading is not enabled yet."
      );

      return;
    }

    botRunning = true;

    const runButton = $("run-bot-btn");

    if (runButton) {
      runButton.textContent = "Stop Bot";
      runButton.classList.add("running");
    }

    executeTrade();
  }

  // =========================================================
  // DEPOSIT AND WITHDRAWAL ACTIONS
  // =========================================================

  function openDerivWallet(action) {
    if (
      !currentAccountType ||
      !currentAccountType.includes("real")
    ) {
      showMessage(
        action +
        " is available on Real accounts only."
      );

      updateFinancialButtons();

      return;
    }

    window.open(
      "https://home.deriv.com/dashboard/home",
      "_blank",
      "noopener,noreferrer"
    );
  }

  // =========================================================
  // EVENT LISTENERS
  // =========================================================

  function setupEventListeners() {
    const loginButton = $("oauth-login-btn");

    if (loginButton) {
      loginButton.addEventListener("click", function (event) {
        event.preventDefault();

        DerivAuth.login();
      });
    }

    const logoutButton = $("logout-btn");

    if (logoutButton) {
      logoutButton.addEventListener("click", function () {
        disconnectWebSocket();

        DerivAuth.logout();

        clearAccountDisplay();

        showMessage("Logged out of Deriv.");

        window.location.href = "login.html";
      });
    }

    const marketSelector = $("market-select");

    if (marketSelector) {
      marketSelector.addEventListener("change", changeMarket);

      currentSymbol = marketSelector.value;
    }

    const runButton = $("run-bot-btn");

    if (runButton) {
      runButton.addEventListener("click", toggleBot);
    }

    // WITHDRAW — Official Deriv Wallet
    const withdrawButton = $("withdraw-btn");

    if (withdrawButton) {
      withdrawButton.addEventListener("click", function () {
        openDerivWallet("Withdrawals");
      });
    }

    // DEPOSIT — Official Deriv Wallet
    const depositButton = $("deposit-btn");

    if (depositButton) {
      depositButton.addEventListener("click", function () {
        openDerivWallet("Deposits");
      });
    }

    const aiButton = $("ai-assistant-btn");

    if (aiButton) {
      aiButton.addEventListener("click", function () {
        if (typeof window.openAIAssistant === "function") {
          window.openAIAssistant();
        } else {
          showMessage("AI assistant is not available.");
        }
      });
    }
  }

  // =========================================================
  // INITIALIZATION
  // =========================================================

  async function initApp() {
    createDigitGrid();

    setupEventListeners();

    updateFinancialButtons();

    const loginButton = $("oauth-login-btn");

    if (
      DerivAuth.isLoggedIn() &&
      DerivAuth.getSelectedAccount()
    ) {
      if (loginButton) {
        loginButton.style.display = "none";
      }
    }

    connectWebSocket();
  }

  document.addEventListener("DOMContentLoaded", initApp);

})();
