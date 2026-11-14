/* ai-assistant.js
   Adds the floating "AI" button and the Entry Scanner window to a page.
   The scanner reads past ticks of 10 volatility markets, counts how often each
   Over/Under entry pattern appeared and how the next tick turned out, and compares
   that with plain chance. It never places a trade. */

(function () {
  "use strict";

  // ---------- Settings you can change ----------
  const APP_ID = 1089; // Replace with your own app ID once your app is registered
  const WS_URL = "wss://ws.derivws.com/websockets/v3?app_id=" + APP_ID;
  const PICK_KEY = "dp_scanner_pick"; // hands the chosen bot to trading-bots.html
  const TIP_KEY = "dp_ai_tip_seen";
  const MIN_PATTERNS = 30;            // fewer sightings than this are too few to judge
  const SCAN_TIMEOUT_MS = 20000;

  const MARKETS = [
    { symbol: "R_10",    label: "Volatility 10 Index" },
    { symbol: "R_25",    label: "Volatility 25 Index" },
    { symbol: "R_50",    label: "Volatility 50 Index" },
    { symbol: "R_75",    label: "Volatility 75 Index" },
    { symbol: "R_100",   label: "Volatility 100 Index" },
    { symbol: "1HZ10V",  label: "Volatility 10 (1s) Index" },
    { symbol: "1HZ25V",  label: "Volatility 25 (1s) Index" },
    { symbol: "1HZ50V",  label: "Volatility 50 (1s) Index" },
    { symbol: "1HZ75V",  label: "Volatility 75 (1s) Index" },
    { symbol: "1HZ100V", label: "Volatility 100 (1s) Index" }
  ];

  const PAIRS = [
    { id: "o1u8", label: "Over 1 / Under 8", over: { barrier: 1, length: 3 }, under: { barrier: 8, length: 3 } },
    { id: "o2u7", label: "Over 2 / Under 7", over: { barrier: 2, length: 4 }, under: { barrier: 7, length: 4 } },
    { id: "o3u6", label: "Over 3 / Under 6", over: { barrier: 3, length: 5 }, under: { barrier: 6, length: 5 } }
  ];

  const state = { pair: "o1u8", rows: [], selected: -1, scanning: false };
  let overlay, openerButton;

  function byId(id) { return document.getElementById(id); }

  // ---------- Look of the button and window ----------
  function injectStyles() {
    const css = `
      .floating-ai-btn::after {
        content: ""; position: absolute; inset: -8px; border-radius: 50%;
        border: 2px solid rgba(139, 92, 246, 0.5);
        animation: dpPulse 2.4s ease-out infinite; pointer-events: none;
      }
      @keyframes dpPulse { from { transform: scale(0.9); opacity: 0.9; } to { transform: scale(1.4); opacity: 0; } }
      .floating-ai-btn:focus-visible { outline: 3px solid #a78bfa; outline-offset: 4px; }

      .dp-tip {
        position: fixed; right: 92px; bottom: 30px; max-width: 230px; z-index: 999;
        background: var(--bg-card, #0b101e); border: 1px solid var(--border, #1e2842);
        border-radius: 14px; padding: 12px 14px; font-size: 0.78rem; line-height: 1.5;
        color: var(--text-main, #f1f5f9); box-shadow: 0 12px 30px rgba(0, 0, 0, 0.5);
      }
      .dp-tip b { display: block; margin-bottom: 2px; }
      .dp-tip span { color: var(--text-muted, #8392ad); }

      .dp-overlay {
        position: fixed; inset: 0; z-index: 2000; display: flex; align-items: center; justify-content: center;
        padding: 16px; background: rgba(2, 6, 15, 0.72); backdrop-filter: blur(4px);
      }
      .dp-overlay[hidden] { display: none; }
      .dp-modal {
        width: 100%; max-width: 640px; max-height: 92vh; overflow: auto;
        background: linear-gradient(160deg, #0f1a33, #0a1224); border: 1px solid var(--border, #1e2842);
        border-radius: 20px; box-shadow: 0 30px 80px rgba(0, 0, 0, 0.6);
      }
      .dp-head {
        display: flex; justify-content: space-between; align-items: center; padding: 16px 22px;
        border-bottom: 1px solid var(--border, #1e2842); background: linear-gradient(90deg, #10264a, #0e1c38);
      }
      .dp-head h3 { font-size: 1.15rem; font-weight: 800; color: #fff; }
      .dp-close { background: none; border: none; color: #fff; font-size: 1.7rem; line-height: 1; cursor: pointer; padding: 2px 10px; border-radius: 8px; }
      .dp-close:hover { background: rgba(255, 255, 255, 0.1); }
      .dp-body { padding: 18px 22px 22px; }

      .dp-hero {
        border-radius: 16px; padding: 18px 20px; margin-bottom: 14px;
        background: radial-gradient(circle at 90% 40%, rgba(56, 189, 248, 0.25), transparent 55%), linear-gradient(135deg, #12306b, #0c1a3a);
        border: 1px solid rgba(56, 189, 248, 0.25);
      }
      .dp-tag { display: inline-block; font-size: 0.64rem; font-weight: 800; letter-spacing: 1.5px; color: #67e8f9; border: 1px solid rgba(103, 232, 249, 0.4); padding: 3px 10px; border-radius: 99px; margin-bottom: 8px; }
      .dp-hero h4 { font-size: 1.4rem; font-weight: 800; color: #fff; }
      .dp-hero p { font-size: 0.8rem; color: #b4c0d6; margin-top: 4px; line-height: 1.5; }

      .dp-tabs { display: flex; gap: 6px; background: #0a0f1d; border: 1px solid var(--border, #1e2842); border-radius: 12px; padding: 5px; margin-bottom: 14px; }
      .dp-tab { flex: 1; border: none; background: transparent; color: var(--text-muted, #8392ad); font-weight: 700; font-size: 0.78rem; padding: 10px 6px; border-radius: 9px; cursor: pointer; }
      .dp-tab.active { background: linear-gradient(135deg, #2563eb, #38bdf8); color: #fff; }

      .dp-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px; }
      .dp-box { background: #0a0f1d; border: 1px solid var(--border, #1e2842); border-radius: 12px; padding: 12px 14px; }
      .dp-lbl { display: block; font-size: 0.64rem; font-weight: 800; letter-spacing: 1px; color: var(--text-muted, #8392ad); text-transform: uppercase; margin-bottom: 6px; }
      .dp-box strong { font-size: 0.88rem; color: #fff; }
      .dp-box input { width: 100%; background: var(--bg-element, #131a2e); border: 1px solid var(--border, #1e2842); color: #fff; border-radius: 8px; padding: 8px 10px; font-family: var(--mono, monospace); }

      .dp-status { font-size: 0.8rem; color: #cbd5e1; background: #0a0f1d; border: 1px solid var(--border, #1e2842); border-radius: 12px; padding: 12px 14px; margin-bottom: 12px; line-height: 1.55; }
      .dp-table-wrap { max-height: 230px; overflow: auto; border: 1px solid var(--border, #1e2842); border-radius: 12px; margin-bottom: 12px; }
      .dp-table { width: 100%; border-collapse: collapse; font-size: 0.72rem; font-family: var(--mono, monospace); }
      .dp-table th { position: sticky; top: 0; background: #0e1730; text-align: left; padding: 8px; color: var(--text-muted, #8392ad); font-size: 0.64rem; letter-spacing: 0.5px; }
      .dp-table td { padding: 8px; border-top: 1px solid rgba(255, 255, 255, 0.05); white-space: nowrap; color: #e2e8f0; }
      .dp-table tr[data-i] { cursor: pointer; }
      .dp-table tr.sel { background: rgba(59, 130, 246, 0.2); }
      .dp-table tr.faded { opacity: 0.55; }

      .dp-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      .dp-btn { border: none; border-radius: 12px; padding: 13px; font-weight: 800; font-size: 0.85rem; cursor: pointer; color: #fff; background: linear-gradient(135deg, #2563eb, #38bdf8); }
      .dp-btn.secondary { background: #0a0f1d; border: 1px solid var(--border, #1e2842); color: #cbd5e1; }
      .dp-btn:disabled { opacity: 0.45; cursor: not-allowed; }
      .dp-note { margin-top: 14px; font-size: 0.7rem; line-height: 1.6; color: var(--text-muted, #8392ad); }

      @media (max-width: 520px) { .dp-grid, .dp-actions { grid-template-columns: 1fr; } .dp-tip { display: none; } }
      @media (prefers-reduced-motion: reduce) { .floating-ai-btn::after { animation: none; } }
    `;
    const style = document.createElement("style");
    style.id = "dp-ai-style";
    style.textContent = css;
    document.head.appendChild(style);
  }

  function buildModal() {
    overlay = document.createElement("div");
    overlay.className = "dp-overlay";
    overlay.hidden = true;
    overlay.innerHTML =
      '<div class="dp-modal" role="dialog" aria-modal="true" aria-labelledby="dp-title">' +
        '<div class="dp-head"><h3 id="dp-title">Entry Scanner</h3>' +
          '<button class="dp-close" id="dp-close" aria-label="Close">&times;</button></div>' +
        '<div class="dp-body">' +
          '<div class="dp-hero"><span class="dp-tag">PATTERN SCANNER</span>' +
            '<h4>Digits Scanner</h4>' +
            '<p>Reads past ticks of 10 markets, counts each Over/Under entry pattern and compares the results with plain chance.</p></div>' +
          '<div class="dp-tabs" id="dp-tabs"></div>' +
          '<div class="dp-grid">' +
            '<div class="dp-box"><span class="dp-lbl">Mode</span><strong id="dp-mode">O1 / U8</strong></div>' +
            '<div class="dp-box"><label class="dp-lbl" for="dp-depth">Scan depth (ticks, 100 to 5000)</label>' +
              '<input type="number" id="dp-depth" value="1000" min="100" max="5000" step="100" /></div>' +
          '</div>' +
          '<div class="dp-grid">' +
            '<div class="dp-box"><span class="dp-lbl">Selected market</span><strong id="dp-sel-market">Scan to find the strongest past result</strong></div>' +
            '<div class="dp-box"><span class="dp-lbl">Trade type</span><strong id="dp-sel-type">Waiting for scan</strong></div>' +
          '</div>' +
          '<div class="dp-status" id="dp-status">Not scanned yet</div>' +
          '<div id="dp-results"></div>' +
          '<div class="dp-actions">' +
            '<button class="dp-btn" id="dp-scan">Scan Markets</button>' +
            '<button class="dp-btn secondary" id="dp-load" disabled>Load Scanner Bot</button>' +
          '</div>' +
          '<p class="dp-note">This ranks past results only. Each tick is random, so a strong past result does not make the next tick more likely to win. ' +
            'With 10 markets and 2 sides compared, some results look unusual by chance alone. ' +
            '"Load Scanner Bot" only fills in the Trading Bots page. It does not place a trade. ' +
            'Risk warning: you can lose your whole stake. Only trade with money you can afford to lose.</p>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    // Pair tabs
    byId("dp-tabs").innerHTML = PAIRS.map(function (p) {
      return '<button class="dp-tab' + (p.id === state.pair ? " active" : "") + '" data-pair="' + p.id + '">' + p.label + "</button>";
    }).join("");
    document.querySelectorAll(".dp-tab").forEach(function (tab) {
      tab.addEventListener("click", function () { choosePair(tab.dataset.pair); });
    });

    byId("dp-close").addEventListener("click", closeModal);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) closeModal(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !overlay.hidden) closeModal(); });
    byId("dp-scan").addEventListener("click", scan);
    byId("dp-load").addEventListener("click", loadBot);
  }

  function openModal() {
    hideTip();
    overlay.hidden = false;
    byId("dp-close").focus();
  }

  function closeModal() {
    overlay.hidden = true;
    if (openerButton) openerButton.focus();
  }

  // ---------- Tip bubble ----------
  let tipEl = null;
  function showTip() {
    try { if (sessionStorage.getItem(TIP_KEY)) return; sessionStorage.setItem(TIP_KEY, "1"); } catch (e) { /* ignore */ }
    tipEl = document.createElement("div");
    tipEl.className = "dp-tip";
    tipEl.innerHTML = "<b>AI Market Scanner</b><span>Click to scan 10 markets for entry patterns.</span>";
    document.body.appendChild(tipEl);
    setTimeout(hideTip, 8000);
  }
  function hideTip() {
    if (tipEl && tipEl.parentNode) tipEl.parentNode.removeChild(tipEl);
    tipEl = null;
  }

  // ---------- Pair and pattern rules ----------
  function sideSpec(pair, side) {
    if (side === "over") {
      const b = pair.over.barrier;
      const n = pair.over.length;
      return {
        side: "over", barrier: b, length: n, baseline: (9 - b) * 10, name: "Over " + b,
        entry: n + " digits in a row at or below " + b,
        isPattern: function (d) { return d <= b; },
        isWin: function (d) { return d > b; }
      };
    }
    const b = pair.under.barrier;
    const n = pair.under.length;
    return {
      side: "under", barrier: b, length: n, baseline: b * 10, name: "Under " + b,
      entry: n + " digits in a row at or above " + b,
      isPattern: function (d) { return d >= b; },
      isWin: function (d) { return d < b; }
    };
  }

  function analyse(digits, spec) {
    let triggers = 0;
    let wins = 0;
    for (let i = spec.length; i < digits.length; i++) {
      let ok = true;
      for (let k = i - spec.length; k < i; k++) {
        if (!spec.isPattern(digits[k])) { ok = false; break; }
      }
      if (ok) {
        triggers++;
        if (spec.isWin(digits[i])) wins++;
      }
    }
    const p = spec.baseline / 100;
    const rate = triggers ? wins / triggers : 0;
    const se = triggers ? Math.sqrt((p * (1 - p)) / triggers) : 1;
    const z = triggers ? (rate - p) / se : 0;

    let verdict;
    if (triggers < MIN_PATTERNS) verdict = "Too few";
    else if (z >= 2) verdict = "Above chance";
    else if (z <= -2) verdict = "Below chance";
    else verdict = "In range";

    return { triggers: triggers, wins: wins, rate: rate, z: z, verdict: verdict };
  }

  function choosePair(id) {
    if (state.scanning) return;
    state.pair = id;
    state.rows = [];
    state.selected = -1;
    document.querySelectorAll(".dp-tab").forEach(function (t) {
      t.classList.toggle("active", t.dataset.pair === id);
    });
    const pair = PAIRS.find(function (p) { return p.id === id; });
    byId("dp-mode").textContent = "O" + pair.over.barrier + " / U" + pair.under.barrier;
    setStatus("Not scanned yet");
    renderResults();
    updatePick();
  }

  // ---------- Scanning ----------
  function setStatus(text) { byId("dp-status").textContent = text; }

  function scan() {
    if (state.scanning) return;

    const depthInput = byId("dp-depth");
    let depth = parseInt(depthInput.value, 10);
    if (!depth) depth = 1000;
    depth = Math.min(5000, Math.max(100, depth));
    depthInput.value = depth;

    state.scanning = true;
    state.rows = [];
    state.selected = -1;
    renderResults();
    updatePick();
    setStatus("Scanning " + MARKETS.length + " markets...");
    byId("dp-scan").disabled = true;

    const pair = PAIRS.find(function (p) { return p.id === state.pair; });
    const specs = [sideSpec(pair, "over"), sideSpec(pair, "under")];
    const rows = [];
    let pending = MARKETS.length;
    let failed = 0;
    let finished = false;
    const sock = new WebSocket(WS_URL);

    function done() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { sock.close(); } catch (e) { /* ignore */ }

      rows.sort(function (a, b) {
        const aOk = a.triggers >= MIN_PATTERNS;
        const bOk = b.triggers >= MIN_PATTERNS;
        if (aOk !== bOk) return aOk ? -1 : 1;
        return aOk ? b.z - a.z : b.triggers - a.triggers;
      });

      state.scanning = false;
      state.rows = rows;
      state.selected = rows.findIndex(function (r) { return r.triggers >= MIN_PATTERNS; });
      byId("dp-scan").disabled = false;
      renderResults();
      updatePick();

      const read = MARKETS.length - failed;
      if (!rows.length) setStatus("Could not read any market. Check your connection and try again.");
      else if (state.selected === -1) setStatus("Scan finished, but no result had at least " + MIN_PATTERNS + " pattern sightings. Try a deeper scan.");
      else setStatus("Scanned " + depth + " ticks on " + read + " of " + MARKETS.length + " markets. Click a row to choose a different result.");
    }

    const timer = setTimeout(function () { failed += pending; pending = 0; done(); }, SCAN_TIMEOUT_MS);

    sock.onopen = function () {
      MARKETS.forEach(function (m, i) {
        sock.send(JSON.stringify({ ticks_history: m.symbol, count: depth, end: "latest", style: "ticks", req_id: i + 1 }));
      });
    };

    sock.onmessage = function (event) {
      const d = JSON.parse(event.data);
      const id = d.echo_req && d.echo_req.req_id;
      if (!id) return;
      pending--;

      if (d.error || d.msg_type !== "history") {
        failed++;
      } else {
        const m = MARKETS[id - 1];
        const pip = d.pip_size || 2;
        const digits = d.history.prices.map(function (p) {
          return parseInt(Number(p).toFixed(pip).slice(-1), 10);
        });
        specs.forEach(function (spec) {
          const r = analyse(digits, spec);
          rows.push({
            symbol: m.symbol, marketLabel: m.label, side: spec.side, name: spec.name,
            barrier: spec.barrier, length: spec.length, entry: spec.entry, baseline: spec.baseline,
            triggers: r.triggers, wins: r.wins, rate: r.rate, z: r.z, verdict: r.verdict
          });
        });
      }
      if (pending <= 0) done();
    };

    sock.onerror = function () { failed += pending; pending = 0; done(); };
    sock.onclose = function () { if (!finished) { failed += pending; pending = 0; done(); } };
  }

  // ---------- Showing results ----------
  function renderResults() {
    const box = byId("dp-results");
    if (!state.rows.length) { box.innerHTML = ""; return; }

    let html = '<div class="dp-table-wrap"><table class="dp-table"><thead><tr>' +
      "<th>Market</th><th>Trade</th><th>Seen</th><th>Next tick won</th><th>Chance</th><th>Verdict</th>" +
      "</tr></thead><tbody>";

    state.rows.forEach(function (r, i) {
      const diff = (r.rate * 100 - r.baseline);
      const won = r.triggers ? (r.rate * 100).toFixed(1) + "% (" + (diff >= 0 ? "+" : "") + diff.toFixed(1) + ")" : "--";
      html += '<tr data-i="' + i + '" class="' + (i === state.selected ? "sel " : "") + (r.triggers < MIN_PATTERNS ? "faded" : "") + '">' +
        "<td>" + r.marketLabel.replace(" Index", "") + "</td>" +
        "<td>" + r.name + "</td>" +
        "<td>" + r.triggers + "</td>" +
        "<td>" + won + "</td>" +
        "<td>" + r.baseline + "%</td>" +
        "<td>" + r.verdict + "</td></tr>";
    });
    html += "</tbody></table></div>";
    box.innerHTML = html;

    box.querySelectorAll("tr[data-i]").forEach(function (row) {
      row.addEventListener("click", function () {
        state.selected = parseInt(row.dataset.i, 10);
        renderResults();
        updatePick();
      });
    });
  }

  function updatePick() {
    const loadBtn = byId("dp-load");
    if (state.selected < 0 || !state.rows[state.selected]) {
      byId("dp-sel-market").textContent = "Scan to find the strongest past result";
      byId("dp-sel-type").textContent = "Waiting for scan";
      loadBtn.disabled = true;
      return;
    }
    const r = state.rows[state.selected];
    byId("dp-sel-market").textContent = r.marketLabel;
    byId("dp-sel-type").textContent = r.name + " after " + r.entry;
    loadBtn.disabled = r.triggers < MIN_PATTERNS;
  }

  // ---------- Hand the pick to the Trading Bots page ----------
  function loadBot() {
    const r = state.rows[state.selected];
    if (!r || r.triggers < MIN_PATTERNS) return;
    const pick = { symbol: r.symbol, side: r.side, barrier: r.barrier, length: r.length };
    try { sessionStorage.setItem(PICK_KEY, JSON.stringify(pick)); } catch (e) { /* ignore */ }
    window.location.href = "trading-bots.html";
  }

  // ---------- Start ----------
  function init() {
    injectStyles();
    buildModal();

    // Use the page's own AI button if it has one (the Dashboard does), otherwise add one
    openerButton = byId("ai-assistant-btn");
    if (!openerButton) {
      openerButton = document.createElement("div");
      openerButton.id = "dp-ai-btn";
      openerButton.className = "floating-ai-btn";
      openerButton.innerHTML = '<div class="ai-glow-circle">AI</div>';
      document.body.appendChild(openerButton);
    }
    openerButton.setAttribute("role", "button");
    openerButton.setAttribute("tabindex", "0");
    openerButton.setAttribute("aria-label", "Open the entry scanner");

    openerButton.addEventListener("click", function (e) {
      e.stopImmediatePropagation(); // stops any older click code on the same button
      openModal();
    });
    openerButton.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openModal(); }
    });

    showTip();
  }

  if (document.body) init();
  else document.addEventListener("DOMContentLoaded", init);
})();