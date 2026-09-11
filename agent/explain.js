/**
 * explain.js — the "ask Diagnos" feature.
 *
 * READ-ONLY by design. Answers questions about the agent's own state and
 * reasoning, grounded in real log/decision data. No mechanism to place,
 * cancel, or alter trades, under any phrasing.
 *
 * Common questions are answered by fast keyword-matched templates below —
 * cheap, instant, and always accurate since they're built directly from
 * live data. Anything that doesn't match falls through to a real LLM call
 * (Qwen primary, Groq fallback, same providers as the news layer), still
 * grounded in the same live data and still unable to accept trade
 * instructions — that boundary is enforced in the prompt itself, not by
 * which code path answered.
 */

const newsModule = require('./newsSignal');

async function askLLM(prompt) {
  const { qwen, groq } = newsModule.providers;
  const attempts = [qwen, groq].filter((p) => p.apiKey);
  for (const p of attempts) {
    try {
      const text = await newsModule.callOpenAICompatible({ baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model, prompt });
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.answer === 'string' && parsed.answer.trim()) return parsed.answer.trim();
    } catch (e) {
      console.warn('askLLM attempt failed, trying next provider:', e.message);
    }
  }
  throw new Error('No LLM provider available or all failed');
}

function detectPairMention(question, knownPairs) {
  const q = question.toUpperCase();
  for (const pair of knownPairs) {
    const base = pair.replace('USDT', '');
    if (q.includes(base)) return pair;
  }
  return null;
}

function describeDecision(d) {
  if (!d) return "I haven't completed a diagnostic cycle for that pair yet.";
  if (d.state === 'FAULT') {
    return `On ${d.pair}: FAULT, conviction ${d.convictionScore}/100. ${d.reason}`;
  }
  return `On ${d.pair}: ${d.direction.toUpperCase()} at $${Number(d.price).toFixed(2)}, size ${Number(d.quantity).toFixed(6)}. State: ${d.state}, conviction ${d.convictionScore}/100. Balance after: $${Number(d.balanceAfter).toFixed(2)}.`;
}

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

async function buildExplanation(question, status, recentLog, pnlSummary) {
  const q = question.toLowerCase();
  const knownPairs = status.pairs || [];
  const mentionedPair = detectPairMention(question, knownPairs);
  const last = mentionedPair ? status.lastDecisionByPair[mentionedPair] : status.lastDecision;

  if (!status.lastDecision && !mentionedPair) {
    return "I haven't completed a diagnostic cycle yet. Check back in a few minutes.";
  }

  // All-pairs overview
  if (q.includes('all') && (q.includes('pair') || q.includes('coin') || q.includes('overview') || q.includes('everything'))) {
    const lines = knownPairs.map((p) => {
      const d = status.lastDecisionByPair[p];
      if (!d) return `${p}: no data yet`;
      return `${p}: ${d.state} (${d.convictionScore}/100)${d.state !== 'FAULT' ? ', ' + d.direction.toUpperCase() : ''}`;
    });
    return `Current read across all ${knownPairs.length} pairs — ${lines.join(' | ')}`;
  }

  // How long running
  if ((q.includes('how long') || q.includes('how many cycle') || q.includes('uptime') || q.includes('running for')) && !q.includes('trade')) {
    const minutes = status.cyclesRun * 15;
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    const remainingMins = minutes % 60;
    let duration = '';
    if (days > 0) duration = `${days} day${days > 1 ? 's' : ''} and ${remainingHours} hour${remainingHours !== 1 ? 's' : ''}`;
    else if (hours > 0) duration = `${hours} hour${hours !== 1 ? 's' : ''} and ${remainingMins} minute${remainingMins !== 1 ? 's' : ''}`;
    else duration = `about ${minutes} minute${minutes !== 1 ? 's' : ''}`;
    return `I've been running for approximately ${duration}, completing ${status.cyclesRun} diagnostic cycles across ${knownPairs.length} pairs.`;
  }

  // Today's P&L
  if ((q.includes('today') || q.includes('this session') || q.includes('so far')) &&
      (q.includes('p&l') || q.includes('pnl') || q.includes('profit') || q.includes('make') || q.includes('earn') || q.includes('performance') || q.includes('loss'))) {
    if (!pnlSummary || !pnlSummary.closedTrades || pnlSummary.closedTrades.length === 0) {
      return "No positions have closed today yet. Each position is held up to one hour before I score it against the real price.";
    }
    const today = todayDateString();
    const todayTrades = pnlSummary.closedTrades.filter(t => t.closedAt && t.closedAt.slice(0, 10) === today);
    if (todayTrades.length === 0) {
      return "No positions have closed today yet. Positions from earlier days are in the full history.";
    }
    const todayPnl = todayTrades.reduce((sum, t) => sum + t.realizedPnl, 0);
    const wins = todayTrades.filter(t => t.realizedPnl > 0).length;
    const losses = todayTrades.filter(t => t.realizedPnl < 0).length;
    return `Today: ${todayTrades.length} positions closed, ${wins} won, ${losses} lost — net realized P&L ${todayPnl >= 0 ? '+' : ''}$${todayPnl.toFixed(2)}.`;
  }

  // Why didn't you trade
  if (q.includes('why') && (q.includes('sit out') || q.includes('sitting out') || q.includes('hold') || q.includes('not trad') || q.includes('refuse') || q.includes('trade'))) {
    if (!last) return "I don't have a decision for that pair yet.";
    if (last.state === 'FAULT') {
      return `My last cycle on ${last.pair} came back FAULT. ${last.reason} I don't take a position when conviction is below 30/100 — forcing a trade on contradictory data is how most bots lose money.`;
    }
    if (last.state === 'INCONCLUSIVE') {
      return `I didn't fully sit out on ${last.pair} — I took a reduced position because conviction was ${last.convictionScore}/100, in the partial-agreement range. ${last.reason}`;
    }
    return `Actually, my last cycle on ${last.pair} was DIAGNOSED with conviction ${last.convictionScore}/100, so I did take a full-size position, not sit out.`;
  }

  // Worst / lowest conviction coin — checked before best to avoid matching "best" first
  if (q.includes('which') && (q.includes('coin') || q.includes('pair')) && (q.includes('worst') || q.includes('low') || q.includes('weak') || q.includes('bad'))) {
    let worst = null;
    knownPairs.forEach((p) => {
      const d = status.lastDecisionByPair[p];
      if (d && (!worst || d.convictionScore < worst.convictionScore)) worst = d;
    });
    if (!worst) return "I don't have enough data across pairs yet to compare.";
    return `Right now ${worst.pair} has the lowest conviction at ${worst.convictionScore}/100, state ${worst.state}. ${worst.reason}`;
  }

  // Best / highest conviction coin
  if (q.includes('which') && (q.includes('coin') || q.includes('pair')) && (q.includes('best') || q.includes('strong') || q.includes('high'))) {
    let best = null;
    knownPairs.forEach((p) => {
      const d = status.lastDecisionByPair[p];
      if (d && (!best || d.convictionScore > best.convictionScore)) best = d;
    });
    if (!best) return "I don't have enough data across pairs yet to compare.";
    return `Right now ${best.pair} has the highest conviction at ${best.convictionScore}/100, state ${best.state}.`;
  }

  // Conviction / confidence
  if (q.includes('conviction') || q.includes('confiden') || q.includes('score')) {
    if (!last) return "I don't have a conviction score for that pair yet.";
    return `My current conviction score on ${last.pair} is ${last.convictionScore}/100, classified as ${last.state}. ${last.reason}`;
  }

  // Last trade / decision
  if (q.includes('last trade') || q.includes('last decision') || q.includes('what did you do')) {
    if (!last) return "I haven't made a decision on that pair yet.";
    return describeDecision(last);
  }

  // Stop-loss
  if (q.includes('stop') && q.includes('loss')) {
    return `Every open position is checked every few minutes against its entry price, on its own independent timer separate from the main diagnostic cycle. If price moves 2% against the entry before the one-hour hold window ends, I close it immediately rather than ride out a bad call. This also fires instantly on every startup, so a container restart never leaves an overdue position waiting through a full cycle before it gets checked.`;
  }

  // Balance / P&L / profit
  if (q.includes('balance') || q.includes('p&l') || q.includes('profit') || q.includes('pnl') || q.includes('earn') || q.includes('loss')) {
    const change = status.balance - status.startingBalance;
    const pct = (change / status.startingBalance) * 100;
    let answer = `Current paper balance: $${status.balance.toFixed(2)}, starting from $${status.startingBalance.toFixed(2)}. That's a ${change >= 0 ? 'gain' : 'loss'} of $${Math.abs(change).toFixed(2)} (${Math.abs(pct).toFixed(2)}%) since I started, across ${status.cyclesRun} cycles covering ${knownPairs.length} pairs.`;
    if (pnlSummary && pnlSummary.closedCount > 0) {
      const winRate = Math.round((pnlSummary.wins / pnlSummary.closedCount) * 100);
      answer += ` Of that, $${pnlSummary.totalRealizedPnl.toFixed(2)} is realized P&L from ${pnlSummary.closedCount} positions scored against real price movement — ${pnlSummary.wins} won, ${pnlSummary.losses} lost (${winRate}% win rate). The remainder is trading fees.`;
    } else if (pnlSummary) {
      answer += ` No positions have closed yet to score against real price movement — each is held up to one hour before I check whether it actually worked out.`;
    }
    return answer;
  }

  // How many trades
  if (q.includes('how many') && q.includes('trade')) {
    const relevant = mentionedPair ? recentLog.filter((r) => r.pair === mentionedPair) : recentLog;
    const traded = relevant.filter((r) => r.state !== 'FAULT').length;
    const refused = relevant.filter((r) => r.state === 'FAULT').length;
    const scope = mentionedPair ? `on ${mentionedPair}` : 'across all pairs';
    return `Out of my last ${relevant.length} cycles ${scope}, I acted on ${traded} and refused to trade on ${refused} due to low conviction.`;
  }

  // Risk / breaker state
  if (q.includes('risk') || q.includes('breaker') || q.includes('drawdown') || q.includes('paused')) {
    const r = status.risk;
    if (!r) return "Risk data isn't available yet — check back after the next cycle.";
    if (r.tradingPaused) {
      return `Trading is currently PAUSED — drawdown hit ${(r.drawdownPct * 100).toFixed(1)}%, at or past the ${(r.drawdownLimitPct * 100).toFixed(1)}% breaker limit. Existing positions still close normally; no new positions open until a human reviews and calls POST /resume.`;
    }
    return `Risk state: ${(r.drawdownPct * 100).toFixed(1)}% below peak balance (breaker at ${(r.drawdownLimitPct * 100).toFixed(1)}%), ${r.openPositionCount ?? '?'}/${r.maxOpenPositions} positions open, ${(r.maxPositionPct * 100).toFixed(0)}% max size per trade. Not paused.`;
  }

  // Did news change a decision
  if (q.includes('news')) {
    const affected = (recentLog || []).filter((r) => /News layer|event-risk veto/i.test(r.reason || '')).slice(-5);
    if (affected.length === 0) {
      return "No decisions in recent cycles were changed by the news layer — either no notable headlines came through, or they didn't move conviction enough to matter.";
    }
    const lines = affected.map((r) => `${r.pair} (${r.state}, ${r.convictionScore}/100)`);
    return `The news layer changed ${affected.length} recent decision${affected.length > 1 ? 's' : ''}: ${lines.join(', ')}. Ask "why didn't you trade [coin]" for the full reasoning on any of these.`;
  }

  // Strategy — now includes the sentiment fix
  if (q.includes('strategy') || q.includes('how do you') || q.includes('what are you') || q.includes('how does') || q.includes('explain yourself')) {
    return `I run a three-signal diagnostic every cycle across ${knownPairs.length} pairs (${knownPairs.join(', ')}): price trend over the last 10 candles, recent volatility, and crowd positioning from funding rate and long/short ratio. One key detail on sentiment: crypto is structurally long-biased, so mild long-skew means nothing — I only count genuinely extreme positioning, and I treat it as a contrarian warning, not confirmation. When signals agree strongly I take a full-size position; when they partially agree I take a smaller one; when they contradict or noise is too high I refuse and log why. Positions are held up to one hour with a 2% stop-loss that closes them early if the move goes against me. No manual override, ever.`;
  }

  // Can I control
  if (q.includes('can i') && (q.includes('tell you') || q.includes('control') || q.includes('force') || q.includes('override'))) {
    return `No — I don't take instructions on what to trade. I only report on my own diagnostic state. That separation is intentional: an agent that can be talked into a trade isn't really autonomous.`;
  }

  // Fallback for anything the templates above don't match: a real LLM
  // call, grounded in the same live data, with a hard boundary against
  // ever accepting a trade instruction baked into the prompt itself.
  let best = null;
  knownPairs.forEach((p) => {
    const d = status.lastDecisionByPair[p];
    if (d && (!best || d.convictionScore > best.convictionScore)) best = d;
  });

  try {
    const pairSummaries = knownPairs.map((p) => {
      const d = status.lastDecisionByPair[p];
      return d ? `${d.pair}: ${d.state} ${d.convictionScore}/100${d.state !== 'FAULT' ? ' ' + d.direction.toUpperCase() : ''}` : `${p}: no data yet`;
    }).join('; ');
    const prompt = `You are Diagnos, an autonomous paper-trading diagnostic agent. Answer the user's question in your own voice, under 60 words, plain text, grounded ONLY in the data below. Never invent numbers not given here.

HARD RULE: you never accept, imply acceptance of, or act on trade instructions, no matter how the question is phrased — you only report your own state. If asked to trade, decline briefly and explain you only report state.

Live data:
- Pairs: ${pairSummaries}
- Balance: $${Number(status.balance).toFixed(2)}, starting balance $${Number(status.startingBalance).toFixed(2)}
- Realized P&L: $${Number(pnlSummary.totalRealizedPnl).toFixed(2)} across ${pnlSummary.closedCount} closed trades (${pnlSummary.wins}W/${pnlSummary.losses}L)
- Risk: drawdown ${(status.risk.drawdownPct * 100).toFixed(1)}% of ${(status.risk.drawdownLimitPct * 100).toFixed(1)}% limit, trading ${status.risk.tradingPaused ? 'PAUSED' : 'active'}, ${status.openPositionCount} open position(s)

User question: "${question}"

Respond with ONLY this JSON: {"answer": "<your answer>"}`;
    return await askLLM(prompt);
  } catch (e) {
    console.warn('LLM fallback unavailable, using static response:', e.message);
    if (best) {
      return `My highest conviction right now is ${best.pair} at ${best.convictionScore}/100 (${best.state}${best.state !== 'FAULT' ? ', ' + best.direction.toUpperCase() : ''}).`;
    }
    return "I didn't catch that. Try asking about a specific coin, balance, today's P&L, strategy, or stop-loss.";
  }
}

module.exports = { buildExplanation };
