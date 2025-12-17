import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { Agent } from "undici";
import "dotenv/config";

/**
 * ----------------------------------------------------------------------------
 * HOW TO RUN:
 * node --expose-gc benchmark.js
 * (The --expose-gc flag is required for accurate memory cleanup between runs)
 * ----------------------------------------------------------------------------
 */

/**
 * ----------------------------------------------------------------------------
 * CONFIGURATION
 * ----------------------------------------------------------------------------
 */
const CONFIG = {
  // Execution
  iterations: int(process.env.ITERATIONS, 10),
  runs: int(process.env.RUNS, 3),
  warmupRuns: int(process.env.WARMUP_RUNS, 1),

  // Network / Target
  testAddress:
    process.env.TEST_ADDRESS || "0xcB1C1FdE09f811B294172696404e88E658659905",
  timeoutMs: int(process.env.TIMEOUT_MS, 30000),
  httpCacheMode: validateCache(process.env.HTTP_CACHE_MODE),

  // Pacing
  interRunDelay: int(process.env.INTER_RUN_DELAY, 2000),
  thinkTimeMs: int(process.env.THINK_TIME_MS, 1000),
  jitter: true, // Adds +/- 20% randomness to think time to avoid patterns

  // Analysis
  parseJson: isTrue(process.env.PARSE_JSON, "false"),
  cacheBuster: isTrue(process.env.CACHE_BUSTER, "false"),
  removeOutliers: isTrue(process.env.REMOVE_OUTLIERS, "false"),
  maxErrorBytes: int(process.env.MAX_ERROR_BODY_BYTES, 10000),
  csvPath: process.env.CSV_PATH || "",

  // Apdex threshold (ms) - requests <= T are "satisfied", <= 4T are "tolerating"
  apdexThreshold: int(process.env.APDEX_THRESHOLD, 500),

  // SLO thresholds (ms) - "How often are we under X ms?"
  sloMs: (process.env.SLO_MS || "250,500,1000")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0),
};

// ----------------------------------------------------------------------------
// API DEFINITIONS
// ----------------------------------------------------------------------------
const APIS = [
  {
    id: "moralis",
    name: "Moralis (Avalanche)",
    requiredEnv: "MORALIS_API_KEY",
    // FIX APPLIED: Added &limit=25 to match Glacier's pageSize
    buildUrl: (addr) =>
      `https://deep-index.moralis.io/api/v2.2/${addr}/erc20?chain=avalanche&limit=25`,
    headers: () => ({
      Accept: "application/json",
      "X-API-Key": process.env.MORALIS_API_KEY,
    }),
  },
  {
    id: "glacier",
    name: "Glacier (Avalanche C-Chain)",
    requiredEnv: "GLACIER_API_KEY",
    buildUrl: (addr) =>
      `https://glacier-api.avax.network/v1/chains/43114/addresses/${addr}/balances:listErc20?pageSize=25`,
    headers: () => ({
      Accept: "application/json",
      "x-glacier-api-key": process.env.GLACIER_API_KEY,
    }),
  },
];

// ----------------------------------------------------------------------------
// CORE UTILITIES
// ----------------------------------------------------------------------------
const TEXT_DECODER = new TextDecoder();

// Custom Agent to enforce Connection Reuse (Keep-Alive)
const httpAgent = new Agent({
  keepAliveTimeout: 30000, // 30s keep-alive window
  keepAliveMaxTimeout: 60000, // 60s max
  pipelining: 0,
});

function int(val, def) {
  const num = parseInt(val, 10);
  return isNaN(num) ? def : num;
}

function isTrue(val, def) {
  return (val || def).toLowerCase() === "true";
}

function validateCache(mode) {
  const allowed = new Set([
    "default",
    "no-store",
    "reload",
    "no-cache",
    "force-cache",
    "only-if-cached",
  ]);
  const m = (mode || "no-store").trim();
  return allowed.has(m) ? m : "no-store";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function tryGC() {
  if (global.gc) global.gc();
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

/**
 * ----------------------------------------------------------------------------
 * CLASS: STATS CALCULATOR
 * ----------------------------------------------------------------------------
 */
class StatsCalculator {
  static analyze(results, removeOutliers) {
    const hasSlo = Array.isArray(CONFIG.sloMs) && CONFIG.sloMs.length > 0;

    // Core counts
    const total = results.length;
    const successRaw = results.filter((r) => r.success);
    const successTotal = successRaw.length;
    const failures = total - successTotal;
    const successRate = total > 0 ? successTotal / total : 0;

    // Status counts
    const statusCounts = {};
    results.forEach((r) => {
      const k = String(r.status);
      statusCounts[k] = (statusCounts[k] || 0) + 1;
    });

    // Reliability stats
    const timeouts = results.filter((r) => r.errorType === "timeout").length;
    const rateLimits = results.filter((r) => r.status === 429).length;

    // Cache telemetry (all HTTP responses)
    const httpResponses = results.filter((r) => r.status !== 0);
    const cfCacheHits = httpResponses.filter(
      (r) => r.cfCacheStatus === "HIT"
    ).length;
    const cfCacheMisses = httpResponses.filter(
      (r) => r.cfCacheStatus === "MISS"
    ).length;

    // RAW (success-only) arrays
    const successTtfbRaw = successRaw
      .map((r) => r.ttfb)
      .sort((a, b) => a - b);

    // TTFB P95 from RAW successes (not filtered)
    const ttfbP95 = StatsCalculator.percentile(successTtfbRaw, 95);

    // Outlier filtering (latency only)
    let dataset = successRaw;
    let outliers = 0;

    if (removeOutliers && successRaw.length >= 4) {
      const sorted = [...successRaw].sort((a, b) => a.latency - b.latency);
      const q1 = StatsCalculator.percentile(
        sorted.map((x) => x.latency),
        25
      );
      const q3 = StatsCalculator.percentile(
        sorted.map((x) => x.latency),
        75
      );
      const iqr = q3 - q1;
      const lower = q1 - 1.5 * iqr;
      const upper = q3 + 1.5 * iqr;

      dataset = successRaw.filter(
        (r) => r.latency >= lower && r.latency <= upper
      );
      outliers = successRaw.length - dataset.length;
    }

    if (dataset.length === 0) {
      return {
        total,
        successTotal,
        successFiltered: 0,
        successRate,
        failures,
        outliers,
        rateLimits,
        timeouts,
        statusCounts,
        cfCacheHits,
        cfCacheMisses,
        error: "No successful requests",
      };
    }

    // Metric extraction helpers
    const getMetric = (fn) => dataset.map(fn).sort((a, b) => a - b);
    const latency = getMetric((r) => r.latency);
    const downloadEnd = getMetric((r) => r.downloadEndMs);
    const ttfb = getMetric((r) => r.ttfb);
    const cpu = getMetric((r) => r.processingLatency);
    const size = getMetric((r) => r.size);

    const avgLatency = StatsCalculator.mean(latency);
    const stdDevLatency = StatsCalculator.stdDev(latency);

    // Effective metrics (failures treated as timeoutMs)
    const effectiveLatencies = results.map((r) =>
      r.success ? r.latency : CONFIG.timeoutMs
    );
    const effectiveP95 = StatsCalculator.percentile(
      [...effectiveLatencies].sort((a, b) => a - b),
      95
    );
    const effectiveAvg = StatsCalculator.mean(effectiveLatencies);

    // Failure latency (slow-fail vs fast-fail)
    const failLat = results.filter((r) => !r.success).map((r) => r.latency);
    const failureAvg = StatsCalculator.mean(failLat);
    const failureP95 = StatsCalculator.percentile(
      [...failLat].sort((a, b) => a - b),
      95
    );

    // SLO compliance (failures count as NOT meeting SLO)
    const slo = {};
    if (hasSlo) {
      for (const t of CONFIG.sloMs) {
        const ok = results.filter((r) => r.success && r.latency <= t).length;
        slo[`le_${t}ms`] = total > 0 ? ok / total : 0;
      }
    }

    // Cache-adjusted latency - HIT vs MISS breakdown (SUCCESS-ONLY, RAW)
    const hits = successRaw.filter((r) => r.cfCacheStatus === "HIT");
    const misses = successRaw.filter((r) => r.cfCacheStatus === "MISS");
    const hitLat = hits.map((r) => r.latency).sort((a, b) => a - b);
    const missLat = misses.map((r) => r.latency).sort((a, b) => a - b);
    const cacheBreakdown = {
      hitCount: hits.length,
      missCount: misses.length,
      hitP95: hits.length >= 2 ? StatsCalculator.percentile(hitLat, 95) : null,
      missP95:
        misses.length >= 2 ? StatsCalculator.percentile(missLat, 95) : null,
    };

    // Apdex
    const T = CONFIG.apdexThreshold;
    let satisfied = 0,
      tolerating = 0;
    results.forEach((r) => {
      if (!r.success) return; // Frustrated
      if (r.latency <= T) satisfied++;
      else if (r.latency <= 4 * T) tolerating++;
    });
    const apdex = total > 0 ? (satisfied + tolerating * 0.5) / total : 0;

    // First vs steady state (keep-alive impact)
    const firstSuccess = results.find((r) => r.success);
    const firstLatency = firstSuccess?.latency ?? null;
    const steadyLatencies = results
      .slice(firstSuccess ? results.indexOf(firstSuccess) + 1 : 1)
      .filter((r) => r.success)
      .map((r) => r.latency);
    const steadyAvg = StatsCalculator.mean(steadyLatencies);

    // Payload size P95 (success-filtered dataset)
    const sizeP95 = StatsCalculator.percentile(size, 95);

    // -----------------------
    // NEW: TTFB share metrics
    // -----------------------
    const ttfbAvg = StatsCalculator.mean(ttfb);
    const p95Latency = StatsCalculator.percentile(latency, 95);
    const ttfbShareAvg = clamp01(avgLatency > 0 ? ttfbAvg / avgLatency : 0);
    const ttfbShareP95 = clamp01(p95Latency > 0 ? ttfbP95 / p95Latency : 0);

    return {
      // Counts
      total,
      successTotal,
      successFiltered: dataset.length,
      successRate,
      failures,
      outliers,
      rateLimits,
      timeouts,
      statusCounts,

      // Key latency stats (filtered successes)
      min: latency[0],
      max: latency[latency.length - 1],
      avg: avgLatency,
      p50: StatsCalculator.percentile(latency, 50),
      p95: p95Latency,
      p99: StatsCalculator.percentile(latency, 99),

      // Advanced
      ttfbP95,
      effectiveP95,
      effectiveAvg,
      failureAvg,
      failureP95,
      apdex,
      slo: hasSlo ? slo : null,
      cacheBreakdown,
      sizeP95,

      // NEW: "where is the time going?"
      ttfbAvg,
      ttfbShareAvg,
      ttfbShareP95,

      // Variability
      stdDev: stdDevLatency,
      cv: avgLatency > 0 ? (stdDevLatency / avgLatency) * 100 : 0,

      // Component breakdown (filtered successes)
      downloadEndAvg: StatsCalculator.mean(downloadEnd),
      cpuAvg: StatsCalculator.mean(cpu),
      sizeAvg: StatsCalculator.mean(size),

      // Cache telemetry (all HTTP responses)
      cfCacheHits,
      cfCacheMisses,

      // Keep-alive
      firstLatency,
      steadyAvg,
      keepAliveSpeedup:
        firstLatency && steadyAvg > 0 ? firstLatency / steadyAvg : null,
    };
  }

  static mean(arr) {
    return arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  static stdDev(arr) {
    if (arr.length < 2) return 0;
    const avg = StatsCalculator.mean(arr);
    return Math.sqrt(
      arr.reduce((s, n) => s + Math.pow(n - avg, 2), 0) / (arr.length - 1)
    );
  }

  static percentile(sorted, p) {
    if (!sorted.length) return 0;
    const rank = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(rank);
    const upper = Math.ceil(rank);
    if (lower === upper) return sorted[lower];
    return (
      sorted[lower] * (1 - (rank - lower)) + sorted[upper] * (rank - lower)
    );
  }
}

/**
 * ----------------------------------------------------------------------------
 * CLASS: BENCHMARK RUNNER
 * ----------------------------------------------------------------------------
 */
class BenchmarkRunner {
  static async measure(url, headers) {
    const finalUrl = BenchmarkRunner.addCacheBuster(url);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.timeoutMs);

    const t0 = performance.now();
    let tHeaders, tDownloadEnd, tEnd;
    let size = 0,
      parseSuccess = true;
    let cfCacheStatus = "none";

    try {
      const res = await fetch(finalUrl, {
        headers,
        signal: controller.signal,
        cache: CONFIG.httpCacheMode,
        dispatcher: httpAgent,
      });

      tHeaders = performance.now(); // TTFB (approx)
      cfCacheStatus = res.headers.get("cf-cache-status") || "none";

      let text;
      if (res.ok) {
        text = await res.text();
        size = Buffer.byteLength(text);
      } else {
        text = await BenchmarkRunner.readLimitedBody(res);
        size = Buffer.byteLength(text);
      }
      tDownloadEnd = performance.now();

      if (CONFIG.parseJson && res.ok) {
        try {
          JSON.parse(text);
        } catch {
          parseSuccess = false;
        }
      }
      tEnd = performance.now();

      return {
        success: res.ok && parseSuccess,
        status: res.status,
        latency: tEnd - t0,
        ttfb: tHeaders - t0,
        downloadEndMs: tDownloadEnd - t0,
        processingLatency: tEnd - tDownloadEnd,
        size,
        cacheControl: res.headers.get("cache-control"),
        cfCacheStatus,
      };
    } catch (e) {
      const tErr = performance.now();
      return {
        success: false,
        status: 0,
        error: e?.message || String(e),
        errorType: e?.name === "AbortError" ? "timeout" : "fetch_error",
        latency: tErr - t0,
        ttfb: 0,
        downloadEndMs: tErr - t0,
        processingLatency: 0,
        size: 0,
        cfCacheStatus: "none",
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  static addCacheBuster(url) {
    if (!CONFIG.cacheBuster) return url;
    const [base, hash] = url.split("#");
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}cb=${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}${hash ? "#" + hash : ""}`;
  }

  static async readLimitedBody(res) {
    const reader = res.body?.getReader();
    if (!reader) return res.text();

    const chunks = [];
    let bytes = 0;

    try {
      while (bytes < CONFIG.maxErrorBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
        bytes += value.length;
      }
      return TEXT_DECODER.decode(Buffer.concat(chunks));
    } finally {
      await reader.cancel();
    }
  }
}

/**
 * ----------------------------------------------------------------------------
 * CLASS: REPORTER
 * ----------------------------------------------------------------------------
 */
class Reporter {
  static formatMs(ms) {
    return ms !== undefined && ms !== null && !isNaN(ms)
      ? ms.toFixed(2) + "ms"
      : "N/A";
  }

  static formatBytes(b) {
    return (b ?? 0) < 1024
      ? `${Math.round(b ?? 0)} B`
      : `${((b ?? 0) / 1024).toFixed(1)} KB`;
  }

  static formatPct01(x) {
    if (!Number.isFinite(x)) return "N/A";
    return `${(x * 100).toFixed(0)}%`;
  }

  static printRun(apiName, run, stats, coldStart) {
    const { formatMs, formatBytes, formatPct01 } = Reporter;

    console.log(
      `\n┌─────────────────────────────────────────────────────────────┐`
    );
    console.log(
      `│ ${apiName.padEnd(45)} RUN ${String(run).padStart(2)}      │`
    );
    console.log(
      `├─────────────────────────────────────────────────────────────┤`
    );

    if (stats.error) {
      console.log(`│ ❌ ERROR: ${stats.error.padEnd(50)}│`);
      console.log(
        `└─────────────────────────────────────────────────────────────┘`
      );
      return;
    }

    const cv = stats.cv ?? 0;
    const apdex = stats.apdex ?? 0;

    const cvLabel = cv < 10 ? "🟢" : cv < 25 ? "🟡" : "🔴";
    const apdexLabel =
      apdex >= 0.94 ? "🟢" : apdex >= 0.85 ? "🟡" : apdex >= 0.7 ? "🟠" : "🔴";

    console.log(
      `│ ✓ ${stats.successTotal} OK  ✗ ${stats.failures} Fail`.padEnd(62) + `│`
    );
    console.log(
      `│ Success:     ${(stats.successRate * 100).toFixed(1)}% (${
        stats.successTotal
      }/${stats.total})`.padEnd(62) + `│`
    );

    console.log(
      `│                                                             │`
    );
    console.log(
      `│ LATENCY:     P50        P95        P99        Eff P95       │`
    );
    console.log(
      `│              ${formatMs(stats.p50).padEnd(9)}  ${formatMs(
        stats.p95
      ).padEnd(9)}  ${formatMs(stats.p99).padEnd(9)}  ${formatMs(
        stats.effectiveP95
      ).padEnd(9)} │`
    );

    console.log(
      `│                                                             │`
    );
    console.log(
      `│ SERVER:      TTFB P95   Cold Start   Payload P95            │`
    );
    console.log(
      `│              ${formatMs(stats.ttfbP95).padEnd(9)}  ${formatMs(
        coldStart
      ).padEnd(11)}  ${formatBytes(stats.sizeP95).padEnd(12)}      │`
    );

    console.log(
      `│                                                             │`
    );
    console.log(
      `│ TTFB SHARE:  Avg: ${formatPct01(stats.ttfbShareAvg).padEnd(
        6
      )}   Tail: ${formatPct01(stats.ttfbShareP95).padEnd(6)}   (TTFB/Total)     │`
    );

    console.log(
      `│                                                             │`
    );
    console.log(
      `│ QUALITY:     Apdex@${CONFIG.apdexThreshold}ms  CV       Eff Avg           │`
    );
    console.log(
      `│              ${apdexLabel} ${apdex.toFixed(2).padEnd(6)}  ${cvLabel} ${cv
        .toFixed(0)
        .padStart(2)}%     ${formatMs(stats.effectiveAvg).padEnd(9)}         │`
    );

    if (stats.failures > 0) {
      console.log(
        `│ Fail Lat:    Avg ${formatMs(stats.failureAvg).padEnd(
          9
        )}  P95 ${formatMs(stats.failureP95).padEnd(9)}`.padEnd(62) + `│`
      );
    }

    // SLO compliance
    if (stats.slo && Array.isArray(CONFIG.sloMs) && CONFIG.sloMs.length > 0) {
      const sloStr = CONFIG.sloMs
        .map((t) => {
          const pct = ((stats.slo[`le_${t}ms`] ?? 0) * 100).toFixed(0);
          return `≤${t}ms: ${pct}%`;
        })
        .join("  ");
      console.log(`│ SLO:         ${sloStr}`.padEnd(62) + `│`);
    }

    // Cache breakdown
    const cb = stats.cacheBreakdown;
    if (cb && (cb.hitCount > 0 || cb.missCount > 0)) {
      const hitStr = cb.hitP95 != null ? formatMs(cb.hitP95) : "N/A";
      const missStr = cb.missP95 != null ? formatMs(cb.missP95) : "N/A";
      console.log(
        `│ CACHE P95:   HIT: ${hitStr.padEnd(10)} MISS: ${missStr.padEnd(
          10
        )} (${cb.hitCount}/${cb.missCount})`.padEnd(62) + `│`
      );
    }

    if ((stats.timeouts ?? 0) > 0 || (stats.rateLimits ?? 0) > 0) {
      console.log(
        `│                                                             │`
      );
      if ((stats.timeouts ?? 0) > 0)
        console.log(`│ ⚠️  Timeouts: ${stats.timeouts}`.padEnd(62) + `│`);
      if ((stats.rateLimits ?? 0) > 0)
        console.log(`│ ⚠️  Rate Limits: ${stats.rateLimits}`.padEnd(62) + `│`);
    }

    console.log(
      `└─────────────────────────────────────────────────────────────┘`
    );
  }
}

// ----------------------------------------------------------------------------
// CSV UTILITIES
// ----------------------------------------------------------------------------
function csvEscape(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function saveCsv(data) {
  const headers = Object.keys(data[0]).map(csvEscape).join(",");
  const rows = data.map((d) => Object.values(d).map(csvEscape).join(","));
  writeFileSync(CONFIG.csvPath, [headers, ...rows].join("\n"));
  console.log(`\n💾 CSV saved to ${CONFIG.csvPath}`);
}

// ----------------------------------------------------------------------------
// MAIN EXECUTION
// ----------------------------------------------------------------------------
async function main() {
  console.log(`\n🚀 BENCHMARK STARTED`);
  console.log(
    `   Iter: ${CONFIG.iterations} | Runs: ${CONFIG.runs} | Warmup: ${CONFIG.warmupRuns}`
  );
  console.log(
    `   Agent: Keep-Alive 30s | Think Time: ~${CONFIG.thinkTimeMs}ms (w/ Jitter)`
  );
  console.log(
    `   Cache Mode: ${CONFIG.httpCacheMode} | Parse JSON: ${CONFIG.parseJson}`
  );

  const activeApis = APIS.filter((api) => process.env[api.requiredEnv]);
  if (!activeApis.length)
    return console.error("❌ No APIs configured in .env");

  const summaryData = [];

  process.on("SIGINT", () => {
    console.log("\n⚠️  Caught Interrupt! Saving partial results...");
    if (CONFIG.csvPath && summaryData.length) {
      saveCsv(summaryData);
    }
    process.exit();
  });

  for (const api of activeApis) {
    for (let run = 1; run <= CONFIG.runs; run++) {
      tryGC();

      const coldRes = await BenchmarkRunner.measure(
        api.buildUrl(CONFIG.testAddress),
        api.headers()
      );
      const coldStartMs = coldRes.success ? coldRes.latency : null;

      if (CONFIG.warmupRuns > 0) {
        for (let i = 0; i < CONFIG.warmupRuns; i++) {
          await BenchmarkRunner.measure(
            api.buildUrl(CONFIG.testAddress),
            api.headers()
          );
          await sleep(50);
        }
      }

      const results = [];
      const url = api.buildUrl(CONFIG.testAddress);
      const headers = api.headers();

      for (let i = 0; i < CONFIG.iterations; i++) {
        results.push(await BenchmarkRunner.measure(url, headers));

        if (CONFIG.thinkTimeMs > 0 && i < CONFIG.iterations - 1) {
          const jitter = CONFIG.jitter ? Math.random() * 0.4 - 0.2 : 0;
          await sleep(CONFIG.thinkTimeMs * (1 + jitter));
        }
      }

      const stats = StatsCalculator.analyze(results, CONFIG.removeOutliers);
      Reporter.printRun(api.name, run, stats, coldStartMs);

      // CSV data
      const hasSlo = Array.isArray(CONFIG.sloMs) && CONFIG.sloMs.length > 0;
      const sloData = {};
      if (hasSlo && stats.slo) {
        for (const t of CONFIG.sloMs) {
          sloData[`slo_${t}ms`] = stats.slo[`le_${t}ms`];
        }
      }

      summaryData.push({
        api: api.name,
        run,
        p50: stats.p50,
        p95: stats.p95,
        p99: stats.p99,
        effectiveP95: stats.effectiveP95,
        effectiveAvg: stats.effectiveAvg,
        ttfbP95: stats.ttfbP95,
        ttfbAvg: stats.ttfbAvg,
        ttfbShareAvg: stats.ttfbShareAvg,
        ttfbShareP95: stats.ttfbShareP95,
        apdex: stats.apdex,
        failureAvg: stats.failureAvg,
        failureP95: stats.failureP95,
        sizeP95: stats.sizeP95,
        ...sloData,
        coldStart: coldStartMs,
        cv: stats.cv,
        successRate: stats.successRate,
        failures: stats.failures,
      });

      if (run < CONFIG.runs) await sleep(CONFIG.interRunDelay);
    }
  }

  // Final Comparison
  if (summaryData.length > 1) {
    console.log(`\n${"═".repeat(100)}`);
    console.log(`  🏆 FINAL COMPARISON (Ranked by Effective P95)`);
    console.log(`${"═".repeat(100)}`);

    const hasSlo = Array.isArray(CONFIG.sloMs) && CONFIG.sloMs.length > 0;

    const aggregated = activeApis
      .map((api) => {
        const runs = summaryData.filter((d) => d.api === api.name);

        const sloAvg = {};
        if (hasSlo) {
          for (const t of CONFIG.sloMs) {
            sloAvg[`slo_${t}ms`] = StatsCalculator.mean(
              runs.map((r) => r[`slo_${t}ms`] || 0)
            );
          }
        }

        return {
          name: api.name,
          effectiveP95: StatsCalculator.mean(runs.map((r) => r.effectiveP95)),
          effectiveAvg: StatsCalculator.mean(runs.map((r) => r.effectiveAvg)),
          apdex: StatsCalculator.mean(runs.map((r) => r.apdex)),
          successRate: StatsCalculator.mean(runs.map((r) => r.successRate)),
          failureP95: StatsCalculator.mean(runs.map((r) => r.failureP95 || 0)),
          sizeP95: StatsCalculator.mean(runs.map((r) => r.sizeP95 || 0)),
          ttfbShareAvg: StatsCalculator.mean(
            runs.map((r) => r.ttfbShareAvg || 0)
          ),
          ttfbShareP95: StatsCalculator.mean(
            runs.map((r) => r.ttfbShareP95 || 0)
          ),
          ...sloAvg,
        };
      })
      .sort((a, b) => a.effectiveP95 - b.effectiveP95);

    const sloHeaders = hasSlo
      ? CONFIG.sloMs.map((t) => `≤${t}ms`.padEnd(7)).join(" ")
      : "";

    console.log(
      `  ${"API".padEnd(26)} ${"Eff P95".padEnd(10)} ${"Succ".padEnd(6)} ${
        hasSlo ? sloHeaders + " " : ""
      }${"TTFB%".padEnd(7)} ${"TailTTFB%".padEnd(10)} ${"Apdex".padEnd(6)}`
    );
    console.log(`  ${"─".repeat(98)}`);

    aggregated.forEach((a, i) => {
      const medal = ["🥇", "🥈", "🥉"][i] || "  ";
      const apdexLabel = Number.isFinite(a.apdex)
        ? a.apdex >= 0.94
          ? "🟢"
          : a.apdex >= 0.85
          ? "🟡"
          : a.apdex >= 0.7
          ? "🟠"
          : "🔴"
        : "⚫";
      const apdexStr = Number.isFinite(a.apdex)
        ? a.apdex.toFixed(2)
        : "N/A";
      const succStr = Number.isFinite(a.successRate)
        ? `${(a.successRate * 100).toFixed(0)}%`.padEnd(6)
        : "N/A".padEnd(6);

      const sloValues = hasSlo
        ? CONFIG.sloMs
            .map((t) => {
              const val = a[`slo_${t}ms`];
              return Number.isFinite(val)
                ? `${(val * 100).toFixed(0)}%`.padEnd(7)
                : "N/A".padEnd(7);
            })
            .join(" ")
        : "";

      const ttfbPct = Reporter.formatPct01(a.ttfbShareAvg).padEnd(7);
      const tailTtfbPct = Reporter.formatPct01(a.ttfbShareP95).padEnd(10);

      console.log(
        `${medal} ${a.name.padEnd(26)} ${Reporter.formatMs(
          a.effectiveP95
        ).padEnd(10)} ${succStr} ${
          hasSlo ? sloValues + " " : ""
        }${ttfbPct} ${tailTtfbPct} ${apdexLabel} ${apdexStr}`
      );
    });

    const validApis = aggregated.filter((a) =>
      Number.isFinite(a.effectiveP95)
    );
    if (validApis.length >= 2) {
      const winner = validApis[0];
      const loser = validApis[1];
      const speedup = (loser.effectiveP95 / winner.effectiveP95).toFixed(1);
      console.log(`  ${"─".repeat(98)}`);
      console.log(
        `  📊 ${winner.name} is ${speedup}x faster (Effective P95)`
      );
    }
    console.log(`${"═".repeat(100)}`);
  }

  if (CONFIG.csvPath && summaryData.length) {
    saveCsv(summaryData);
  }
}

main().catch(console.error);
