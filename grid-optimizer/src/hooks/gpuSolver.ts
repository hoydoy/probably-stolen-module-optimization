import type {InventoryItem, Stats} from '../types';
import {applyInternalEffects, PRECOMPUTED_ORIENTATIONS} from '../utils';
import {
    runOptimizationEngine,
    buildSearchPool,
    buildIneligibleFlags,
    calculateBoardStats,
    computeTiers,
    createObjective,
    generateCodeFromState,
    indexInventoryById,
    isSpecialModule,
    isLumpyModule,
    isForcedModule,
    countEffect,
    statIsIgnored,
    statIsScored,
    BALANCE_PENALTY_WEIGHT,
    PRIORITY_WEIGHT_STEP,
    STAT_KEYS
} from './useOptimizer';
import type {MachineConfig, Objective} from './useOptimizer';

type Board = (InventoryItem | 'Locked' | null)[][];

export interface SolverStatus {
    backend: 'cpu' | 'gpu';
    message: string;
    fallback?: boolean;
}

export type EngineUpdate = Map<string, { board: any[][], totals: Stats, pieceStats: Map<string, Stats>, code: string }>;

export type EngineRunner = (
    machines: MachineConfig[],
    initialBoards: any[][][],
    searchPoolInventory: InventoryItem[],
    fullInventory: InventoryItem[],
    isSolvingRef: { current: boolean },
    onUpdate: (updates: EngineUpdate) => void,
    onStatus?: (status: SolverStatus) => void
) => Promise<void>;

const MMAX = 8;
const CELLS = 35;
const PMAX = 320;
const TMAX = 8;
const MI = 24;
const PI = 12;
const OR = 16;
const CHS = MMAX * CELLS + PMAX;
const OBJS = 8;
const DBGS = 64;
const WORKGROUP = 64;

const WGSL = `
const MMAX: u32 = ${MMAX}u;
const CELLS: u32 = ${CELLS}u;
const PMAX: u32 = ${PMAX}u;
const MI: u32 = ${MI}u;
const PI: u32 = ${PI}u;
const OR: u32 = ${OR}u;
const CHS: u32 = ${CHS}u;
const OBJS: u32 = ${OBJS}u;
const DBGS: u32 = ${DBGS}u;

struct Params {
    chainCount: u32,
    pieceCount: u32,
    machineCount: u32,
    tierCount: u32,
    poolCount: u32,
    steps: u32,
    seed: u32,
    forcedCount: u32,
    tMin: f32,
    tMax: f32,
    balanceWeight: f32,
    tScale: f32,
};

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> minfo: array<i32>;
@group(0) @binding(2) var<storage, read> pinfo: array<i32>;
@group(0) @binding(3) var<storage, read> orients: array<i32>;
@group(0) @binding(4) var<storage, read> pvalue: array<f32>;
@group(0) @binding(5) var<storage, read_write> chains: array<i32>;
@group(0) @binding(6) var<storage, read_write> chainObj: array<f32>;
@group(0) @binding(7) var<storage, read_write> dbg: array<i32>;

var<private> cells: array<i32, ${MMAX * CELLS}>;
var<private> pm: array<i32, ${PMAX}>;
var<private> rngState: u32;
var<private> mTot: array<i32, ${MMAX * 3}>;
var<private> mBal: array<f32, ${MMAX * 3}>;
var<private> mPieces: array<i32, ${MMAX}>;
var<private> mForced: array<i32, ${MMAX}>;
var<private> svForced: array<i32, 2>;
var<private> cur: array<f32, ${OBJS}>;
var<private> nw: array<f32, ${OBJS}>;
var<private> snapA: array<i32, ${CELLS}>;
var<private> snapB: array<i32, ${CELLS}>;
var<private> svTot: array<i32, 6>;
var<private> svBal: array<f32, 6>;
var<private> svPieces: array<i32, 2>;
var<private> jp: array<i32, 8>;
var<private> jold: array<i32, 8>;
var<private> jn: u32;

fn rand_u32() -> u32 {
    rngState = rngState * 747796405u + 2891336453u;
    let w = ((rngState >> ((rngState >> 28u) + 4u)) ^ rngState) * 277803737u;
    return (w >> 22u) ^ w;
}

fn rand_f() -> f32 {
    return f32(rand_u32() >> 8u) * (1.0 / 16777216.0);
}

fn rand_below(n: u32) -> u32 {
    if (n == 0u) { return 0u; }
    return rand_u32() % n;
}

fn mi(m: u32, k: u32) -> i32 { return minfo[m * MI + k]; }
fn pinf(p: u32, k: u32) -> i32 { return pinfo[p * PI + k]; }
fn is_node(p: i32) -> bool { return (pinf(u32(p), 3u) & 1) != 0; }

fn eval_machine(m: u32) {
    let rows = u32(mi(m, 0u));
    let cols = u32(mi(m, 1u));
    let n = rows * cols;
    let base = m * CELLS;

    var slotPiece: array<i32, 36>;
    var slotMinX: array<i32, 36>;
    var slotMinY: array<i32, 36>;
    var cellSlot: array<i32, 35>;
    var ns: u32 = 0u;

    for (var i: u32 = 0u; i < n; i++) {
        let pid = cells[base + i];
        if (pid < 0) { cellSlot[i] = -1; continue; }
        var s: i32 = -1;
        for (var j: u32 = 0u; j < ns; j++) {
            if (slotPiece[j] == pid) { s = i32(j); break; }
        }
        let x = i32(i % cols);
        let y = i32(i / cols);
        if (s < 0) {
            s = i32(ns);
            slotPiece[ns] = pid;
            slotMinX[ns] = x;
            slotMinY[ns] = y;
            ns++;
        } else {
            if (x < slotMinX[s]) { slotMinX[s] = x; }
        }
        cellSlot[i] = s;
    }

    var nodeAdjLo: array<u32, 36>;
    var nodeAdjHi: array<u32, 36>;
    var pieceNodeLo: array<u32, 36>;
    var pieceNodeHi: array<u32, 36>;

    for (var i: u32 = 0u; i < n; i++) {
        let s = cellSlot[i];
        if (s < 0) { continue; }
        if (!is_node(slotPiece[s])) { continue; }
        let x = i32(i % cols);
        let y = i32(i / cols);
        for (var d: u32 = 0u; d < 4u; d++) {
            var nx = x;
            var ny = y;
            if (d == 0u) { ny = y - 1; }
            else if (d == 1u) { ny = y + 1; }
            else if (d == 2u) { nx = x - 1; }
            else { nx = x + 1; }
            if (nx < 0 || nx >= i32(cols) || ny < 0 || ny >= i32(rows)) { continue; }
            let t = cellSlot[u32(ny) * cols + u32(nx)];
            if (t < 0) { continue; }
            if (is_node(slotPiece[t])) { continue; }
            if (t < 32) { nodeAdjLo[s] = nodeAdjLo[s] | (1u << u32(t)); }
            else { nodeAdjHi[s] = nodeAdjHi[s] | (1u << u32(t - 32)); }
            if (s < 32) { pieceNodeLo[t] = pieceNodeLo[t] | (1u << u32(s)); }
            else { pieceNodeHi[t] = pieceNodeHi[t] | (1u << u32(s - 32)); }
        }
    }

    var absP: array<i32, 36>;
    var absQ: array<i32, 36>;
    var absE: array<i32, 36>;

    for (var s: u32 = 0u; s < ns; s++) {
        let pid = slotPiece[s];
        let fl = pinf(u32(pid), 3u);
        if ((fl & 1) != 0) { continue; }
        let nf = (fl >> 4u) & 3;
        if (nf == 0) { continue; }
        var seenLo: u32 = 0u;
        var seenHi: u32 = 0u;
        var nfP: i32 = 0;
        var nfQ: i32 = 0;
        var nfE: i32 = 0;
        for (var i: u32 = 0u; i < n; i++) {
            if (cellSlot[i] != i32(s)) { continue; }
            let x = i32(i % cols);
            let y = i32(i / cols);
            for (var d: u32 = 0u; d < 4u; d++) {
                var nx = x;
                var ny = y;
                if (d == 0u) { ny = y - 1; }
                else if (d == 1u) { ny = y + 1; }
                else if (d == 2u) { nx = x - 1; }
                else { nx = x + 1; }
                if (nx < 0 || nx >= i32(cols) || ny < 0 || ny >= i32(rows)) { continue; }
                let t = cellSlot[u32(ny) * cols + u32(nx)];
                if (t < 0 || t == i32(s)) { continue; }
                if (is_node(slotPiece[t])) { continue; }
                var seen = false;
                if (t < 32) { seen = (seenLo & (1u << u32(t))) != 0u; }
                else { seen = (seenHi & (1u << u32(t - 32))) != 0u; }
                if (seen) { continue; }
                if (t < 32) { seenLo = seenLo | (1u << u32(t)); }
                else { seenHi = seenHi | (1u << u32(t - 32)); }
                let tp = u32(slotPiece[t]);
                let bp = pinf(tp, 5u);
                let bq = pinf(tp, 6u);
                let be = pinf(tp, 7u);
                if (bp < 0) { nfP += bp; }
                if (bq < 0) { nfQ += bq; }
                if (be < 0) { nfE += be; }
            }
        }
        absP[s] = nf * nfP;
        absQ[s] = nf * nfQ;
        absE[s] = nf * nfE;
    }

    var totP: i32 = 0;
    var totQ: i32 = 0;
    var totE: i32 = 0;
    var lumpP: f32 = 0.0;
    var lumpQ: f32 = 0.0;
    var lumpE: f32 = 0.0;
    var forcedCnt: i32 = 0;

    for (var s: u32 = 0u; s < ns; s++) {
        let pid = u32(slotPiece[s]);
        let fl = pinf(pid, 3u);
        if ((fl & 1) != 0) {
            var sumP: i32 = 0;
            var sumQ: i32 = 0;
            var sumE: i32 = 0;
            for (var t: u32 = 0u; t < ns; t++) {
                var adj = false;
                if (t < 32u) { adj = (nodeAdjLo[s] & (1u << t)) != 0u; }
                else { adj = (nodeAdjHi[s] & (1u << (t - 32u))) != 0u; }
                if (!adj) { continue; }
                let tp = u32(slotPiece[t]);
                sumP += pinf(tp, 5u);
                sumQ += pinf(tp, 6u);
                sumE += pinf(tp, 7u);
            }
            totP += sumP / 5;
            totQ += sumQ / 5;
            totE += sumE / 5;
            continue;
        }

        let p = pinf(pid, 5u);
        let q = pinf(pid, 6u);
        let e = pinf(pid, 7u);
        var pB: i32 = 0;
        var qB: i32 = 0;
        var eB: i32 = 0;
        if ((fl & 2) != 0 && slotMinX[s] == 0) { pB += p / 5; qB += q / 5; eB += e / 5; }
        if ((fl & 4) != 0 && slotMinY[s] == 0) { pB += p / 5; qB += q / 5; eB += e / 5; }
        let adjn = i32(countOneBits(pieceNodeLo[s]) + countOneBits(pieceNodeHi[s]));
        if ((fl & 8) != 0) { pB += (p * adjn) / 10; qB += (q * adjn) / 10; eB += (e * adjn) / 10; }

        let fp = ((p + pB) * 4 + absP[s]) / 4;
        let fq = ((q + qB) * 4 + absQ[s]) / 4;
        let fe = ((e + eB) * 4 + absE[s]) / 4;
        totP += fp;
        totQ += fq;
        totE += fe;
        if ((fl & 128) != 0) { forcedCnt++; }

        if ((fl & 64) != 0) {
            let factor = 1.0 + 0.2 * f32(adjn);
            lumpP += f32(fp) * factor;
            lumpQ += f32(fq) * factor;
            lumpE += f32(fe) * factor;
        }
    }

    mTot[m * 3u] = totP;
    mTot[m * 3u + 1u] = totQ;
    mTot[m * 3u + 2u] = totE;
    mBal[m * 3u] = f32(totP) - lumpP;
    mBal[m * 3u + 1u] = f32(totQ) - lumpQ;
    mBal[m * 3u + 2u] = f32(totE) - lumpE;
    mPieces[m] = i32(ns);
    mForced[m] = forcedCnt;
}

fn compute_obj() {
    let tc = P.tierCount;
    let mc = P.machineCount;
    for (var t: u32 = 0u; t <= tc; t++) { nw[t] = 0.0; }
    var pieces: i32 = 0;
    var forcedSum: i32 = 0;
    for (var m: u32 = 0u; m < mc; m++) {
        pieces += mPieces[m];
        forcedSum += mForced[m];
        for (var k: u32 = 0u; k < 3u; k++) {
            let b = 3u + k * 5u;
            if (mi(m, b) != 0) { continue; }
            let ti = u32(mi(m, b + 4u));
            let tot = mTot[m * 3u + k];
            if (mi(m, b + 2u) != 0) {
                let tg = mi(m, b + 3u);
                if (tot < tg) { nw[ti] = nw[ti] - f32(tg - tot) * 10000.0; }
            }
            if (mi(m, b + 1u) != 0) { nw[ti] = nw[ti] + f32(tot) * 10.0; }
        }
    }
    nw[tc] = nw[tc] - f32(pieces) * 5.0;
    nw[0] = f32(forcedSum);

    if (mc > 1u) {
        for (var k: u32 = 0u; k < 3u; k++) {
            for (var t: u32 = 0u; t < tc; t++) {
                var sum: f32 = 0.0;
                var count: f32 = 0.0;
                for (var m: u32 = 0u; m < mc; m++) {
                    if (mi(m, 18u + k) == 0) { continue; }
                    if (u32(mi(m, 3u + k * 5u + 4u)) != t) { continue; }
                    sum += mBal[m * 3u + k];
                    count += 1.0;
                }
                if (count > 1.0) {
                    let avg = sum / count;
                    var mad: f32 = 0.0;
                    for (var m: u32 = 0u; m < mc; m++) {
                        if (mi(m, 18u + k) == 0) { continue; }
                        if (u32(mi(m, 3u + k * 5u + 4u)) != t) { continue; }
                        mad += abs(mBal[m * 3u + k] - avg);
                    }
                    nw[t] = nw[t] - (mad / count) * P.balanceWeight;
                }
            }
        }
    }
}

fn accept_move(temp: f32) -> bool {
    let tc = P.tierCount;
    for (var i: u32 = 0u; i <= tc; i++) {
        let d = nw[i] - cur[i];
        if (d != 0.0) {
            if (d > 0.0) { return true; }
            return rand_f() < exp(d / temp);
        }
    }
    return rand_f() < 0.5;
}

fn journal(p: u32) {
    if (jn < 8u) {
        jp[jn] = i32(p);
        jold[jn] = pm[p];
        jn++;
    }
}

fn remove_piece(p: u32, m: u32) {
    journal(p);
    let n = u32(mi(m, 2u));
    let base = m * CELLS;
    for (var i: u32 = 0u; i < n; i++) {
        if (cells[base + i] == i32(p)) { cells[base + i] = -1; }
    }
    pm[p] = -1;
}

fn try_place(p: u32, m: u32) -> bool {
    let oc = u32(pinf(p, 1u));
    if (oc == 0u) { return false; }
    let rows = i32(mi(m, 0u));
    let cols = i32(mi(m, 1u));
    let n = u32(mi(m, 2u));
    let base = m * CELLS;

    var emptyCount: u32 = 0u;
    var chosen: u32 = 0u;
    for (var i: u32 = 0u; i < n; i++) {
        if (cells[base + i] == -1) {
            emptyCount++;
            if (rand_below(emptyCount) == 0u) { chosen = i; }
        }
    }
    if (emptyCount == 0u) { return false; }

    let o = u32(pinf(p, 0u)) + rand_below(oc);
    let ob = o * OR;
    let cnt = u32(orients[ob]);
    let j = rand_below(cnt);
    let ex = i32(chosen) % cols;
    let ey = i32(chosen) / cols;
    let ax = ex - orients[ob + 5u + j];
    let ay = ey - orients[ob + 10u + j];
    if (ax + orients[ob + 1u] < 0 || ax + orients[ob + 2u] >= cols) { return false; }
    if (ay + orients[ob + 3u] < 0 || ay + orients[ob + 4u] >= rows) { return false; }
    for (var i: u32 = 0u; i < cnt; i++) {
        let idx = u32((ay + orients[ob + 10u + i]) * cols + (ax + orients[ob + 5u + i]));
        if (cells[base + idx] != -1) { return false; }
    }
    for (var i: u32 = 0u; i < cnt; i++) {
        let idx = u32((ay + orients[ob + 10u + i]) * cols + (ax + orients[ob + 5u + i]));
        cells[base + idx] = i32(p);
    }
    journal(p);
    pm[p] = i32(m);
    return true;
}

fn choose_unplaced(m: u32) -> i32 {
    let pc = P.poolCount;
    if (pc == 0u) { return -1; }
    if (P.forcedCount > 0u && rand_below(3u) == 0u) {
        let fp = rand_below(P.forcedCount);
        if (pm[fp] == -1 && ((pinf(fp, 8u) >> m) & 1) != 0) { return i32(fp); }
    }
    let tournament = rand_below(2u) == 0u;
    var best: i32 = -1;
    var bestV: f32 = -1.0e30;
    var found: u32 = 0u;
    for (var a: u32 = 0u; a < 10u; a++) {
        let p = rand_below(pc);
        if (pm[p] != -1) { continue; }
        if (((pinf(p, 8u) >> m) & 1) == 0) { continue; }
        if (!tournament) { return i32(p); }
        let v = pvalue[m * P.pieceCount + p];
        if (v > bestV) { bestV = v; best = i32(p); }
        found++;
        if (found >= 3u) { break; }
    }
    return best;
}

fn choose_occupied(m: u32, poolOnly: bool) -> i32 {
    let n = u32(mi(m, 2u));
    if (n == 0u) { return -1; }
    let base = m * CELLS;
    for (var a: u32 = 0u; a < 10u; a++) {
        let ci = rand_below(n);
        let pid = cells[base + ci];
        if (pid < 0) { continue; }
        let kind = (pinf(u32(pid), 3u) >> 8u) & 3;
        if (kind == 2) { continue; }
        if (poolOnly && kind != 0) { continue; }
        return pid;
    }
    return -1;
}

fn snapshot(m: u32, which: u32) {
    let base = m * CELLS;
    if (which == 0u) {
        for (var i: u32 = 0u; i < CELLS; i++) { snapA[i] = cells[base + i]; }
        svTot[0] = mTot[m * 3u]; svTot[1] = mTot[m * 3u + 1u]; svTot[2] = mTot[m * 3u + 2u];
        svBal[0] = mBal[m * 3u]; svBal[1] = mBal[m * 3u + 1u]; svBal[2] = mBal[m * 3u + 2u];
        svPieces[0] = mPieces[m];
        svForced[0] = mForced[m];
    } else {
        for (var i: u32 = 0u; i < CELLS; i++) { snapB[i] = cells[base + i]; }
        svTot[3] = mTot[m * 3u]; svTot[4] = mTot[m * 3u + 1u]; svTot[5] = mTot[m * 3u + 2u];
        svBal[3] = mBal[m * 3u]; svBal[4] = mBal[m * 3u + 1u]; svBal[5] = mBal[m * 3u + 2u];
        svPieces[1] = mPieces[m];
        svForced[1] = mForced[m];
    }
}

fn restore(m: u32, which: u32) {
    let base = m * CELLS;
    if (which == 0u) {
        for (var i: u32 = 0u; i < CELLS; i++) { cells[base + i] = snapA[i]; }
        mTot[m * 3u] = svTot[0]; mTot[m * 3u + 1u] = svTot[1]; mTot[m * 3u + 2u] = svTot[2];
        mBal[m * 3u] = svBal[0]; mBal[m * 3u + 1u] = svBal[1]; mBal[m * 3u + 2u] = svBal[2];
        mPieces[m] = svPieces[0];
        mForced[m] = svForced[0];
    } else {
        for (var i: u32 = 0u; i < CELLS; i++) { cells[base + i] = snapB[i]; }
        mTot[m * 3u] = svTot[3]; mTot[m * 3u + 1u] = svTot[4]; mTot[m * 3u + 2u] = svTot[5];
        mBal[m * 3u] = svBal[3]; mBal[m * 3u + 1u] = svBal[4]; mBal[m * 3u + 2u] = svBal[5];
        mPieces[m] = svPieces[1];
        mForced[m] = svForced[1];
    }
}

fn rollback_pm() {
    var k: u32 = jn;
    loop {
        if (k == 0u) { break; }
        k--;
        pm[u32(jp[k])] = jold[k];
    }
}

fn step(temp: f32) {
    let mc = P.machineCount;
    let mA = rand_below(mc);
    var mB: i32 = -1;
    jn = 0u;
    snapshot(mA, 0u);

    let r = rand_f();
    var ok = false;

    if (r < 0.35) {
        let q = choose_unplaced(mA);
        if (q >= 0) { ok = try_place(u32(q), mA); }
    } else if (r < 0.50) {
        let p = choose_occupied(mA, true);
        if (p >= 0) { remove_piece(u32(p), mA); ok = true; }
    } else if (r < 0.75) {
        let p = choose_occupied(mA, false);
        if (p >= 0) {
            remove_piece(u32(p), mA);
            ok = try_place(u32(p), mA);
            if (!ok) { ok = try_place(u32(p), mA); }
        }
    } else if (r < 0.90 || mc == 1u) {
        let p = choose_occupied(mA, true);
        if (p >= 0) {
            remove_piece(u32(p), mA);
            let q = choose_unplaced(mA);
            if (q >= 0) { ok = try_place(u32(q), mA); }
        }
    } else {
        var other = rand_below(mc - 1u);
        if (other >= mA) { other = other + 1u; }
        let p = choose_occupied(mA, true);
        if (p >= 0 && ((pinf(u32(p), 8u) >> other) & 1) != 0) {
            mB = i32(other);
            snapshot(other, 1u);
            remove_piece(u32(p), mA);
            ok = try_place(u32(p), other);
        }
    }

    if (!ok) {
        restore(mA, 0u);
        if (mB >= 0) { restore(u32(mB), 1u); }
        rollback_pm();
        return;
    }

    eval_machine(mA);
    if (mB >= 0) { eval_machine(u32(mB)); }
    compute_obj();

    if (accept_move(temp)) {
        for (var i: u32 = 0u; i <= P.tierCount; i++) { cur[i] = nw[i]; }
    } else {
        restore(mA, 0u);
        if (mB >= 0) { restore(u32(mB), 1u); }
        rollback_pm();
    }
}

fn load_chain(c: u32) {
    let off = c * CHS;
    for (var i: u32 = 0u; i < MMAX * CELLS; i++) { cells[i] = chains[off + i]; }
    for (var p: u32 = 0u; p < P.pieceCount; p++) { pm[p] = chains[off + MMAX * CELLS + p]; }
}

fn store_chain(c: u32) {
    let off = c * CHS;
    for (var i: u32 = 0u; i < MMAX * CELLS; i++) { chains[off + i] = cells[i]; }
    for (var p: u32 = 0u; p < P.pieceCount; p++) { chains[off + MMAX * CELLS + p] = pm[p]; }
}

fn eval_all() {
    for (var m: u32 = 0u; m < P.machineCount; m++) { eval_machine(m); }
    compute_obj();
    for (var i: u32 = 0u; i < OBJS; i++) { cur[i] = nw[i]; }
}

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let c = gid.x;
    if (c >= P.chainCount) { return; }
    load_chain(c);
    rngState = ((c + 1u) * 2654435761u) ^ (P.seed * 2246822519u + 374761393u);
    rand_u32(); rand_u32(); rand_u32();
    eval_all();

    let denom = f32(max(P.chainCount, 2u) - 1u);
    let f = f32(c) / denom;
    let chainTemp = P.tMin * pow(P.tMax / P.tMin, f) * P.tScale;

    for (var s: u32 = 0u; s < P.steps; s++) { step(chainTemp); }

    store_chain(c);
    for (var i: u32 = 0u; i < OBJS; i++) { chainObj[c * OBJS + i] = cur[i]; }
}

@compute @workgroup_size(${WORKGROUP})
fn eval_only(@builtin(global_invocation_id) gid: vec3<u32>) {
    let c = gid.x;
    if (c >= P.chainCount) { return; }
    load_chain(c);
    eval_all();
    let o = c * DBGS;
    for (var m: u32 = 0u; m < P.machineCount; m++) {
        dbg[o + m * 7u] = mTot[m * 3u];
        dbg[o + m * 7u + 1u] = mTot[m * 3u + 1u];
        dbg[o + m * 7u + 2u] = mTot[m * 3u + 2u];
        dbg[o + m * 7u + 3u] = mPieces[m];
        dbg[o + m * 7u + 4u] = bitcast<i32>(mBal[m * 3u]);
        dbg[o + m * 7u + 5u] = bitcast<i32>(mBal[m * 3u + 1u]);
        dbg[o + m * 7u + 6u] = bitcast<i32>(mBal[m * 3u + 2u]);
    }
    for (var i: u32 = 0u; i < OBJS; i++) { dbg[o + 56u + i] = bitcast<i32>(cur[i]); }
}
`;

interface PieceEntry {
    item: InventoryItem;
    kind: 0 | 1 | 2;
    owner: number;
}

export interface GpuProblem {
    machines: MachineConfig[];
    initialBoards: Board[];
    pieces: PieceEntry[];
    poolCount: number;
    forcedCount: number;
    machineInfo: Int32Array;
    pieceInfo: Int32Array;
    orients: Int32Array;
    pieceValue: Float32Array;
    chain0: Int32Array;
    objective: Objective;
    rows: number[];
    cols: number[];
    pieceIndex: Map<string, number>;
}

export const buildGpuProblem = (
    machines: MachineConfig[],
    initialBoards: Board[],
    searchPoolInventory: InventoryItem[],
    fullInventory: InventoryItem[]
): GpuProblem | string => {
    const machineCount = machines.length;
    if (machineCount === 0) return 'no machines to solve';
    if (machineCount > MMAX) return `more than ${MMAX} machines`;

    const rows = initialBoards.map(b => b.length);
    const cols = initialBoards.map(b => b[0]?.length ?? 0);
    for (let m = 0; m < machineCount; m++) {
        if (rows[m] * cols[m] > CELLS) return 'a grid is larger than 7x5';
    }

    const objective = createObjective(machines, fullInventory);
    if (objective.tierCount + 1 > TMAX) return 'too many priority levels';

    const precomputedInternal = new Map<string, Stats>();
    fullInventory.forEach(item => precomputedInternal.set(item.id, applyInternalEffects(item)));

    let pool = buildSearchPool(searchPoolInventory, precomputedInternal, machines);
    const totalCells = rows.reduce((sum, r, m) => sum + r * cols[m], 0);
    const maxNodes = Math.ceil(totalCells / 2) + 4;
    let nodeCount = 0;
    pool = pool.filter(item => {
        if (item.color !== 'White') return true;
        nodeCount++;
        return nodeCount <= maxNodes;
    });

    pool = [...pool.filter(isForcedModule), ...pool.filter(item => !isForcedModule(item))];
    const forcedCount = pool.filter(isForcedModule).length;
    const poolIds = new Set(pool.map(item => item.id));
    const extraPool: PieceEntry[] = [];
    const ownedFixed: PieceEntry[] = [];
    const seenOnBoard = new Set<string>();
    initialBoards.forEach((board, m) => board.forEach(row => row.forEach(cell => {
        if (!cell || cell === 'Locked' || seenOnBoard.has(cell.id)) return;
        seenOnBoard.add(cell.id);
        if (cell.isStuck) ownedFixed.push({item: cell, kind: 2, owner: m});
        else if (isSpecialModule(cell) || cell.isLocked) ownedFixed.push({item: cell, kind: 1, owner: m});
        else if (!poolIds.has(cell.id)) extraPool.push({item: cell, kind: 0, owner: -1});
    })));

    const poolEntries: PieceEntry[] = pool.map(item => ({item, kind: 0 as const, owner: -1}));
    const pieces: PieceEntry[] = [...poolEntries, ...extraPool, ...ownedFixed];
    const poolCount = poolEntries.length + extraPool.length;
    if (pieces.length > PMAX) return `more than ${PMAX} modules`;

    extraPool.forEach(entry => {
        if (!precomputedInternal.has(entry.item.id)) precomputedInternal.set(entry.item.id, applyInternalEffects(entry.item));
    });
    ownedFixed.forEach(entry => {
        if (!precomputedInternal.has(entry.item.id)) precomputedInternal.set(entry.item.id, applyInternalEffects(entry.item));
    });

    const orientRecords: number[] = [];
    const shapeTable = new Map<string, [number, number]>();
    for (const entry of pieces) {
        const shape = entry.item.shape;
        if (shapeTable.has(shape)) continue;
        const ors = PRECOMPUTED_ORIENTATIONS.get(shape);
        if (!ors) return `unknown shape ${shape}`;
        const start = orientRecords.length / OR;
        for (const o of ors) {
            const rec = new Array(OR).fill(0);
            rec[0] = o.count;
            rec[1] = o.minX;
            rec[2] = o.maxX;
            rec[3] = o.minY;
            rec[4] = o.maxY;
            for (let i = 0; i < o.count; i++) {
                rec[5 + i] = o.xs[i];
                rec[10 + i] = o.ys[i];
            }
            orientRecords.push(...rec);
        }
        shapeTable.set(shape, [start, ors.length]);
    }

    const poolItems = pieces.slice(0, poolCount).map(e => e.item);
    const ineligible = buildIneligibleFlags(machines, poolItems, i => precomputedInternal.get(poolItems[i].id)!, initialBoards);

    const pieceCount = pieces.length;
    const pieceInfo = new Int32Array(Math.max(pieceCount, 1) * PI);
    pieces.forEach((entry, p) => {
        const item = entry.item;
        const internal = precomputedInternal.get(item.id)!;
        const [start, count] = shapeTable.get(item.shape)!;
        const orientations = PRECOMPUTED_ORIENTATIONS.get(item.shape)!;
        let flags = 0;
        if (item.color === 'White') flags |= 1;
        if (item.effects.includes('Side Mount')) flags |= 2;
        if (item.effects.includes('Top Mount')) flags |= 4;
        if (item.effects.includes('Receiver')) flags |= 8;
        flags |= (Math.min(countEffect(item, 'Negative Feedback'), 3)) << 4;
        if (isLumpyModule(item)) flags |= 64;
        if (isForcedModule(item)) flags |= 128;
        flags |= entry.kind << 8;

        let mask = 0;
        if (entry.kind === 0) {
            for (let m = 0; m < machineCount; m++) if (ineligible[m][p] !== 1) mask |= (1 << m);
        } else {
            mask = 1 << entry.owner;
        }

        const o = p * PI;
        pieceInfo[o] = start;
        pieceInfo[o + 1] = count;
        pieceInfo[o + 2] = orientations[0].count;
        pieceInfo[o + 3] = flags;
        pieceInfo[o + 4] = entry.owner;
        pieceInfo[o + 5] = internal.Performance;
        pieceInfo[o + 6] = internal.Quality;
        pieceInfo[o + 7] = internal.Efficiency;
        pieceInfo[o + 8] = mask;
    });

    const machineInfo = new Int32Array(MMAX * MI);
    const pieceValue = new Float32Array(Math.max(machineCount * pieceCount, 1));
    machines.forEach((m, mi) => {
        const o = mi * MI;
        machineInfo[o] = rows[mi];
        machineInfo[o + 1] = cols[mi];
        machineInfo[o + 2] = rows[mi] * cols[mi];
        STAT_KEYS.forEach((key, k) => {
            const b = o + 3 + k * 5;
            const ignored = statIsIgnored(m, key);
            const hasTarget = m.targetStats[key] !== null;
            machineInfo[b] = ignored ? 1 : 0;
            machineInfo[b + 1] = m.maximizeStats[key] ? 1 : 0;
            machineInfo[b + 2] = hasTarget ? 1 : 0;
            machineInfo[b + 3] = hasTarget ? Math.round(m.targetStats[key] as number) : 0;
            machineInfo[b + 4] = ignored ? 0 : objective.tierOf(m, key);
            machineInfo[o + 18 + k] = (!ignored && m.maximizeStats[key] && !hasTarget) ? 1 : 0;
        });
        for (let p = 0; p < pieceCount; p++) {
            const internal = precomputedInternal.get(pieces[p].item.id)!;
            let value = 0;
            for (const key of STAT_KEYS) {
                if (!statIsScored(m, key)) continue;
                value += internal[key] * Math.pow(PRIORITY_WEIGHT_STEP, objective.tierCount - 1 - objective.tierOf(m, key));
            }
            pieceValue[mi * pieceCount + p] = value;
        }
    });

    const chain0 = new Int32Array(CHS).fill(-2);
    for (let p = 0; p < PMAX; p++) chain0[MMAX * CELLS + p] = -1;
    const pieceIndex = new Map<string, number>();
    pieces.forEach((entry, p) => pieceIndex.set(entry.item.id, p));
    for (let m = 0; m < machineCount; m++) {
        for (let y = 0; y < rows[m]; y++) {
            for (let x = 0; x < cols[m]; x++) {
                const cell = initialBoards[m][y][x];
                const idx = m * CELLS + y * cols[m] + x;
                if (cell === 'Locked') chain0[idx] = -2;
                else if (cell === null || cell === undefined) chain0[idx] = -1;
                else {
                    const p = pieceIndex.get(cell.id);
                    if (p === undefined) return 'a module on the board is unknown to the solver';
                    chain0[idx] = p;
                    chain0[MMAX * CELLS + p] = m;
                }
            }
        }
    }

    return {
        machines, initialBoards, pieces, poolCount, forcedCount, machineInfo, pieceInfo,
        orients: new Int32Array(orientRecords), pieceValue, chain0, objective, rows, cols, pieceIndex
    };
};

export const boardsToState = (problem: GpuProblem, boards: Board[]): Int32Array | null => {
    const state = new Int32Array(CHS).fill(-2);
    for (let p = 0; p < PMAX; p++) state[MMAX * CELLS + p] = -1;
    for (let m = 0; m < problem.machines.length; m++) {
        for (let y = 0; y < problem.rows[m]; y++) {
            for (let x = 0; x < problem.cols[m]; x++) {
                const cell = boards[m][y][x];
                const idx = m * CELLS + y * problem.cols[m] + x;
                if (cell === 'Locked') state[idx] = -2;
                else if (cell === null || cell === undefined) state[idx] = -1;
                else {
                    const p = problem.pieceIndex.get(cell.id);
                    if (p === undefined) return null;
                    state[idx] = p;
                    state[MMAX * CELLS + p] = m;
                }
            }
        }
    }
    return state;
};

export const decodeChain = (problem: GpuProblem, state: Int32Array): Board[] =>
    problem.machines.map((_, m) => {
        const board: Board = [];
        for (let y = 0; y < problem.rows[m]; y++) {
            const row: (InventoryItem | 'Locked' | null)[] = [];
            for (let x = 0; x < problem.cols[m]; x++) {
                const v = state[m * CELLS + y * problem.cols[m] + x];
                if (v === -2) row.push('Locked');
                else if (v < 0) row.push(null);
                else row.push(problem.pieces[v].item);
            }
            board.push(row);
        }
        return board;
    });

const compareTiersLocal = (a: ArrayLike<number>, b: ArrayLike<number>, len: number) => {
    for (let i = 0; i < len; i++) {
        if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return 0;
};

interface GpuContext {
    device: any;
    adapterLabel: string;
    isSoftware: boolean;
    paramsBuf: any;
    minfoBuf: any;
    pinfoBuf: any;
    orientBuf: any;
    pvalueBuf: any;
    chainsBuf: any;
    chainObjBuf: any;
    dbgBuf: any;
    stagingObj: any;
    stagingState: any;
    stagingDbg: any;
    mainPipeline: any;
    evalPipeline: any;
    bindGroup: any;
    chainCount: number;
    pieceCount: number;
    machineCount: number;
    tierCount: number;
    poolCount: number;
    forcedCount: number;
    lost: boolean;
}

const writeParams = (ctx: GpuContext, steps: number, seed: number, _mode: number, tMin: number, tMax: number, tScale: number) => {
    const buf = new ArrayBuffer(48);
    const u = new Uint32Array(buf);
    const f = new Float32Array(buf);
    u[0] = ctx.chainCount;
    u[1] = ctx.pieceCount;
    u[2] = ctx.machineCount;
    u[3] = ctx.tierCount;
    u[4] = ctx.poolCount;
    u[5] = steps;
    u[6] = seed >>> 0;
    u[7] = ctx.forcedCount;
    f[8] = tMin;
    f[9] = tMax;
    f[10] = BALANCE_PENALTY_WEIGHT;
    f[11] = tScale;
    ctx.device.queue.writeBuffer(ctx.paramsBuf, 0, buf);
};

export const createGpuContext = async (problem: GpuProblem, chainCount: number): Promise<GpuContext> => {
    const gpu = (navigator as any).gpu;
    if (!gpu) throw new Error('WebGPU is not supported by this browser');
    const adapter = await gpu.requestAdapter({powerPreference: 'high-performance'});
    if (!adapter) throw new Error('no GPU adapter is available');
    const device = await adapter.requestDevice();

    let info: any = adapter.info;
    if (!info && typeof adapter.requestAdapterInfo === 'function') info = await adapter.requestAdapterInfo();
    const parts = [info?.vendor, info?.architecture, info?.device, info?.description].filter((x: any) => x);
    const adapterLabel = parts.length > 0 ? parts.join(' ') : 'unknown GPU';
    const isSoftware = Boolean(adapter.isFallbackAdapter) || /swiftshader|llvmpipe|software/i.test(adapterLabel);

    const ctx: GpuContext = {
        device,
        adapterLabel,
        isSoftware,
        paramsBuf: null,
        minfoBuf: null,
        pinfoBuf: null,
        orientBuf: null,
        pvalueBuf: null,
        chainsBuf: null,
        chainObjBuf: null,
        dbgBuf: null,
        stagingObj: null,
        stagingState: null,
        stagingDbg: null,
        mainPipeline: null,
        evalPipeline: null,
        bindGroup: null,
        chainCount,
        pieceCount: problem.pieces.length,
        machineCount: problem.machines.length,
        tierCount: problem.objective.tierCount,
        poolCount: problem.poolCount,
        forcedCount: problem.forcedCount,
        lost: false
    };
    device.lost.then(() => {
        ctx.lost = true;
    });

    const U = (globalThis as any).GPUBufferUsage;
    const mk = (size: number, usage: number) => device.createBuffer({
        size: Math.max(16, Math.ceil(size / 4) * 4),
        usage
    });
    const upload = (buf: any, data: ArrayBufferView) => device.queue.writeBuffer(buf, 0, data as any);

    ctx.paramsBuf = mk(48, U.UNIFORM | U.COPY_DST);
    ctx.minfoBuf = mk(problem.machineInfo.byteLength, U.STORAGE | U.COPY_DST);
    ctx.pinfoBuf = mk(problem.pieceInfo.byteLength, U.STORAGE | U.COPY_DST);
    ctx.orientBuf = mk(problem.orients.byteLength, U.STORAGE | U.COPY_DST);
    ctx.pvalueBuf = mk(problem.pieceValue.byteLength, U.STORAGE | U.COPY_DST);
    ctx.chainsBuf = mk(chainCount * CHS * 4, U.STORAGE | U.COPY_DST | U.COPY_SRC);
    ctx.chainObjBuf = mk(chainCount * OBJS * 4, U.STORAGE | U.COPY_SRC);
    ctx.dbgBuf = mk(chainCount * DBGS * 4, U.STORAGE | U.COPY_SRC);
    ctx.stagingObj = mk(chainCount * OBJS * 4, U.MAP_READ | U.COPY_DST);
    ctx.stagingState = mk(CHS * 4, U.MAP_READ | U.COPY_DST);
    ctx.stagingDbg = mk(chainCount * DBGS * 4, U.MAP_READ | U.COPY_DST);

    upload(ctx.minfoBuf, problem.machineInfo);
    upload(ctx.pinfoBuf, problem.pieceInfo);
    upload(ctx.orientBuf, problem.orients);
    upload(ctx.pvalueBuf, problem.pieceValue);

    device.pushErrorScope('validation');
    const module = device.createShaderModule({code: WGSL});
    const compilation = await module.getCompilationInfo();
    const errors = compilation.messages.filter((m: any) => m.type === 'error');
    if (errors.length > 0) {
        throw new Error('shader compile error: ' + errors.map((m: any) => `${m.lineNum}:${m.linePos} ${m.message}`).join(' | '));
    }
    const stage = (globalThis as any).GPUShaderStage.COMPUTE;
    const bindGroupLayout = device.createBindGroupLayout({
        entries: [
            {binding: 0, visibility: stage, buffer: {type: 'uniform'}},
            {binding: 1, visibility: stage, buffer: {type: 'read-only-storage'}},
            {binding: 2, visibility: stage, buffer: {type: 'read-only-storage'}},
            {binding: 3, visibility: stage, buffer: {type: 'read-only-storage'}},
            {binding: 4, visibility: stage, buffer: {type: 'read-only-storage'}},
            {binding: 5, visibility: stage, buffer: {type: 'storage'}},
            {binding: 6, visibility: stage, buffer: {type: 'storage'}},
            {binding: 7, visibility: stage, buffer: {type: 'storage'}}
        ]
    });
    const pipelineLayout = device.createPipelineLayout({bindGroupLayouts: [bindGroupLayout]});
    ctx.mainPipeline = await device.createComputePipelineAsync({
        layout: pipelineLayout,
        compute: {module, entryPoint: 'main'}
    });
    ctx.evalPipeline = await device.createComputePipelineAsync({
        layout: pipelineLayout,
        compute: {module, entryPoint: 'eval_only'}
    });
    const scopeError = await device.popErrorScope();
    if (scopeError) throw new Error('GPU validation error: ' + scopeError.message);

    const entries = [
        {binding: 0, resource: {buffer: ctx.paramsBuf}},
        {binding: 1, resource: {buffer: ctx.minfoBuf}},
        {binding: 2, resource: {buffer: ctx.pinfoBuf}},
        {binding: 3, resource: {buffer: ctx.orientBuf}},
        {binding: 4, resource: {buffer: ctx.pvalueBuf}},
        {binding: 5, resource: {buffer: ctx.chainsBuf}},
        {binding: 6, resource: {buffer: ctx.chainObjBuf}},
        {binding: 7, resource: {buffer: ctx.dbgBuf}}
    ];
    ctx.bindGroup = device.createBindGroup({layout: bindGroupLayout, entries});

    const seedChains = new Int32Array(chainCount * CHS);
    for (let c = 0; c < chainCount; c++) seedChains.set(problem.chain0, c * CHS);
    upload(ctx.chainsBuf, seedChains);
    return ctx;
};

export const destroyGpuContext = (ctx: GpuContext) => {
    for (const key of ['paramsBuf', 'minfoBuf', 'pinfoBuf', 'orientBuf', 'pvalueBuf', 'chainsBuf', 'chainObjBuf', 'dbgBuf', 'stagingObj', 'stagingState', 'stagingDbg']) {
        try {
            (ctx as any)[key]?.destroy();
        } catch {
            void 0;
        }
    }
    try {
        ctx.device.destroy();
    } catch {
        void 0;
    }
};

const dispatchMain = async (ctx: GpuContext, steps: number, seed: number, tMin: number, tMax: number, tScale: number): Promise<Float32Array> => {
    writeParams(ctx, steps, seed, 0, tMin, tMax, tScale);
    const encoder = ctx.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(ctx.mainPipeline);
    pass.setBindGroup(0, ctx.bindGroup);
    pass.dispatchWorkgroups(Math.ceil(ctx.chainCount / WORKGROUP));
    pass.end();
    encoder.copyBufferToBuffer(ctx.chainObjBuf, 0, ctx.stagingObj, 0, ctx.chainCount * OBJS * 4);
    ctx.device.queue.submit([encoder.finish()]);
    await ctx.stagingObj.mapAsync((globalThis as any).GPUMapMode.READ);
    const copy = new Float32Array(ctx.stagingObj.getMappedRange().slice(0));
    ctx.stagingObj.unmap();
    return copy;
};

const readChain = async (ctx: GpuContext, chain: number): Promise<Int32Array> => {
    const encoder = ctx.device.createCommandEncoder();
    encoder.copyBufferToBuffer(ctx.chainsBuf, chain * CHS * 4, ctx.stagingState, 0, CHS * 4);
    ctx.device.queue.submit([encoder.finish()]);
    await ctx.stagingState.mapAsync((globalThis as any).GPUMapMode.READ);
    const copy = new Int32Array(ctx.stagingState.getMappedRange().slice(0));
    ctx.stagingState.unmap();
    return copy;
};

export const gpuEvaluateStates = async (ctx: GpuContext, states: Int32Array[]): Promise<Int32Array> => {
    const count = Math.min(states.length, ctx.chainCount);
    const data = new Int32Array(ctx.chainCount * CHS);
    for (let c = 0; c < count; c++) data.set(states[c], c * CHS);
    ctx.device.queue.writeBuffer(ctx.chainsBuf, 0, data);
    const saved = ctx.chainCount;
    writeParams(ctx, 0, 1, 1, 1, 1, 1);
    const encoder = ctx.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(ctx.evalPipeline);
    pass.setBindGroup(0, ctx.bindGroup);
    pass.dispatchWorkgroups(Math.ceil(saved / WORKGROUP));
    pass.end();
    encoder.copyBufferToBuffer(ctx.dbgBuf, 0, ctx.stagingDbg, 0, saved * DBGS * 4);
    ctx.device.queue.submit([encoder.finish()]);
    await ctx.stagingDbg.mapAsync((globalThis as any).GPUMapMode.READ);
    const copy = new Int32Array(ctx.stagingDbg.getMappedRange().slice(0));
    ctx.stagingDbg.unmap();
    return copy;
};

export const DBG_STRIDE = DBGS;
export const CHAIN_STRIDE = CHS;
export const CELLS_PER_MACHINE = CELLS;
export const MAX_PIECES = PMAX;
export const MAX_MACHINES = MMAX;

const T_MIN = 3;
const T_MAX = 300;
const TARGET_DISPATCH_MS = 160;
const ELITE_EVERY = 3;
const ELITE_FRACTION = 0.25;
const POLISH_FIRST_MS = 2500;
const POLISH_EVERY_MS = 4000;
const POLISH_RUN_MS = 1200;

export const runGpuEngine: EngineRunner = async (
    machines,
    initialBoards,
    searchPoolInventory,
    fullInventory,
    isSolvingRef,
    onUpdate,
    onStatus
) => {
    const fallback = async (reason: string, boards: any[][][] = initialBoards) => {
        onStatus?.({backend: 'cpu', fallback: true, message: `GPU unavailable (${reason}). Using the CPU solver.`});
        await runOptimizationEngine(machines, boards, searchPoolInventory, fullInventory, isSolvingRef, onUpdate);
    };

    if (typeof navigator === 'undefined' || !(navigator as any).gpu) {
        return fallback('WebGPU is not supported by this browser');
    }

    const problem = buildGpuProblem(machines, initialBoards as Board[], searchPoolInventory, fullInventory);
    if (typeof problem === 'string') return fallback(problem);

    let ctx: GpuContext;
    try {
        const probe = await (navigator as any).gpu.requestAdapter();
        const software = probe ? (Boolean(probe.isFallbackAdapter) || /swiftshader|llvmpipe|software/i.test(String(probe.info?.architecture ?? ''))) : true;
        ctx = await createGpuContext(problem, software ? 128 : 2048);
    } catch (e: any) {
        return fallback(String(e?.message ?? e).slice(0, 140));
    }

    const inventoryById = indexInventoryById(fullInventory);
    const tierLen = problem.objective.tierCount + 1;
    const tiersOf = (boards: Board[]) => {
        const stats = boards.map(b => calculateBoardStats(b, fullInventory, inventoryById));
        const out = new Float64Array(tierLen);
        computeTiers(out, machines, problem.objective, i => stats[i], i => boards[i]);
        return {stats, tiers: out};
    };

    let bestBoards: Board[] = initialBoards.map(b => b.map(row => [...row])) as Board[];
    let bestEval = tiersOf(bestBoards);
    let bestSnapshot: Int32Array = problem.chain0;
    let bestGpuObj = new Float32Array(tierLen).fill(-Infinity);
    let rejectedObj = new Float32Array(tierLen).fill(-Infinity);
    const codes: string[] = new Array(machines.length).fill('');
    let pending = false;
    let emitCount = 0;

    const emit = () => {
        const updates: EngineUpdate = new Map();
        machines.forEach((m, mIdx) => {
            const usedClones = new Set<string>();
            bestBoards[mIdx].forEach(row => row.forEach(cell => {
                if (cell && cell !== 'Locked' && cell.id.includes('_clone_')) usedClones.add(cell.id);
            }));
            const inventoryForCode = fullInventory.filter(item => !item.id.includes('_clone_') || usedClones.has(item.id));
            codes[mIdx] = generateCodeFromState(m.tier, m.maximizeStats, m.targetStats, inventoryForCode, bestBoards[mIdx]);
            updates.set(m.id, {
                board: bestBoards[mIdx].map(row => [...row]),
                totals: bestEval.stats[mIdx].totals,
                pieceStats: bestEval.stats[mIdx].pieceStats,
                code: codes[mIdx]
            });
        });
        onUpdate(updates);
        pending = false;
        emitCount++;
    };

    const polish = async (boards: Board[]): Promise<Board[] | null> => {
        const ref = {current: true};
        const stopTimer = setTimeout(() => {
            ref.current = false;
        }, POLISH_RUN_MS);
        const watcher = setInterval(() => {
            if (!isSolvingRef.current) ref.current = false;
        }, 100);
        let result: EngineUpdate | null = null;
        try {
            await runOptimizationEngine(machines, boards, searchPoolInventory, fullInventory, ref, u => {
                result = u;
            });
        } finally {
            clearTimeout(stopTimer);
            clearInterval(watcher);
        }
        if (result === null) return null;
        const final: EngineUpdate = result;
        return machines.map(m => final.get(m.id)!.board as Board);
    };

    const seedPopulation = (fraction: number) => {
        const victims = Math.floor(ctx.chainCount * fraction);
        for (let v = 0; v < victims; v++) {
            const target = Math.floor(Math.random() * ctx.chainCount);
            ctx.device.queue.writeBuffer(ctx.chainsBuf, target * CHS * 4, bestSnapshot as any);
        }
    };

    let nextPolishAt = performance.now() + POLISH_FIRST_MS;
    let steps = 16;
    let dispatches = 0;
    let totalSteps = 0;
    let lastStatus = 0;
    const startedAt = performance.now();
    const label = ctx.isSoftware ? `${ctx.adapterLabel} (software)` : ctx.adapterLabel;
    onStatus?.({backend: 'gpu', message: `GPU solver started on ${label} with ${ctx.chainCount} parallel chains.`});

    let failure: string | null = null;
    try {
        while (isSolvingRef.current && !ctx.lost) {
            const t0 = performance.now();
            const tScale = 1;
            const polishNow = performance.now() >= nextPolishAt;
            const dispatchSteps = polishNow ? Math.min(8192, steps * 6) : steps;
            const gpuWork = dispatchMain(ctx, dispatchSteps, (dispatches * 7919 + 13) >>> 0, T_MIN, T_MAX, tScale);
            if (polishNow) {
                const polished = await polish(bestBoards);
                nextPolishAt = performance.now() + POLISH_EVERY_MS;
                if (polished !== null) {
                    const verifiedPolish = tiersOf(polished);
                    const polishedState = boardsToState(problem, polished);
                    if (polishedState !== null && compareTiersLocal(verifiedPolish.tiers, bestEval.tiers, tierLen) > 0) {
                        bestBoards = polished;
                        bestEval = verifiedPolish;
                        bestSnapshot = polishedState;
                        pending = true;
                    }
                }
            }
            const objs = await gpuWork;
            dispatches++;
            totalSteps += dispatchSteps * ctx.chainCount;
            if (polishNow && pending) seedPopulation(ELITE_FRACTION);

            let bestChain = -1;
            for (let c = 0; c < ctx.chainCount; c++) {
                if (bestChain < 0 || compareTiersLocal(objs.subarray(c * OBJS), objs.subarray(bestChain * OBJS), tierLen) > 0) bestChain = c;
            }

            const candidate = objs.subarray(bestChain * OBJS, bestChain * OBJS + tierLen);
            if (compareTiersLocal(candidate, bestGpuObj, tierLen) > 0 && compareTiersLocal(candidate, rejectedObj, tierLen) !== 0) {
                const state = await readChain(ctx, bestChain);
                const boards = decodeChain(problem, state);
                const verified = tiersOf(boards);
                if (compareTiersLocal(verified.tiers, bestEval.tiers, tierLen) > 0) {
                    bestGpuObj = Float32Array.from(candidate);
                    bestBoards = boards;
                    bestEval = verified;
                    bestSnapshot = state;
                    pending = true;
                } else {
                    rejectedObj = Float32Array.from(candidate);
                }
            }
            if (pending) emit();

            if (dispatches % ELITE_EVERY === 0) seedPopulation(ELITE_FRACTION);

            const elapsed = performance.now() - t0;
            const scale = Math.min(2, Math.max(0.5, TARGET_DISPATCH_MS / Math.max(elapsed, 1)));
            steps = Math.min(8192, Math.max(4, Math.round(steps * scale)));

            const now = performance.now();
            if (now - lastStatus > 1000) {
                lastStatus = now;
                const rate = totalSteps / ((now - startedAt) / 1000);
                onStatus?.({
                    backend: 'gpu',
                    message: `GPU solver on ${label}: ${ctx.chainCount} chains, ${(rate / 1e6).toFixed(2)}M search steps/s.`
                });
            }
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        if (ctx.lost) failure = 'the GPU device was lost';
    } catch (e: any) {
        failure = String(e?.message ?? e).slice(0, 140);
    }

    try {
        destroyGpuContext(ctx);
    } catch {
        void 0;
    }

    if (pending) emit();
    if (failure !== null && isSolvingRef.current) {
        await fallback(failure, bestBoards);
        return;
    }
    onStatus?.({
        backend: 'gpu',
        message: `GPU solver stopped (${label}, ${totalSteps.toLocaleString()} search steps).`
    });
};
