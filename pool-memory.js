/**
 * Pool memory — persistent deploy history per pool.
 *
 * Keyed by pool address. Automatically updated when positions close
 * (via recordPerformance in lessons.js). Agent can query before deploying.
 */

import fs from "fs";
import { log } from "./logger.js";

const POOL_MEMORY_FILE = "./pool-memory.json";

function load() {
  if (!fs.existsSync(POOL_MEMORY_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(POOL_MEMORY_FILE, "utf8"));
  } catch {
    return {};
  }
}

function save(data) {
  fs.writeFileSync(POOL_MEMORY_FILE, JSON.stringify(data, null, 2));
}

// ─── Write ─────────────────────────────────────────────────────

/**
 * Record a closed deploy into pool-memory.json.
 * Called automatically from recordPerformance() in lessons.js.
 *
 * @param {string} poolAddress
 * @param {Object} deployData
 * @param {string} deployData.pool_name
 * @param {string} deployData.base_mint
 * @param {string} deployData.deployed_at
 * @param {string} deployData.closed_at
 * @param {number} deployData.pnl_pct
 * @param {number} deployData.pnl_usd
 * @param {number} deployData.range_efficiency
 * @param {number} deployData.minutes_held
 * @param {string} deployData.close_reason
 * @param {string} deployData.strategy
 * @param {number} deployData.volatility
 */
export function recordPoolDeploy(poolAddress, deployData) {
  if (!poolAddress) return;

  const db = load();

  if (!db[poolAddress]) {
    db[poolAddress] = {
      name: deployData.pool_name || poolAddress.slice(0, 8),
      base_mint: deployData.base_mint || null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
    };
  }

  const entry = db[poolAddress];

  const deploy = {
    deployed_at: deployData.deployed_at || null,
    closed_at: deployData.closed_at || new Date().toISOString(),
    pnl_pct: deployData.pnl_pct ?? null,
    pnl_usd: deployData.pnl_usd ?? null,
    range_efficiency: deployData.range_efficiency ?? null,
    minutes_held: deployData.minutes_held ?? null,
    close_reason: deployData.close_reason || null,
    strategy: deployData.strategy || null,
    volatility_at_deploy: deployData.volatility ?? null,
  };

  entry.deploys.push(deploy);
  entry.total_deploys = entry.deploys.length;
  entry.last_deployed_at = deploy.closed_at;
  entry.last_outcome = (deploy.pnl_pct ?? 0) >= 0 ? "profit" : "loss";

  // Recompute aggregates
  const withPnl = entry.deploys.filter((d) => d.pnl_pct != null);
  if (withPnl.length > 0) {
    entry.avg_pnl_pct = Math.round(
      (withPnl.reduce((s, d) => s + d.pnl_pct, 0) / withPnl.length) * 100
    ) / 100;
    entry.win_rate = Math.round(
      (withPnl.filter((d) => d.pnl_pct >= 0).length / withPnl.length) * 100
    ) / 100;
  }

  if (deployData.base_mint && !entry.base_mint) {
    entry.base_mint = deployData.base_mint;
  }

  save(db);
  log("pool-memory", `Recorded deploy for ${entry.name} (${poolAddress.slice(0, 8)}): PnL ${deploy.pnl_pct}%`);
}

// ─── Read ──────────────────────────────────────────────────────

/**
 * Tool handler: get_pool_memory
 * Returns deploy history and summary for a pool.
 */
export function getPoolMemory({ pool_address }) {
  if (!pool_address) return { error: "pool_address required" };

  const db = load();
  const entry = db[pool_address];

  if (!entry) {
    return {
      pool_address,
      known: false,
      message: "No history for this pool — first time deploying here.",
    };
  }

  return {
    pool_address,
    known: true,
    name: entry.name,
    base_mint: entry.base_mint,
    total_deploys: entry.total_deploys,
    avg_pnl_pct: entry.avg_pnl_pct,
    win_rate: entry.win_rate,
    last_deployed_at: entry.last_deployed_at,
    last_outcome: entry.last_outcome,
    notes: entry.notes,
    history: entry.deploys.slice(-10), // last 10 deploys
  };
}

/**
 * Record a live position snapshot during a management cycle.
 * Builds a trend dataset while position is still open — not just at close.
 * Keeps last 48 snapshots per pool (~4h at 5min intervals).
 */
export function recordPositionSnapshot(poolAddress, snapshot) {
  if (!poolAddress) return;
  const db = load();

  if (!db[poolAddress]) {
    db[poolAddress] = {
      name: snapshot.pair || poolAddress.slice(0, 8),
      base_mint: null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
      snapshots: [],
    };
  }

  if (!db[poolAddress].snapshots) db[poolAddress].snapshots = [];

  db[poolAddress].snapshots.push({
    ts: new Date().toISOString(),
    position: snapshot.position,
    pnl_pct: snapshot.pnl_pct ?? null,
    pnl_usd: snapshot.pnl_usd ?? null,
    in_range: snapshot.in_range ?? null,
    unclaimed_fees_usd: snapshot.unclaimed_fees_usd ?? null,
    minutes_out_of_range: snapshot.minutes_out_of_range ?? null,
    age_minutes: snapshot.age_minutes ?? null,
  });

  // Keep last 48 snapshots (~4h at 5min intervals)
  if (db[poolAddress].snapshots.length > 48) {
    db[poolAddress].snapshots = db[poolAddress].snapshots.slice(-48);
  }

  save(db);
}

/**
 * Recall focused context for a specific pool — used before screening or management.
 * Returns a short formatted string ready for injection into the agent goal.
 */
export function recallForPool(poolAddress) {
  if (!poolAddress) return null;
  const db = load();
  const entry = db[poolAddress];
  if (!entry) return null;

  const lines = [];

  // Deploy history summary
  if (entry.total_deploys > 0) {
    lines.push(`POOL MEMORY [${entry.name}]: ${entry.total_deploys} past deploy(s), avg PnL ${entry.avg_pnl_pct}%, win rate ${entry.win_rate}%, last outcome: ${entry.last_outcome}`);
  }

  // Recent snapshot trend (last 6 = ~30min)
  const snaps = (entry.snapshots || []).slice(-6);
  if (snaps.length >= 2) {
    const first = snaps[0];
    const last = snaps[snaps.length - 1];
    const pnlTrend = last.pnl_pct != null && first.pnl_pct != null
      ? (last.pnl_pct - first.pnl_pct).toFixed(2)
      : null;
    const oorCount = snaps.filter(s => s.in_range === false).length;
    lines.push(`RECENT TREND: PnL drift ${pnlTrend !== null ? (pnlTrend >= 0 ? "+" : "") + pnlTrend + "%" : "unknown"} over last ${snaps.length} cycles, OOR in ${oorCount}/${snaps.length} cycles`);
  }

  // Notes
  if (entry.notes?.length > 0) {
    const lastNote = entry.notes[entry.notes.length - 1];
    lines.push(`NOTE: ${lastNote.note}`);
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * Tool handler: add_pool_note
 * Agent can annotate a pool with a freeform note.
 */
export function addPoolNote({ pool_address, note }) {
  if (!pool_address) return { error: "pool_address required" };
  if (!note) return { error: "note required" };

  const db = load();

  if (!db[pool_address]) {
    db[pool_address] = {
      name: pool_address.slice(0, 8),
      base_mint: null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
    };
  }

  db[pool_address].notes.push({
    note,
    added_at: new Date().toISOString(),
  });

  save(db);
  log("pool-memory", `Note added to ${pool_address.slice(0, 8)}: ${note}`);
  return { saved: true, pool_address, note };
}

/**
 * Calculate PnL velocity — how fast is PnL changing over recent snapshots.
 * Returns an object with velocity data for the MANAGER agent to use.
 *
 * Velocity < -5 per cycle = DANGER (rapid IL accumulation)
 * Velocity < -2 per cycle = WARNING
 * Velocity >= 0 = OK
 */
export function getPnlVelocity(poolAddress) {
  if (!poolAddress) return null;
  const db = load();
  const entry = db[poolAddress];
  if (!entry || !entry.snapshots || entry.snapshots.length < 3) return null;

  const snaps = entry.snapshots.slice(-6); // last 6 snapshots = ~30min
  const withPnl = snaps.filter(s => s.pnl_pct != null);
  if (withPnl.length < 2) return null;

  const oldest = withPnl[0].pnl_pct;
  const newest = withPnl[withPnl.length - 1].pnl_pct;
  const totalDrop = newest - oldest;
  const velocityPerCycle = totalDrop / (withPnl.length - 1);

  // Check if consistently dropping (not just one bad point)
  let droppingCount = 0;
  for (let i = 1; i < withPnl.length; i++) {
    if (withPnl[i].pnl_pct < withPnl[i - 1].pnl_pct) droppingCount++;
  }
  const consistentDrop = droppingCount >= Math.floor(withPnl.length * 0.6);

  // Fee accumulation rate
  const feeSnaps = snaps.filter(s => s.unclaimed_fees_usd != null);
  const latestFees = feeSnaps.length > 0 ? feeSnaps[feeSnaps.length - 1].unclaimed_fees_usd : 0;

  return {
    velocity_per_cycle: Math.round(velocityPerCycle * 100) / 100,
    total_drop_pct: Math.round(totalDrop * 100) / 100,
    current_pnl_pct: newest,
    consistent_drop: consistentDrop,
    unclaimed_fees_usd: latestFees,
    cycles_analyzed: withPnl.length,
    alert: velocityPerCycle < -5 ? "DANGER" : velocityPerCycle < -2 ? "WARNING" : "OK",
  };
}

/**
 * Check if a position should be emergency closed based on PnL velocity.
 * Returns { should_close: bool, reason: string }
 */
export function checkEmergencyClose(poolAddress, emergencyDropPct = -35) {
  const vel = getPnlVelocity(poolAddress);
  if (!vel) return { should_close: false, reason: "Insufficient data" };

  // Emergency: PnL already past stop loss
  if (vel.current_pnl_pct <= emergencyDropPct) {
    return { should_close: true, reason: `PnL ${vel.current_pnl_pct}% hit stop loss ${emergencyDropPct}%` };
  }

  // Velocity danger: dropping fast AND consistently AND will hit stop loss soon
  if (vel.alert === "DANGER" && vel.consistent_drop) {
    const cyclesUntilStopLoss = vel.velocity_per_cycle < 0
      ? (emergencyDropPct - vel.current_pnl_pct) / vel.velocity_per_cycle
      : Infinity;
    if (cyclesUntilStopLoss <= 3) {
      return {
        should_close: true,
        reason: `PnL velocity DANGER: ${vel.velocity_per_cycle}%/cycle, will hit stop loss in ~${Math.ceil(cyclesUntilStopLoss)} cycles`
      };
    }
  }

  // Warning: fees earned but being eroded faster than accumulating
  if (vel.alert === "WARNING" && vel.consistent_drop && vel.unclaimed_fees_usd < 0.5) {
    return {
      should_close: false,
      reason: `PnL declining (${vel.velocity_per_cycle}%/cycle) but fees insufficient to justify risk`,
      warn: true,
    };
  }

  return { should_close: false, reason: `Velocity ${vel.velocity_per_cycle}%/cycle (${vel.alert})` };
}