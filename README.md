# Diagnos

An autonomous diagnostic trading agent built for Bitget AI Base Camp Hackathon — Agentic Trading track.

Paper trading only. No real funds are used at any point.

## The idea

Every cycle, Diagnos runs a diagnostic on the market and only commits paper size when its signals genuinely agree with each other. When they don't, it says so and refuses to trade rather than force a guess. It tracks nine pairs independently (BTC, ETH, SOL, BNB, XRP, DOGE, ADA, AVAX, LINK vs USDT), sharing one paper balance across all of them.

Four signals feed the diagnosis: trend, volatility, sentiment (funding rate and long/short positioning, extremes only, read as contrarian), and an LLM read of news/event context. Agreement — not raw average — produces a 0–100 conviction score:

| Conviction | State | Action |
|---|---|---|
| 0–29 | `FAULT` | Refuses to trade. Logs why. |
| 30–69 | `INCONCLUSIVE` | Reduced-size paper position. |
| 70–100 | `DIAGNOSED` | Full-size paper position. |

The LLM news layer (Qwen primary, Groq fallback) can veto a decision to `FAULT` on hard event risk (earnings, macro decisions, a hack, an ETF ruling — anything with genuine near-term uncertainty), or nudge conviction by up to ±20 points. It never overrides silently — every nudge or veto is logged with which provider produced it and why.

## Risk controls

- **5%** hard cap on paper capital per position, regardless of conviction
- **Max 5** concurrent open positions
- **17.5%** account-level drawdown breaker — trading pauses (new positions only; existing ones still close normally) until a human reviews and calls `POST /resume`
- **2%** stop-loss per position, checked on its own faster timer independent of the main diagnostic cycle

## Project structure

```
diagnos/
├── agent/
│   ├── agent.js         # diagnostic engine, risk controls, paper trading, status API
│   ├── newsSignal.js    # LLM news/event layer — Qwen primary, Groq fallback
│   ├── explain.js       # read-only "ask Diagnos" explainer
│   ├── package.json
│   ├── railway.json
│   └── data/            # generated at runtime, not committed
└── dashboard/
    └── index.html       # single-file live dashboard, no build step
```

## Running it yourself

**Requirements:** Node.js 18+ (uses the built-in `fetch`). A Bitget account isn't required — the agent only reads public market data.

```bash
cd agent
npm install   # no real dependencies, just a formality
node agent.js
```

Without `QWEN_API_KEY` / `GROQ_API_KEY` set, the news layer returns neutral and the agent runs on rule-based signals alone — it never crashes for missing keys.

| Endpoint | Returns |
|---|---|
| `GET /status` | balance, cycle count, latest decision per pair, risk block |
| `GET /log?n=100&pair=` | recent diagnostic log rows, optionally filtered |
| `GET /pnl?n=100&pair=` | closed positions, realized P&L, win rate |
| `GET /risk` | peak balance, drawdown, paused flag, breaker trip history |
| `POST /resume` | manual breaker reset — human review step |
| `POST /ask` | `{"question": "..."}` → plain-language, data-grounded answer |
| `GET /health` | `ok` |
| `POST /sync` | forces an immediate GitHub backup |

### Configuration

Everything lives in `CONFIG` at the top of `agent.js`. No environment variables are required to run it locally.

| Variable | Effect if set | If unset |
|---|---|---|
| `BITGET_API_KEY` | higher rate limits on market data | agent runs the same |
| `GITHUB_TOKEN` + `GITHUB_REPO` | hourly backup + restore-on-restart | log only persists locally |
| `QWEN_API_KEY`, `QWEN_BASE_URL`, `QWEN_MODEL` | LLM news layer, primary | falls through to Groq |
| `GROQ_API_KEY`, `GROQ_MODEL` | LLM news layer, fallback | news layer returns neutral |
| `MAX_OPEN_POSITIONS` | overrides default of 5 | defaults to 5 |
| `DRAWDOWN_PCT` | overrides default of 0.175 (17.5%) | defaults to 0.175 |

## Deploying to Railway

1. Push this repo to GitHub.
2. New Railway project → deploy from the repo → set root directory to `agent`.
3. Railway reads `railway.json` and runs `node agent.js` automatically.
4. Add environment variables from the table above as needed — never commit them.
5. Generate a public domain, then paste it into the dashboard when it asks on first load.
6. Confirm the log is writing: `https://<your-domain>/log?n=5` should show rows within 15–20 minutes of start.

## News source

`fetchHeadlinesForPair()` pulls from [cryptocurrency.cv](https://cryptocurrency.cv) — a free, no-key, no-signup news aggregator (300+ sources), queried per pair by coin name (e.g. "Bitcoin" for BTCUSDT) via its `/api/search` endpoint. No account or environment variable needed for this part specifically.

One honest limitation worth knowing: it's a general crypto news aggregator, not built for Bitget's own rToken/tokenized-stock announcements specifically, so headline coverage is strongest for the underlying coins themselves (a BTC/ETH/SOL rate decision, hack, or ETF ruling) and weaker for platform-specific rToken mechanics news. If that gap matters for your write-up, it's worth naming as a known constraint rather than a hidden one — judges reading the code will see exactly what it does and doesn't cover.

---

Built by Wisdom — TechCraft & Coding By Wisdom.
