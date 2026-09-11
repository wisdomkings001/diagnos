/**
 * DIAGNOS — Autonomous Diagnostic Trading Agent
 *
 * Every cycle, diagnoses per-pair trend/volatility/sentiment agreement,
 * folds in an LLM read of news/event risk, and paper-trades in proportion
 * to conviction. Refuses to trade when signals don't agree rather than
 * forcing a guess.
 *
 * Risk controls: 5% per-trade cap, max concurrent positions, account-level
 * drawdown breaker with manual resume (see newsSignal.js and the risk
 * section below).
 *
 * Paper trading only. Reads real public market data from Bitget.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

let newsModule = null;
try {
  newsModule = require('./newsSignal');
} catch (_) {
  console.warn('newsSignal.js not found — running on rule-based signals only.');
}

// ---------- Configuration ----------

const CONFIG = {
  PAIRS: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT'],
  PRODUCT_TYPE: 'usdt-futures',
  CHECK_INTERVAL_MS: 15 * 60 * 1000,
  STARTING_BALANCE: 10000, // shared paper balance across all pairs
  LOG_FILE: path.join(__dirname, 'data', 'trades_log.csv'),
  STATE_FILE: path.join(__dirname, 'data', 'state.json'),
  PORT: process.env.PORT || 3000,
  FAULT_THRESHOLD: 30,
  DIAGNOSED_THRESHOLD: 70,
  MAX_POSITION_PCT: 0.05, // hard 5% cap of paper capital per position
  MAX_OPEN_POSITIONS: parseInt(process.env.MAX_OPEN_POSITIONS || '5', 10),
  MAX_DRAWDOWN_PCT: parseFloat(process.env.DRAWDOWN_PCT || '0.175'), // 17.5% default, inside locked 15-20% range
  PAIR_STAGGER_MS: 2000,
  // GitHub backup so trade history and open positions survive a container
  // restart. Optional — if unset, the agent runs the same, just without backup.
  GITHUB_TOKEN: process.env.GITHUB_TOKEN || null,
  GITHUB_REPO: process.env.GITHUB_REPO || null,
  GITHUB_SYNC_INTERVAL_MS: 60 * 60 * 1000,
  POSITION_HOLD_MS: 60 * 60 * 1000,
  STOP_LOSS_PCT: 0.02, // close early if a position moves 2% against entry
  POSITION_CHECK_INTERVAL_MS: 3 * 60 * 1000, // dedicated faster timer for stop-loss checks
  PNL_LOG_FILE: path.join(__dirname, 'data', 'closed_trades.csv'),
};

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- GitHub backup sync ----------

async function getFileSha(repoPath) {
  const url = `https://api.github.com/repos/${CONFIG.GITHUB_REPO}/contents/${repoPath}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${CONFIG.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub get-file failed: ${res.status}`);
  return (await res.json()).sha;
}

async function pullFileFromGitHub(repoPath, localPath) {
  if (!CONFIG.GITHUB_TOKEN || !CONFIG.GITHUB_REPO) return false;
  try {
    const url = `https://api.github.com/repos/${CONFIG.GITHUB_REPO}/contents/${repoPath}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${CONFIG.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
    });
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`GitHub get-file failed: ${res.status}`);
    const json = await res.json();
    fs.writeFileSync(localPath, Buffer.from(json.content, 'base64').toString('utf8'));
    console.log(`Restored ${repoPath} from GitHub backup.`);
    return true;
  } catch (err) {
    console.warn(`Could not restore ${repoPath} from GitHub (starting fresh):`, err.message);
    return false;
  }
}

async function pushFileToGitHub(localPath, repoPath, commitMessage) {
  if (!CONFIG.GITHUB_TOKEN || !CONFIG.GITHUB_REPO) return;
  try {
    const content = fs.readFileSync(localPath, 'utf8');
    const sha = await getFileSha(repoPath);
    const url = `https://api.github.com/repos/${CONFIG.GITHUB_REPO}/contents/${repoPath}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${CONFIG.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: commitMessage,
        content: Buffer.from(content, 'utf8').toString('base64'),
        ...(sha ? { sha } : {}),
      }),
    });
    if (!res.ok) throw new Error(`GitHub push failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    console.log(`Synced ${repoPath} to GitHub.`);
  } catch (err) {
    // Never let a sync failure crash the trading loop — retry next interval.
    console.warn('GitHub sync failed (will retry next cycle):', err.message);
  }
}

async function syncToGitHub() {
  if (!CONFIG.GITHUB_TOKEN || !CONFIG.GITHUB_REPO) return;
  const ts = new Date().toISOString();
  await pushFileToGitHub(CONFIG.LOG_FILE, 'agent/data/trades_log.csv', `Diagnos log sync — ${ts}`);
  if (fs.existsSync(CONFIG.PNL_LOG_FILE)) {
    await pushFileToGitHub(CONFIG.PNL_LOG_FILE, 'agent/data/closed_trades.csv', `Diagnos P&L sync — ${ts}`);
  }
  if (fs.existsSync(CONFIG.STATE_FILE)) {
    // Backing up state.json (not just the CSVs) is what lets an open
    // position survive a container restart instead of silently resetting
    // its hold-window clock.
    await pushFileToGitHub(CONFIG.STATE_FILE, 'agent/data/state.json', `Diagnos state sync — ${ts}`);
  }
}

if (!fs.existsSync(CONFIG.LOG_FILE)) {
  fs.writeFileSync(CONFIG.LOG_FILE, 'timestamp,pair,state,conviction_score,direction,price,quantity,balance_change,balance_after,reason\n');
}

if (!fs.existsSync(CONFIG.PNL_LOG_FILE)) {
  fs.writeFileSync(CONFIG.PNL_LOG_FILE, 'opened_at,closed_at,pair,direction,conviction_score,entry_price,exit_price,quantity,realized_pnl,balance_after\n');
}

// ---------- State ----------

function loadState() {
  if (fs.existsSync(CONFIG.STATE_FILE)) {
    try {
      const loaded = JSON.parse(fs.readFileSync(CONFIG.STATE_FILE, 'utf8'));
      if (!loaded.pairs) {
        // Migration from an older single-pair state shape.
        loaded.pairs = {};
        CONFIG.PAIRS.forEach((p) => {
          loaded.pairs[p] = { priceHistory: loaded.priceHistory || [], lastDecision: null, openPosition: null };
        });
      }
      CONFIG.PAIRS.forEach((p) => {
        if (!loaded.pairs[p]) loaded.pairs[p] = { priceHistory: [], lastDecision: null, openPosition: null };
        if (loaded.pairs[p].openPosition === undefined) loaded.pairs[p].openPosition = null;
      });
      // drawdown breaker fields.
      if (typeof loaded.balance !== 'number') loaded.balance = CONFIG.STARTING_BALANCE;
      if (typeof loaded.peakBalance !== 'number') loaded.peakBalance = loaded.balance;
      if (typeof loaded.tradingPaused !== 'boolean') loaded.tradingPaused = false;
      if (!Array.isArray(loaded.drawdownTrips)) loaded.drawdownTrips = [];
      if (typeof loaded.cyclesRun !== 'number') loaded.cyclesRun = 0;
      return loaded;
    } catch (e) {
      console.error('State file corrupted, reinitializing.', e.message);
    }
  }
  const pairs = {};
  CONFIG.PAIRS.forEach((p) => { pairs[p] = { priceHistory: [], lastDecision: null, openPosition: null }; });
  return { balance: CONFIG.STARTING_BALANCE, peakBalance: CONFIG.STARTING_BALANCE, tradingPaused: false, drawdownTrips: [], pairs, cyclesRun: 0 };
}

function saveState(state) {
  fs.writeFileSync(CONFIG.STATE_FILE, JSON.stringify(state, null, 2));
}

// Replaced with the real loaded state inside startAgent(), after an
// attempted GitHub restore. Exists only so later functions can reference
// `state` by name before startAgent() runs.
let state = { balance: CONFIG.STARTING_BALANCE, peakBalance: CONFIG.STARTING_BALANCE, tradingPaused: false, drawdownTrips: [], pairs: {}, cyclesRun: 0 };

// ---------- Risk-control layer ----------

function countOpenPositions() {
  return CONFIG.PAIRS.filter((p) => state.pairs[p] && state.pairs[p].openPosition).length;
}

function currentDrawdownPct() {
  if (!state.peakBalance || state.peakBalance <= 0) return 0;
  return Math.max(0, (state.peakBalance - state.balance) / state.peakBalance);
}

function updatePeakAndCheckBreaker(reason) {
  // Ratchet peak up, never down except on manual resume.
  if (state.balance > state.peakBalance) state.peakBalance = state.balance;
  const dd = currentDrawdownPct();
  if (!state.tradingPaused && dd >= CONFIG.MAX_DRAWDOWN_PCT) {
    state.tradingPaused = true;
    const trip = { timestamp: new Date().toISOString(), drawdownPct: dd, peak: state.peakBalance, balance: state.balance, reason: reason || 'drawdown limit breached' };
    state.drawdownTrips.push(trip);
    console.warn(`DRAWNDOWN BREAKER TRIPPED: ${(dd * 100).toFixed(2)}% below peak. Trading paused until manual POST /resume.`);
  }
  return dd;
}

// Human-readable search term per pair — free-text search returns better
// results against a coin name than a raw ticker for most sources.
const NEWS_SEARCH_TERM = {
  BTCUSDT: 'Bitcoin', ETHUSDT: 'Ethereum', SOLUSDT: 'Solana', BNBUSDT: 'BNB',
  XRPUSDT: 'XRP', DOGEUSDT: 'Dogecoin', ADAUSDT: 'Cardano', AVAXUSDT: 'Avalanche',
  LINKUSDT: 'Chainlink',
};
const HEADLINES_TIMEOUT_MS = 8000;
const HEADLINES_BASE_URL = 'https://cryptocurrency.cv/api/search';

async function fetchHeadlinesForPair(pair) {
  const term = NEWS_SEARCH_TERM[pair] || pair.replace('USDT', '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HEADLINES_TIMEOUT_MS);
  try {
    const url = `${HEADLINES_BASE_URL}?q=${encodeURIComponent(term)}&limit=8`;
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`headlines fetch failed: ${res.status}`);
    const json = await res.json();
    const articles = Array.isArray(json.articles) ? json.articles : [];
    return articles.slice(0, 8).map((a) => a.title).filter(Boolean);
  } catch (e) {
    // No key required for this source, so a failure here is a real outage
    // or timeout, not an auth issue — safe to fall through to neutral.
    console.warn(`Headlines unavailable for ${pair}, news layer will read neutral:`, e.message);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Bitget public market data ----------

const BITGET_BASE_URL = 'https://api.bitget.com';

async function fetchTicker(pair) {
  const url = `${BITGET_BASE_URL}/api/v2/mix/market/ticker?symbol=${pair}&productType=${CONFIG.PRODUCT_TYPE}`;
  const res = await fetch(url, {
    headers: process.env.BITGET_API_KEY ? { 'ACCESS-KEY': process.env.BITGET_API_KEY } : {},
  });
  if (!res.ok) throw new Error(`Ticker fetch failed: ${res.status}`);
  const json = await res.json();
  if (json.code !== '00000' || !json.data || !json.data[0]) {
    throw new Error(`Unexpected ticker response: ${JSON.stringify(json)}`);
  }
  return json.data[0];
}

async function fetchCandles(pair, limit = 50) {
  const url = `${BITGET_BASE_URL}/api/v2/mix/market/candles?symbol=${pair}&productType=${CONFIG.PRODUCT_TYPE}&granularity=15m&limit=${limit}`;
  const res = await fetch(url, {
    headers: process.env.BITGET_API_KEY ? { 'ACCESS-KEY': process.env.BITGET_API_KEY } : {},
  });
  if (!res.ok) throw new Error(`Candle fetch failed: ${res.status}`);
  const json = await res.json();
  if (json.code !== '00000' || !Array.isArray(json.data)) {
    throw new Error(`Unexpected candle response: ${JSON.stringify(json)}`);
  }
  // Bitget returns newest-first as [ts, open, high, low, close, baseVol, quoteVol].
  return json.data.map((row) => parseFloat(row[4])).reverse();
}

async function fetchLongShortRatio(pair) {
  const url = `${BITGET_BASE_URL}/api/v2/mix/market/long-short?symbol=${pair}&productType=${CONFIG.PRODUCT_TYPE}&period=5m`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      // Surface Bitget's actual error code/message, not just the HTTP
      // status — needed to tell a real outage apart from "no data for
      // this symbol."
      let detail = '';
      try {
        const errJson = await res.json();
        detail = ` — ${errJson.code || ''} ${errJson.msg || ''}`.trim();
      } catch (_) { /* body wasn't JSON — fall back to bare status */ }
      throw new Error(`status ${res.status}${detail}`);
    }
    const json = await res.json();
    if (json.code === '00000' && Array.isArray(json.data) && json.data[0]) {
      return parseFloat(json.data[0].longShortRatio);
    }
    throw new Error(`unexpected response code=${json.code} msg=${json.msg || 'n/a'}`);
  } catch (e) {
    console.warn(`Long/short ratio unavailable for ${pair}, defaulting to neutral 1.0:`, e.message);
  }
  return 1.0;
}

// ---------- Diagnostic engine ----------
// Three signals, each a -100..+100 directional reading. Conviction comes
// from how strongly trend and sentiment AGREE, not their raw average.

function trendSignal(closes) {
  if (closes.length < 10) return { value: 0, label: 'insufficient data' };
  const recent = closes.slice(-10);
  const pctChange = ((recent[recent.length - 1] - recent[0]) / recent[0]) * 100;
  // A 2% move over 10 candles (~2.5h) is treated as a strong trend.
  const value = Math.max(-100, Math.min(100, (pctChange / 2) * 100));
  return { value, label: `${pctChange.toFixed(2)}% move over last 10 candles` };
}

function volatilitySignal(closes) {
  if (closes.length < 10) return { value: 0, label: 'insufficient data' };
  const recent = closes.slice(-10);
  const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
  const variance = recent.reduce((a, b) => a + (b - mean) ** 2, 0) / recent.length;
  const stdDevPct = (Math.sqrt(variance) / mean) * 100;
  // Volatility has no direction of its own — it only dampens conviction.
  return { value: stdDevPct, label: `${stdDevPct.toFixed(3)}% stdev` };
}

function sentimentSignal(fundingRate, longShortRatio) {
  // Crypto perpetuals sit moderately long-skewed most of the time as a
  // structural baseline (L/S ratio 1.4-2.0 is routine, not meaningful).
  // Only a genuinely extreme skew counts as a signal, and it's treated
  // as contrarian — a crowded trade is a risk, not a green light.
  const fundingPct = fundingRate * 100;
  const extremeFunding = Math.abs(fundingPct) > 0.05;
  const extremeLongSkew = longShortRatio > 3.0;
  const extremeShortSkew = longShortRatio < 0.4;

  let value = 0;
  let label = `funding ${fundingPct.toFixed(4)}%, L/S ratio ${longShortRatio.toFixed(2)}`;

  if (extremeLongSkew || extremeShortSkew) {
    value = extremeLongSkew ? -60 : 60;
    label += ' — extreme L/S skew, treated as contrarian/crowded';
  }
  if (extremeFunding) {
    // Extreme funding takes precedence over L/S skew if both fire at once.
    value = -Math.sign(fundingPct) * 60;
    label += extremeLongSkew || extremeShortSkew ? '' : ' — extreme funding, treated as contrarian/crowded';
  }

  return { value: Math.max(-100, Math.min(100, value)), label };
}

function pickDirection(trendValue, sentimentValue) {
  // Whichever signal has the larger magnitude decides direction. If both
  // are exactly zero (no real signal either way), there's no honest basis
  // for a direction — this only matters in FAULT territory since
  // conviction is 0 either way, but the result should say so rather than
  // silently defaulting to "long".
  if (trendValue === 0 && sentimentValue === 0) return 'none';
  return Math.abs(trendValue) >= Math.abs(sentimentValue)
    ? (trendValue >= 0 ? 'long' : 'short')
    : (sentimentValue >= 0 ? 'long' : 'short');
}

function runDiagnostic(closes, fundingRate, longShortRatio) {
  const trend = trendSignal(closes);
  const vol = volatilitySignal(closes);
  const sentiment = sentimentSignal(fundingRate, longShortRatio);

  const bothNonZero = trend.value !== 0 && sentiment.value !== 0;
  const sameSign = bothNonZero && Math.sign(trend.value) === Math.sign(sentiment.value);
  const magnitude = (Math.abs(trend.value) + Math.abs(sentiment.value)) / 2;
  const agreementBonus = sameSign ? 25 : 0;
  const volPenalty = Math.min(40, vol.value * 8);

  const convictionScore = Math.max(0, Math.min(100, magnitude + agreementBonus - volPenalty));
  const direction = pickDirection(trend.value, sentiment.value);

  let stateLabel, reason;
  if (convictionScore < CONFIG.FAULT_THRESHOLD) {
    stateLabel = 'FAULT';
    reason = `Signals contradict or noise too high to diagnose cleanly. Trend: ${trend.label}. Sentiment: ${sentiment.label}. Volatility: ${vol.label}. Refusing to trade — protecting capital over forcing a read.`;
  } else if (convictionScore < CONFIG.DIAGNOSED_THRESHOLD) {
    stateLabel = 'INCONCLUSIVE';
    reason = `Partial agreement between signals. Trend: ${trend.label}. Sentiment: ${sentiment.label}. Taking a reduced position sized to uncertainty.`;
  } else {
    stateLabel = 'DIAGNOSED';
    reason = `Trend and sentiment signals agree with low noise. Trend: ${trend.label}. Sentiment: ${sentiment.label}. Taking a full-conviction position.`;
  }

  return {
    state: stateLabel,
    convictionScore: Math.round(convictionScore),
    direction,
    reason,
    detail: { trend, vol, sentiment },
  };
}

// ---------- Paper trading execution ----------

function sizePosition(convictionScore, balance, price) {
  // Linear scaling: 0 conviction -> 0 size, 100 conviction -> MAX_POSITION_PCT of balance.
  const pct = (convictionScore / 100) * CONFIG.MAX_POSITION_PCT;
  const usdSize = balance * pct;
  return { usdSize, qty: usdSize / price };
}

function executeCycle(pair, diagnostic, currentPrice) {
  const timestamp = new Date().toISOString();
  let direction = 'none';
  let qty = 0;
  let balanceChange = 0;

  // A fee only applies when a NEW position actually opens this cycle —
  // not on every non-FAULT cycle. Without this guard, a pair that stays
  // DIAGNOSED/INCONCLUSIVE for several cycles in a row while a position
  // is already open would get charged a fee each cycle for a trade that
  // never actually happened, inflating "fee drag" far beyond real cost.
  const alreadyOpen = !!state.pairs[pair].openPosition;
  if (diagnostic.state !== 'FAULT' && !alreadyOpen) {
    if (state.tradingPaused) {
      diagnostic = { ...diagnostic, state: 'FAULT', reason: `${diagnostic.reason} Blocked: drawdown breaker paused trading until manual POST /resume.` };
    } else if (countOpenPositions() >= CONFIG.MAX_OPEN_POSITIONS) {
      diagnostic = { ...diagnostic, state: 'FAULT', reason: `${diagnostic.reason} Blocked: max ${CONFIG.MAX_OPEN_POSITIONS} concurrent positions reached.` };
    } else {
      const { usdSize, qty: sizedQty } = sizePosition(diagnostic.convictionScore, state.balance, currentPrice);
      direction = diagnostic.direction;
      qty = sizedQty;

      const feeRate = 0.0006; // typical taker fee
      balanceChange = -(usdSize * feeRate);
      state.balance += balanceChange;
      updatePeakAndCheckBreaker(`fee on ${pair} open`);

      state.pairs[pair].openPosition = {
        openedAt: timestamp,
        pair,
        direction,
        convictionScore: diagnostic.convictionScore,
        entryPrice: currentPrice,
        quantity: qty,
      };
    }
  } else if (diagnostic.state !== 'FAULT' && alreadyOpen) {
    // Signal still non-FAULT, but a position is already open for this pair —
    // log the read for visibility without opening a second position or fee.
    direction = diagnostic.direction;
  }

  const logRow = [
    timestamp, pair, diagnostic.state, diagnostic.convictionScore, direction,
    currentPrice.toFixed(2), qty.toFixed(6), balanceChange.toFixed(4), state.balance.toFixed(4),
    `"${diagnostic.reason.replace(/"/g, "'")}"`,
  ].join(',');
  fs.appendFileSync(CONFIG.LOG_FILE, logRow + '\n');

  state.pairs[pair].lastDecision = {
    timestamp, pair, state: diagnostic.state, convictionScore: diagnostic.convictionScore,
    direction, price: currentPrice, quantity: qty, balanceChange, balanceAfter: state.balance,
    reason: diagnostic.reason, detail: diagnostic.detail,
  };
  saveState(state);

  console.log(`[${timestamp}] ${pair} | ${diagnostic.state} | conviction ${diagnostic.convictionScore} | ${direction} | balance ${state.balance.toFixed(2)}`);
}

// ---------- P&L: closing positions ----------
// Runs independently of executeCycle. Checks every open position; closes
// it if the hold window has passed OR the stop-loss has been breached,
// whichever comes first. Writes to a separate file so trades_log.csv and
// its parser are never touched by this.

function calculateRealizedPnl(position, exitPrice) {
  const { direction, entryPrice, quantity } = position;
  const priceDelta = direction === 'long' ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
  return priceDelta * quantity;
}

let closingPositionsInProgress = false;

async function closeExpiredPositions() {
  // Guards against two overlapping runs (startup check, the fast timer,
  // and the slower full cycle all call this) racing to close the same
  // position twice.
  if (closingPositionsInProgress) {
    console.log('Position check already in progress, skipping this trigger.');
    return;
  }
  closingPositionsInProgress = true;
  try {
    for (const pair of CONFIG.PAIRS) {
      const pairState = state.pairs[pair];
      const pos = pairState.openPosition;
      if (!pos) continue;

      try {
        const ticker = await fetchTicker(pair);
        const currentPrice = parseFloat(ticker.lastPr || ticker.last);
        const holdExpired = Date.now() - new Date(pos.openedAt).getTime() >= CONFIG.POSITION_HOLD_MS;

        const adverseMovePct = pos.direction === 'long'
          ? (pos.entryPrice - currentPrice) / pos.entryPrice
          : (currentPrice - pos.entryPrice) / pos.entryPrice;
        const stopLossHit = adverseMovePct >= CONFIG.STOP_LOSS_PCT;

        if (holdExpired || stopLossHit) {
          closePosition(pair, pairState, pos, currentPrice, stopLossHit && !holdExpired ? 'stop-loss' : 'hold-expired');
        }
      } catch (err) {
        // Leave the position open and retry next check rather than
        // force-closing on bad data.
        console.warn(`Could not check/close position for ${pair} (will retry):`, err.message);
      }
    }
  } finally {
    closingPositionsInProgress = false;
  }
}

function closePosition(pair, pairState, pos, exitPrice, closeReason) {
  const realizedPnl = calculateRealizedPnl(pos, exitPrice);
  const closedAt = new Date().toISOString();
  state.balance += realizedPnl;
  updatePeakAndCheckBreaker(`close ${pair} (${closeReason}) pnl ${realizedPnl.toFixed(2)}`);

  const row = [
    pos.openedAt, closedAt, pair, pos.direction, pos.convictionScore,
    pos.entryPrice.toFixed(2), exitPrice.toFixed(2), pos.quantity.toFixed(6),
    realizedPnl.toFixed(4), state.balance.toFixed(4),
  ].join(',');
  fs.appendFileSync(CONFIG.PNL_LOG_FILE, row + '\n');
  console.log(`[${closedAt}] ${pair} | CLOSED (${closeReason}) ${pos.direction} | entry ${pos.entryPrice.toFixed(2)} -> exit ${exitPrice.toFixed(2)} | realized P&L ${realizedPnl.toFixed(4)}`);

  pairState.openPosition = null;
  saveState(state);
}

// ---------- Main loop ----------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runOnePair(pair) {
  try {
    const ticker = await fetchTicker(pair);
    const currentPrice = parseFloat(ticker.lastPr || ticker.last);
    const fundingRate = parseFloat(ticker.fundingRate || '0');

    const pairState = state.pairs[pair];
    pairState.priceHistory.push(currentPrice);
    if (pairState.priceHistory.length > 200) pairState.priceHistory.shift();

    let closes = pairState.priceHistory;
    if (closes.length < 15) {
      // Bootstrap with real candle history so we don't wait hours to build up data.
      try {
        closes = await fetchCandles(pair, 50);
        pairState.priceHistory = closes;
      } catch (e) {
        console.warn(`Candle bootstrap failed for ${pair}, continuing with live ticks only:`, e.message);
      }
    }

    const longShortRatio = await fetchLongShortRatio(pair);
    let diagnostic = runDiagnostic(closes, fundingRate, longShortRatio);
    // LLM news layer: Qwen primary, Groq fallback. Never crashes cycle.
    if (newsModule) {
      try {
        const headlines = await fetchHeadlinesForPair(pair);
        const news = await newsModule.newsSignal(pair, headlines);
        diagnostic = newsModule.mergeNewsIntoDiagnostic(diagnostic, news, {
          fault: CONFIG.FAULT_THRESHOLD,
          diagnosed: CONFIG.DIAGNOSED_THRESHOLD,
        });
      } catch (e) {
        console.warn(`News layer skipped for ${pair}:`, e.message);
      }
    }
    executeCycle(pair, diagnostic, currentPrice);
  } catch (err) {
    console.error(`Cycle failed for ${pair}:`, err.message);
    const timestamp = new Date().toISOString();
    fs.appendFileSync(
      CONFIG.LOG_FILE,
      `${timestamp},${pair},FAULT,0,none,0,0,0,${state.balance.toFixed(4)},"Data fetch error: ${err.message.replace(/"/g, "'")}"\n`
    );
  }
}

async function runCycle() {
  for (const pair of CONFIG.PAIRS) {
    await runOnePair(pair);
    await sleep(CONFIG.PAIR_STAGGER_MS);
  }
  await closeExpiredPositions();
  state.cyclesRun += 1;
  saveState(state);
}

// ---------- Status API ----------

function readRecentLogRows(n = 50, pairFilter = null) {
  if (!fs.existsSync(CONFIG.LOG_FILE)) return [];
  const lines = fs.readFileSync(CONFIG.LOG_FILE, 'utf8').trim().split('\n');
  let rows = lines.slice(1).map((line) => {
    const match = line.match(/^([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),"(.*)"$/);
    if (!match) return null;
    const [, timestamp, pair, st, conviction, direction, price, qty, balChange, balAfter, reason] = match;
    return {
      timestamp, pair, state: st, convictionScore: Number(conviction), direction,
      price: Number(price), quantity: Number(qty),
      balanceChange: Number(balChange), balanceAfter: Number(balAfter), reason,
    };
  }).filter(Boolean);

  if (pairFilter) rows = rows.filter((r) => r.pair === pairFilter);
  return rows.slice(-n);
}

function readClosedTrades(n = 100, pairFilter = null) {
  if (!fs.existsSync(CONFIG.PNL_LOG_FILE)) return [];
  const lines = fs.readFileSync(CONFIG.PNL_LOG_FILE, 'utf8').trim().split('\n');
  let rows = lines.slice(1).filter(Boolean).map((line) => {
    const parts = line.split(',');
    if (parts.length !== 10) return null;
    const [openedAt, closedAt, pair, direction, conviction, entryPrice, exitPrice, qty, pnl, balAfter] = parts;
    return {
      openedAt, closedAt, pair, direction, convictionScore: Number(conviction),
      entryPrice: Number(entryPrice), exitPrice: Number(exitPrice),
      quantity: Number(qty), realizedPnl: Number(pnl), balanceAfter: Number(balAfter),
    };
  }).filter(Boolean);

  if (pairFilter) rows = rows.filter((r) => r.pair === pairFilter);
  return rows.slice(-n);
}

function buildStatusPayload() {
  const pairs = {};
  CONFIG.PAIRS.forEach((p) => { pairs[p] = state.pairs[p] ? state.pairs[p].lastDecision : null; });

  let mostRecent = null;
  CONFIG.PAIRS.forEach((p) => {
    const d = state.pairs[p] && state.pairs[p].lastDecision;
    if (d && (!mostRecent || new Date(d.timestamp) > new Date(mostRecent.timestamp))) mostRecent = d;
  });

  const openPositions = {};
  CONFIG.PAIRS.forEach((p) => { openPositions[p] = (state.pairs[p] && state.pairs[p].openPosition) || null; });

  return {
    pairs: CONFIG.PAIRS,
    balance: state.balance,
    startingBalance: CONFIG.STARTING_BALANCE,
    cyclesRun: state.cyclesRun,
    lastDecisionByPair: pairs,
    lastDecision: mostRecent,
    openPositionCount: countOpenPositions(),
    openPositions,
    risk: {
      peakBalance: state.peakBalance,
      drawdownPct: currentDrawdownPct(),
      drawdownLimitPct: CONFIG.MAX_DRAWDOWN_PCT,
      tradingPaused: !!state.tradingPaused,
      maxPositionPct: CONFIG.MAX_POSITION_PCT,
      maxOpenPositions: CONFIG.MAX_OPEN_POSITIONS,
      trips: state.drawdownTrips || [],
    },
  };
}

function buildRiskPayload() {
  return {
    balance: state.balance,
    peakBalance: state.peakBalance,
    drawdownPct: currentDrawdownPct(),
    drawdownLimitPct: CONFIG.MAX_DRAWDOWN_PCT,
    tradingPaused: !!state.tradingPaused,
    maxPositionPct: CONFIG.MAX_POSITION_PCT,
    maxOpenPositions: CONFIG.MAX_OPEN_POSITIONS,
    openPositionCount: countOpenPositions(),
    trips: state.drawdownTrips || [],
  };
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

const { buildExplanation } = require('./explain');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    return res.end();
  }

  if (url.pathname === '/ask' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let question = '';
      try { question = JSON.parse(body).question || ''; } catch (_) { /* malformed body, fall through */ }
      const statusPayload = buildStatusPayload();
      const recentLog = readRecentLogRows(200);
      const closedTrades = readClosedTrades(9999);
      const pnlSummary = {
        totalRealizedPnl: closedTrades.reduce((sum, r) => sum + r.realizedPnl, 0),
        wins: closedTrades.filter((r) => r.realizedPnl > 0).length,
        losses: closedTrades.filter((r) => r.realizedPnl < 0).length,
        closedCount: closedTrades.length,
      };
      const answer = buildExplanation(question, statusPayload, recentLog, pnlSummary);
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
      res.end(JSON.stringify({ answer }));
    });
    return;
  }

  if (url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
    return res.end(JSON.stringify(buildStatusPayload()));
  }

  if (url.pathname === '/log') {
    const n = parseInt(url.searchParams.get('n') || '100', 10);
    const pairFilter = url.searchParams.get('pair') || null;
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
    return res.end(JSON.stringify(readRecentLogRows(n, pairFilter)));
  }

  if (url.pathname === '/pnl') {
    const n = parseInt(url.searchParams.get('n') || '100', 10);
    const pairFilter = url.searchParams.get('pair') || null;
    const closed = readClosedTrades(n, pairFilter);
    const wins = closed.filter((r) => r.realizedPnl > 0).length;
    const losses = closed.filter((r) => r.realizedPnl < 0).length;
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
    return res.end(JSON.stringify({
      closedTrades: closed,
      totalRealizedPnl: closed.reduce((sum, r) => sum + r.realizedPnl, 0),
      wins,
      losses,
      winRate: closed.length ? Math.round((wins / closed.length) * 100) : 0,
    }));
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain', ...corsHeaders() });
    return res.end('ok');
  }

  if (url.pathname.startsWith('/price/')) {
    const pair = url.pathname.slice('/price/'.length).toUpperCase();
    if (!CONFIG.PAIRS.includes(pair)) {
      res.writeHead(404, { 'Content-Type': 'application/json', ...corsHeaders() });
      return res.end(JSON.stringify({ error: `Unknown pair ${pair}` }));
    }
    fetchTicker(pair)
      .then((ticker) => {
        const price = parseFloat(ticker.lastPr || ticker.last);
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
        res.end(JSON.stringify({ pair, price }));
      })
      .catch((err) => {
        res.writeHead(502, { 'Content-Type': 'application/json', ...corsHeaders() });
        res.end(JSON.stringify({ error: err.message }));
      });
    return;
  }

  if (url.pathname === '/sync' && req.method === 'POST') {
    syncToGitHub().then(() => {
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
      res.end(JSON.stringify({ synced: !!(CONFIG.GITHUB_TOKEN && CONFIG.GITHUB_REPO) }));
    });
    return;
  }

  if (url.pathname === '/risk') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
    return res.end(JSON.stringify(buildRiskPayload()));
  }

  if (url.pathname === '/resume' && req.method === 'POST') {
    // Manual reset for the drawdown breaker. Requires human review by design.
    state.tradingPaused = false;
    state.peakBalance = state.balance;
    const entry = { timestamp: new Date().toISOString(), balance: state.balance, note: 'manual resume after review' };
    state.drawdownTrips.push(entry);
    saveState(state);
    console.log(`[${entry.timestamp}] Drawdown breaker manually resumed at balance ${state.balance.toFixed(2)}.`);
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
    return res.end(JSON.stringify({ resumed: true, ...buildRiskPayload() }));
  }

  res.writeHead(404, corsHeaders());
  res.end('Not found. Try /status or /log');
});

// ---------- Startup ----------

async function startAgent() {
  console.log('Diagnos agent starting.');
  console.log(`Pairs: ${CONFIG.PAIRS.join(', ')} | Interval: ${CONFIG.CHECK_INTERVAL_MS / 60000} min | Starting balance: $${CONFIG.STARTING_BALANCE}`);
  console.log(`Risk: maxPosition ${(CONFIG.MAX_POSITION_PCT * 100).toFixed(1)}% | maxOpen ${CONFIG.MAX_OPEN_POSITIONS} | drawdown ${(CONFIG.MAX_DRAWDOWN_PCT * 100).toFixed(1)}% | LLM ${newsModule ? 'newsSignal loaded (qwen->groq)' : 'disabled'}`);

  if (CONFIG.GITHUB_TOKEN && CONFIG.GITHUB_REPO) {
    console.log(`GitHub backup sync enabled -> ${CONFIG.GITHUB_REPO} (every ${CONFIG.GITHUB_SYNC_INTERVAL_MS / 60000} min)`);
    if (!fs.existsSync(CONFIG.STATE_FILE)) {
      await pullFileFromGitHub('agent/data/state.json', CONFIG.STATE_FILE);
    }
  } else {
    console.log('GitHub backup sync disabled (GITHUB_TOKEN / GITHUB_REPO not set) — log will only persist locally.');
  }

  state = loadState();

  server.listen(CONFIG.PORT, () => {
    console.log(`Diagnos status API listening on port ${CONFIG.PORT}`);
  });

  // Check any open positions immediately on startup, before the slower
  // full signal sweep — a restart should never add delay on top of
  // however long the container was actually down.
  const openCount = CONFIG.PAIRS.filter((p) => state.pairs[p] && state.pairs[p].openPosition).length;
  if (openCount > 0) {
    console.log(`Startup: ${openCount} open position(s) found — checking immediately before first cycle.`);
    await closeExpiredPositions();
  }

  runCycle();
  setInterval(runCycle, CONFIG.CHECK_INTERVAL_MS);
  setInterval(syncToGitHub, CONFIG.GITHUB_SYNC_INTERVAL_MS);
  // Stop-loss checks run on their own faster timer, independent of the
  // slower full signal sweep, so a breach doesn't sit unnoticed for up
  // to CHECK_INTERVAL_MS.
  setInterval(closeExpiredPositions, CONFIG.POSITION_CHECK_INTERVAL_MS);
}

startAgent();
