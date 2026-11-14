// ---------- Settings you can change ----------
const APP_ID = 1089; // Public test App ID. Replace with your own once your app is registered
const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const MAX_TICKS = 50;          // how many recent ticks the digit grid uses
const MAX_STAKE = 10;          // the bot refuses a stake above this
const MAX_SESSION_LOSS = 10;   // the bot stops when total loss reaches this
const MAX_TRADES = 50;         // the bot stops after this many trades
const TOKEN_KEY = "dp_token";  // CHANGED: where the login token is kept for this browser tab

// ---------- State ----------
let ws;
let digitHistory = [];
let pipSize = 2;
let currentSymbol = "";
let isAuthorized = false;
let sessionToken = null;
let botRunning = false;
let tradeInProgress = false;
let sessionProfit = 0;
let tradesDone = 0;
const handledContracts = new Set();

// ---------- Log box ----------
function logMessage(text, color) {
  const box = document.getElementById("trade-log");
  if (!box) return;

  // Clear the starting placeholder text on the first message
  if (!box.dataset.started) {
    box.textContent = "";
    box.dataset.started = "1";
  }

  const line = document.createElement("div");
  line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  if (color) line.style.color = color;
  box.appendChild(line);

  while (box.children.length > 100) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

// ---------- Start ----------
function initApp() {
  // Login URL points back to this page
  const currentRedirect = window.location.href.split("?")[0];
  const oauthUrl = `https://oauth.deriv.com/oauth2/authorize?app_id=${APP_ID}&l=EN&brand=deriv&redirect_uri=${encodeURIComponent(currentRedirect)}`;

  const loginBtn = document.getElementById("oauth-login-btn");
  if (loginBtn) loginBtn.href = oauthUrl;

  // Digit grid
  const grid = document.getElementById("digit-grid");
  if (grid) {
    grid.innerHTML = "";
    for (let i = 0; i <= 9; i++) {
      grid.innerHTML += `
        <div class="digit-box-card" id="digit-card-${i}">
          <strong style="font-size: 1.2rem;">${i}</strong><br>
          <span id="digit-pct-${i}" style="font-size: 0.78rem; color: var(--text-muted);">0.0%</span>
        </div>
      `;
    }
  }

  // CHANGED: if Deriv sent us back with a token, keep it for this tab (so the other pages can use it)
  // and remove it from the address bar. Otherwise reuse the token saved earlier in this tab.
  const urlParams = new URLSearchParams(window.location.search);
  const oauthToken = urlParams.get("token1");
  if (oauthToken) {
    sessionToken = oauthToken;
    try { sessionStorage.setItem(TOKEN_KEY, oauthToken); } catch (e) { /* ignore */ }
    window.history.replaceState({}, document.title, window.location.pathname);
  } else {
    try { sessionToken = sessionStorage.getItem(TOKEN_KEY); } catch (e) { sessionToken = null; }
  }

  connectWebSocket();
  setupEventListeners();
}

// ---------- Connection ----------
function connectWebSocket() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    logMessage("Connected to Deriv live WebSocket.", "#34c759");
    subscribeTicks(document.getElementById("market-select").value);

    if (sessionToken) {
      logMessage("Authorizing user session via Deriv OAuth...", "#32ade6");
      ws.send(JSON.stringify({ authorize: sessionToken }));
    }
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    // ----- Errors -----
    if (data.error) {
      logMessage(`API Error: ${data.error.message}`, "#ff3b30");

      if (data.msg_type === "buy") {
        tradeInProgress = false;
        if (botRunning) stopBot("Bot stopped after a trade error.");
      }
      if (data.msg_type === "authorize") {
        sessionToken = null;
        try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ } // CHANGED
        logMessage("Login failed. Please click Login again.", "#ff3b30");
      }
      return;
    }

    // ----- First batch of recent ticks -----
    if (data.msg_type === "history") {
      if (data.echo_req.ticks_history !== currentSymbol) return;

      pipSize = data.pip_size || pipSize;
      const prices = data.history.prices;
      digitHistory = prices.map(lastDigitOf);

      document.getElementById("live-quote-display").textContent =
        Number(prices[prices.length - 1]).toFixed(pipSize);
      updateDigitAnalytics(digitHistory[digitHistory.length - 1]);
      return;
    }

    // ----- New tick -----
    if (data.msg_type === "tick") {
      handleTick(data.tick);
      return;
    }

    // ----- Login worked -----
    if (data.msg_type === "authorize") {
      isAuthorized = true;
      const auth = data.authorize;

      const loginBtn = document.getElementById("oauth-login-btn");
      if (loginBtn) loginBtn.style.display = "none";

      const accountPill = document.getElementById("account-pill");
      if (accountPill) accountPill.style.display = "flex";

      document.getElementById("acc-currency").textContent = auth.currency;
      document.getElementById("acc-balance").textContent = auth.balance.toFixed(2);

      logMessage(`Successfully logged in as ${auth.loginid} (${auth.is_virtual ? "Demo" : "Real"})`, "#34c759");
      if (!auth.is_virtual) {
        logMessage("WARNING: this is a REAL money account. Trades here use real money.", "#f59e0b");
      }
      ws.send(JSON.stringify({ balance: 1, subscribe: 1 }));
      return;
    }

    // ----- Balance update -----
    if (data.msg_type === "balance") {
      document.getElementById("acc-balance").textContent = data.balance.balance.toFixed(2);
      return;
    }

    // ----- Trade placed -----
    if (data.msg_type === "buy") {
      const contractId = data.buy.contract_id;
      logMessage(`Contract #${contractId} executed. Monitoring outcome...`, "#32ade6");
      ws.send(JSON.stringify({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 }));
      return;
    }

    // ----- Trade finished -----
    if (data.msg_type === "proposal_open_contract") {
      const contract = data.proposal_open_contract;

      if (contract.is_sold && !handledContracts.has(contract.contract_id)) {
        handledContracts.add(contract.contract_id);
        if (data.subscription) ws.send(JSON.stringify({ forget: data.subscription.id }));

        tradeInProgress = false;
        const profit = parseFloat(contract.profit);
        sessionProfit += profit;
        tradesDone++;

        if (profit > 0) {
          logMessage(`WIN +$${profit.toFixed(2)} (Exit: ${contract.exit_tick_display_value})`, "#34c759");
        } else {
          logMessage(`LOSS -$${Math.abs(profit).toFixed(2)} (Exit: ${contract.exit_tick_display_value})`, "#ff3b30");
        }
        logMessage(`Session: ${tradesDone} trade(s), total P/L ${sessionProfit.toFixed(2)}`, "#94a3b8");

        checkLimits();
      }
    }
  };

  ws.onclose = () => {
    isAuthorized = false;
    tradeInProgress = false;
    if (botRunning) stopBot("Connection lost. Bot stopped for safety.");
    logMessage("Connection lost. Reconnecting...", "#ff3b30");
    setTimeout(connectWebSocket, 3000);
  };
}

// ---------- Ticks and digits ----------
function subscribeTicks(symbol) {
  currentSymbol = symbol;
  digitHistory = [];
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  ws.send(JSON.stringify({ forget_all: "ticks" }));
  ws.send(JSON.stringify({
    ticks_history: symbol,
    count: MAX_TICKS,
    end: "latest",
    style: "ticks",
    subscribe: 1
  }));
}

function lastDigitOf(price) {
  return parseInt(Number(price).toFixed(pipSize).slice(-1), 10);
}

function handleTick(tick) {
  if (tick.symbol !== currentSymbol) return; // ignore ticks from a market we left

  pipSize = tick.pip_size || pipSize;
  const quoteStr = Number(tick.quote).toFixed(pipSize);
  const lastDigit = parseInt(quoteStr.slice(-1), 10);

  document.getElementById("live-quote-display").textContent = quoteStr;

  digitHistory.push(lastDigit);
  if (digitHistory.length > MAX_TICKS) digitHistory.shift();

  updateDigitAnalytics(lastDigit);

  if (botRunning && !tradeInProgress && isAuthorized) {
    executeTrade();
  }
}

function updateDigitAnalytics(latestDigit) {
  const counts = Array(10).fill(0);
  digitHistory.forEach(d => counts[d]++);
  const total = digitHistory.length || 1;
  const maxC = Math.max(...counts);
  const minC = Math.min(...counts);

  for (let i = 0; i <= 9; i++) {
    const pct = ((counts[i] / total) * 100).toFixed(1);
    const card = document.getElementById(`digit-card-${i}`);
    document.getElementById(`digit-pct-${i}`).textContent = `${pct}%`;

    card.style.borderColor = "var(--border)";
    card.style.transform = "scale(1)";

    if (counts[i] === maxC && maxC > 0) card.style.borderColor = "var(--green)";
    if (counts[i] === minC) card.style.borderColor = "var(--red)";
    if (i === latestDigit) {
      card.style.borderColor = "var(--cyan)";
      card.style.transform = "scale(1.05)";
    }
  }
}

// ---------- Bot ----------
function setRunButton(running) {
  const runBtn = document.getElementById("run-bot-btn");
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
  if (reason) logMessage(reason, "#f59e0b");
}

function checkLimits() {
  if (!botRunning) return;
  if (sessionProfit <= -MAX_SESSION_LOSS) {
    stopBot(`Loss limit reached (${MAX_SESSION_LOSS}). Bot stopped.`);
  } else if (tradesDone >= MAX_TRADES) {
    stopBot(`Trade limit reached (${MAX_TRADES}). Bot stopped.`);
  }
}

function readStake() {
  return parseFloat(document.getElementById("stake-input").value);
}

function executeTrade() {
  if (!isAuthorized || tradeInProgress) return;

  const stake = readStake();
  if (!(stake > 0) || stake > MAX_STAKE) {
    stopBot(`Invalid stake. Enter an amount above 0 and up to ${MAX_STAKE}. Bot stopped.`);
    return;
  }

  tradeInProgress = true;

  const symbol = document.getElementById("market-select").value;
  const contractType = document.getElementById("contract-select").value;

  const parameters = {
    amount: Number(stake.toFixed(2)),
    basis: "stake",
    contract_type: contractType,
    currency: document.getElementById("acc-currency").textContent || "USD",
    duration: 1,
    duration_unit: "t",
    symbol: symbol
  };

  if (contractType === "DIGITOVER") parameters.barrier = "4";
  if (contractType === "DIGITUNDER") parameters.barrier = "5";

  ws.send(JSON.stringify({ buy: 1, price: Number(stake.toFixed(2)), parameters }));
}

// ---------- Buttons ----------
function setupEventListeners() {
  // Mobile hamburger menu
  const menuToggle = document.getElementById("menu-toggle-btn");
  const navTabs = document.getElementById("nav-tabs-container");
  if (menuToggle && navTabs) {
    menuToggle.addEventListener("click", () => {
      navTabs.classList.toggle("mobile-open");
    });
  }

  // Market picker
  const marketSelect = document.getElementById("market-select");
  if (marketSelect) {
    marketSelect.addEventListener("change", (e) => {
      subscribeTicks(e.target.value);
    });
  }

  // Run / Stop
  const runBtn = document.getElementById("run-bot-btn");
  if (runBtn) {
    runBtn.addEventListener("click", () => {
      if (botRunning) {
        stopBot("Bot stopped by user.");
        return;
      }

      if (!isAuthorized) {
        alert("Please click 'Login' in the top right corner before running the bot!");
        return;
      }

      const stake = readStake();
      if (!(stake > 0) || stake > MAX_STAKE) {
        logMessage(`Enter a stake above 0 and up to ${MAX_STAKE} before running the bot.`, "#f59e0b");
        return;
      }

      sessionProfit = 0;
      tradesDone = 0;
      botRunning = true;
      setRunButton(true);
      logMessage(`Automated bot started. Limits: loss ${MAX_SESSION_LOSS}, ${MAX_TRADES} trades, stake up to ${MAX_STAKE}.`, "#34c759");
    });
  }

  // Withdraw
  const withdrawBtn = document.getElementById("withdraw-btn");
  if (withdrawBtn) {
    withdrawBtn.addEventListener("click", () => {
      window.location.href = "https://app.deriv.com/cashier";
    });
  }

  // AI button: shows real numbers from the recent ticks
  const aiBtn = document.getElementById("ai-assistant-btn");
  if (aiBtn) {
    aiBtn.addEventListener("click", () => {
      const n = digitHistory.length;
      if (n < 2) {
        logMessage("Pro AI: waiting for ticks...", "#8b5cf6");
        return;
      }
      const even = digitHistory.filter(d => d % 2 === 0).length;
      const evenPct = ((even / n) * 100).toFixed(1);
      const oddPct = (100 - evenPct).toFixed(1);
      logMessage(`Pro AI: last ${n} ticks were ${evenPct}% even and ${oddPct}% odd. Statistics only, not a prediction.`, "#8b5cf6");
    });
  }
}

initApp();