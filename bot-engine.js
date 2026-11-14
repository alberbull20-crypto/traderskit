/* bot-engine.js
   Shared bot engine for trading-bots.html and bot-builder.html.
   It connects to Deriv, watches live ticks and places 1-tick digit trades
   for a strategy, always inside the hard safety limits below. */

(function () {
  "use strict";

  // ---------- Settings you can change ----------
  const APP_ID = 1089; // Replace with your own app ID once your app is registered
  const WS_URL = "wss://ws.derivws.com/websockets/v3?app_id=" + APP_ID;
  const TOKEN_KEY = "dp_token"; // login token, kept only for this browser tab
  const KEEP_DIGITS = 50;

  const LIMITS = {
    maxStake: 10,            // no single trade may stake more than this
    maxLoss: 50,             // a stop loss above this is refused
    maxTrades: 200,          // a trade limit above this is refused
    maxMartingaleSteps: 4,   // most multiplied trades in a row
    maxMultiplier: 3         // biggest stake multiplier after a loss
  };

  const CONTRACT_TYPES = ["DIGITOVER", "DIGITUNDER", "DIGITEVEN", "DIGITODD"];

  // ---------- State ----------
  let ws = null;
  let hooks = { log: function () {}, update: function () {} };

  const state = {
    connected: false,
    authorized: false,
    account: null,
    symbol: "R_100",
    pip: 2,
    digits: [],
    quote: null,
    running: false,
    tradeInProgress: false,
    strategy: null,
    settings: null,
    stake: 0,
    profit: 0,
    trades: 0,
    wins: 0,
    losses: 0,
    step: 0
  };
  const handled = new Set();

  // ---------- Small helpers ----------
  function round2(n) { return Math.round(n * 100) / 100; }

  function log(text, color) { hooks.log(text, color || ""); }

  function getToken() {
    try { return sessionStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
  }

  function clearToken() {
    try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function snapshot() {
    return {
      connected: state.connected,
      authorized: state.authorized,
      account: state.account ? Object.assign({}, state.account) : null,
      symbol: state.symbol,
      quote: state.quote,
      digits: state.digits.slice(),
      running: state.running,
      tradeInProgress: state.tradeInProgress,
      strategyName: state.strategy ? state.strategy.name : "",
      stake: state.stake,
      profit: round2(state.profit),
      trades: state.trades,
      wins: state.wins,
      losses: state.losses,
      step: state.step
    };
  }

  function emit() { hooks.update(snapshot()); }

  function digitOf(price) {
    return parseInt(Number(price).toFixed(state.pip).slice(-1), 10);
  }

  // ---------- Descriptions (used by the pages) ----------
  function chance(contract) {
    if (contract.type === "DIGITOVER") return (9 - contract.barrier) * 10;
    if (contract.type === "DIGITUNDER") return contract.barrier * 10;
    return 50;
  }

  function describeContract(c) {
    if (c.type === "DIGITOVER") return "Digit Over " + c.barrier;
    if (c.type === "DIGITUNDER") return "Digit Under " + c.barrier;
    if (c.type === "DIGITEVEN") return "Digit Even";
    return "Digit Odd";
  }

  function describeEntry(e) {
    if (!e || e.kind === "always") return "Trades on every tick";
    const n = e.length;
    const digits = n === 1 ? "digit" : "digits";
    if (e.test === "le") return "Waits for " + n + " " + digits + " in a row at or below " + e.value;
    if (e.test === "ge") return "Waits for " + n + " " + digits + " in a row at or above " + e.value;
    if (e.test === "even") return "Waits for " + n + " even " + digits + " in a row";
    return "Waits for " + n + " odd " + digits + " in a row";
  }

  // ---------- Strategy rules ----------
  function passes(test, value, d) {
    if (test === "le") return d <= value;
    if (test === "ge") return d >= value;
    if (test === "even") return d % 2 === 0;
    if (test === "odd") return d % 2 === 1;
    return false;
  }

  function entryMet(strategy) {
    const e = strategy.entry;
    if (!e || e.kind === "always") return true;
    if (e.kind === "streak") {
      if (state.digits.length < e.length) return false;
      const recent = state.digits.slice(-e.length);
      return recent.every(function (d) { return passes(e.test, e.value, d); });
    }
    return false;
  }

  function validate(strategy, s) {
    if (!strategy || !strategy.contract) return "No bot selected.";
    const c = strategy.contract;
    if (CONTRACT_TYPES.indexOf(c.type) === -1) return "Unknown contract type.";
    if (c.type === "DIGITOVER" && !(c.barrier >= 0 && c.barrier <= 8)) return "Over needs a barrier digit from 0 to 8.";
    if (c.type === "DIGITUNDER" && !(c.barrier >= 1 && c.barrier <= 9)) return "Under needs a barrier digit from 1 to 9.";

    const e = strategy.entry;
    if (e && e.kind === "streak") {
      if (!(e.length >= 1 && e.length <= 10)) return "Streak length must be from 1 to 10.";
      if ((e.test === "le" || e.test === "ge") && !(e.value >= 0 && e.value <= 9)) return "Entry digit must be from 0 to 9.";
    }

    if (!(s.stake > 0) || s.stake > LIMITS.maxStake) return "Stake must be above 0 and up to " + LIMITS.maxStake + ".";
    if (!(s.tp > 0)) return "Take profit must be above 0.";
    if (!(s.sl > 0) || s.sl > LIMITS.maxLoss) return "Stop loss must be above 0 and up to " + LIMITS.maxLoss + ".";
    if (!(s.maxTrades >= 1) || s.maxTrades > LIMITS.maxTrades) return "Max trades must be from 1 to " + LIMITS.maxTrades + ".";

    if (s.martingale) {
      if (!(s.multiplier >= 1.1) || s.multiplier > LIMITS.maxMultiplier) {
        return "Multiplier must be from 1.1 to " + LIMITS.maxMultiplier + ".";
      }
      if (!(s.maxSteps >= 1) || s.maxSteps > LIMITS.maxMartingaleSteps) {
        return "Martingale steps must be from 1 to " + LIMITS.maxMartingaleSteps + ".";
      }
      const biggest = s.stake * Math.pow(s.multiplier, s.maxSteps);
      if (biggest > LIMITS.maxStake) {
        return "With these settings the stake could reach " + round2(biggest) + ", above the " + LIMITS.maxStake +
               " cap. Lower the stake, multiplier or steps.";
      }
    }
    return null;
  }

  // ---------- Start and stop ----------
  function start(strategy, settings) {
    if (state.running) return { ok: false, error: "A bot is already running." };
    if (!state.authorized || !state.account) return { ok: false, error: "Log in first." };

    const err = validate(strategy, settings);
    if (err) return { ok: false, error: err };

    if (!state.account.isVirtual && !settings.confirmReal) {
      return { ok: false, error: "Tick the box to confirm you are using a REAL money account." };
    }
    if (settings.stake > state.account.balance) {
      return { ok: false, error: "The stake is larger than your account balance." };
    }

    state.strategy = strategy;
    state.settings = settings;
    state.stake = round2(settings.stake);
    state.profit = 0;
    state.trades = 0;
    state.wins = 0;
    state.losses = 0;
    state.step = 0;
    state.running = true;

    log("Started " + strategy.name + " on " + (state.account.isVirtual ? "DEMO" : "REAL") + " account " + state.account.loginid +
        ". Stake " + state.stake.toFixed(2) + ", TP " + settings.tp + ", SL " + settings.sl +
        ", max " + settings.maxTrades + " trades" +
        (settings.martingale ? ", martingale x" + settings.multiplier + " up to " + settings.maxSteps + " steps." : ", no martingale."),
        "#34c759");
    emit();
    return { ok: true };
  }

  function stop(reason, color) {
    state.running = false;
    if (reason) log(reason, color || "#f59e0b");
    emit();
  }

  // ---------- Trading ----------
  function placeTrade() {
    const c = state.strategy.contract;
    const stake = round2(state.stake);

    if (stake > LIMITS.maxStake) {
      stop("Next stake (" + stake.toFixed(2) + ") is above the " + LIMITS.maxStake + " cap. Bot stopped.", "#ff3b30");
      return;
    }
    if (state.account && stake > state.account.balance) {
      stop("Next stake (" + stake.toFixed(2) + ") is more than your balance. Bot stopped.", "#ff3b30");
      return;
    }

    state.tradeInProgress = true;

    const parameters = {
      amount: stake,
      basis: "stake",
      contract_type: c.type,
      currency: state.account.currency,
      duration: 1,
      duration_unit: "t",
      symbol: state.symbol
    };
    if (c.type === "DIGITOVER" || c.type === "DIGITUNDER") parameters.barrier = String(c.barrier);

    send({ buy: 1, price: stake, parameters: parameters });
    emit();
  }

  function onSettled(contract) {
    if (handled.has(contract.contract_id)) return;
    handled.add(contract.contract_id);

    state.tradeInProgress = false;
    const profit = parseFloat(contract.profit);
    const s = state.settings;
    state.profit += profit;
    state.trades++;

    if (profit > 0) {
      state.wins++;
      state.step = 0;
      state.stake = round2(s.stake);
      log("WIN +" + profit.toFixed(2) + " (exit " + contract.exit_tick_display_value + ")", "#34c759");
    } else {
      state.losses++;
      log("LOSS -" + Math.abs(profit).toFixed(2) + " (exit " + contract.exit_tick_display_value + ")", "#ff3b30");
      if (s.martingale) {
        state.step++;
        state.stake = round2(state.stake * s.multiplier);
      } else {
        state.stake = round2(s.stake);
      }
    }
    log("Session: " + state.trades + " trade(s), P/L " + round2(state.profit).toFixed(2), "#94a3b8");

    if (!state.running) { emit(); return; } // the bot was stopped while this trade was open

    if (state.profit >= s.tp) { stop("Take profit reached (" + round2(state.profit).toFixed(2) + "). Bot stopped.", "#34c759"); return; }
    if (-state.profit >= s.sl) { stop("Stop loss reached (" + round2(state.profit).toFixed(2) + "). Bot stopped.", "#ff3b30"); return; }
    if (state.trades >= s.maxTrades) { stop("Trade limit reached (" + s.maxTrades + "). Bot stopped.", "#f59e0b"); return; }
    if (s.martingale && state.step > s.maxSteps) { stop("Martingale step limit reached. Bot stopped.", "#ff3b30"); return; }

    emit();
  }

  // ---------- Messages from Deriv ----------
  function onMessage(event) {
    const data = JSON.parse(event.data);

    if (data.error) {
      log("API error: " + data.error.message, "#ff3b30");
      if (data.msg_type === "buy") {
        state.tradeInProgress = false;
        if (state.running) stop("Bot stopped after a trade error.", "#f59e0b");
      }
      if (data.msg_type === "authorize") {
        clearToken();
        state.authorized = false;
        state.account = null;
        log("Login expired or not valid. Please log in again.", "#f59e0b");
        emit();
      }
      return;
    }

    if (data.msg_type === "history") {
      if (data.echo_req.ticks_history !== state.symbol) return;
      state.pip = data.pip_size || state.pip;
      const prices = data.history.prices;
      state.digits = prices.map(digitOf).slice(-KEEP_DIGITS);
      state.quote = Number(prices[prices.length - 1]).toFixed(state.pip);
      emit();
      return;
    }

    if (data.msg_type === "tick") {
      const tick = data.tick;
      if (tick.symbol !== state.symbol) return;
      state.pip = tick.pip_size || state.pip;
      state.quote = Number(tick.quote).toFixed(state.pip);
      state.digits.push(digitOf(tick.quote));
      if (state.digits.length > KEEP_DIGITS) state.digits.shift();
      emit();

      if (state.running && !state.tradeInProgress && state.authorized && entryMet(state.strategy)) {
        placeTrade();
      }
      return;
    }

    if (data.msg_type === "authorize") {
      const a = data.authorize;
      state.authorized = true;
      state.account = {
        loginid: a.loginid,
        isVirtual: !!a.is_virtual,
        currency: a.currency,
        balance: Number(a.balance)
      };
      log("Logged in as " + a.loginid + " (" + (a.is_virtual ? "Demo" : "REAL") + ").", "#34c759");
      if (!a.is_virtual) log("WARNING: this is a REAL money account.", "#f59e0b");
      send({ balance: 1, subscribe: 1 });
      emit();
      return;
    }

    if (data.msg_type === "balance") {
      if (state.account) state.account.balance = Number(data.balance.balance);
      emit();
      return;
    }

    if (data.msg_type === "buy") {
      const id = data.buy.contract_id;
      log("Contract #" + id + " opened. Waiting for the result...", "#32ade6");
      send({ proposal_open_contract: 1, contract_id: id, subscribe: 1 });
      return;
    }

    if (data.msg_type === "proposal_open_contract") {
      const c = data.proposal_open_contract;
      if (c && c.is_sold) {
        if (data.subscription) send({ forget: data.subscription.id });
        onSettled(c);
      }
    }
  }

  // ---------- Connection ----------
  function subscribeTicks() {
    state.digits = [];
    send({ forget_all: "ticks" });
    send({ ticks_history: state.symbol, count: KEEP_DIGITS, end: "latest", style: "ticks", subscribe: 1 });
  }

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    ws = new WebSocket(WS_URL);

    ws.onopen = function () {
      state.connected = true;
      subscribeTicks();
      const token = getToken();
      if (token) send({ authorize: token });
      emit();
    };

    ws.onmessage = onMessage;

    ws.onclose = function () {
      state.connected = false;
      state.authorized = false;
      state.account = null;
      state.tradeInProgress = false;
      if (state.running) stop("Connection lost. Bot stopped for safety.", "#f59e0b");
      emit();
      setTimeout(connect, 3000);
    };
  }

  function setMarket(symbol) {
    if (state.running) return false;
    state.symbol = symbol;
    state.quote = null;
    subscribeTicks();
    emit();
    return true;
  }

  function logout() {
    if (state.running) stop("Bot stopped because you disconnected.", "#f59e0b");
    clearToken();
    state.authorized = false;
    state.account = null;
    emit();
    if (ws) ws.close(); // the connection reopens by itself, without a login
  }

  function loginUrl() {
    const redirect = window.location.origin + "/dashboard.html";
    return "https://oauth.deriv.com/oauth2/authorize?app_id=" + APP_ID +
           "&l=EN&brand=deriv&redirect_uri=" + encodeURIComponent(redirect);
  }

  function init(h) {
    hooks = Object.assign({ log: function () {}, update: function () {} }, h || {});
    connect();
    emit();
  }

  window.DPBot = {
    LIMITS: LIMITS,
    init: init,
    setMarket: setMarket,
    start: start,
    stop: stop,
    logout: logout,
    loginUrl: loginUrl,
    hasToken: function () { return !!getToken(); },
    snapshot: snapshot,
    chance: chance,
    describeContract: describeContract,
    describeEntry: describeEntry
  };
})();