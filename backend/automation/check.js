// rebalancer/check.js
import { analyzeWallet } from "../services/executionEngine.js";
const a = await analyzeWallet(process.argv[2], process.argv[3] ?? "suix-5");
console.log({ status: a.status, maxDrift: a.maxDrift, total: a.totalUsdValue });
console.table(a.analysis.map(t => ({ sym: t.symbol, target: t.target_weight, current: +t.current_weight.toFixed(4), drift: +t.drift.toFixed(4) })));
console.log("uninvested:", a.uninvested, "stale:", a.staleHoldings.length);
