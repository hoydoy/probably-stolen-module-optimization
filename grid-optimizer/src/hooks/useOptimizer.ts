import { useState, useRef, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';
import type {GridTier, InventoryItem, Stats, TargetStats, Point, ModuleShape, ModuleColor, ItemEffect} from '../types';
import type { Orientation } from '../utils';
import { getBaseStats, applyInternalEffects, PRECOMPUTED_ORIENTATIONS, roundStat } from '../utils';
import { MODULE_TEMPLATES } from '../constants';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://yhiojdutwgfxrgakbrjs.supabase.co';
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InloaW9qZHV0d2dmeHJnYWticmpzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY0ODcwMjMsImV4cCI6MjEwMjA2MzAyM30.lVkU06tLfM64aFYL2Gx-UMPFL9KCRSaadu58TDWMmSI';
const supabase = createClient(supabaseUrl, supabaseKey);

const SHAPE_MAP: ModuleShape[] = ['Node1x2', 'L3', 'L4_Base', 'T4_Base', 'Square4_Base', 'L4_High', 'T4_High', 'Square4_High', 'P5', 'C5', 'Line4'];
const COLOR_MAP_KEYS: ModuleColor[] = ['White', 'Red', 'Yellow', 'Green', 'Purple', 'DarkRed', 'Grey'];
const EFFECT_MAP: ItemEffect[] = ['None', 'Premium', 'Inferior', 'Overcharged', 'Degrading', 'Negative Feedback', 'Receiver', 'Side Mount', 'Top Mount', 'Learning Algorithm'];

const BASE85_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#";

function encodeBase85(bytes: Uint8Array): string {
    let num = 1n;
    for (let i = 0; i < bytes.length; i++) {
        num = (num << 8n) | BigInt(bytes[i]);
    }
    let str = "";
    while (num > 0n) {
        str = BASE85_ALPHABET[Number(num % 85n)] + str;
        num /= 85n;
    }
    return str;
}

function decodeBase85(str: string): Uint8Array {
    str = str.trim();
    let num = 0n;
    for (let i = 0; i < str.length; i++) {
        const val = BASE85_ALPHABET.indexOf(str[i]);
        if (val === -1) throw new Error("Invalid base85 character");
        num = (num * 85n) + BigInt(val);
    }
    let hex = num.toString(16);
    if (hex.length % 2 !== 0) hex = '0' + hex;
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    }
    return bytes.slice(1);
}

class BitWriter {
    bytes: number[] = [];
    currentByte = 0;
    bitPos = 0;

    write(value: number, numBits: number) {
        for (let i = numBits - 1; i >= 0; i--) {
            const bit = (value >> i) & 1;
            this.currentByte = (this.currentByte << 1) | bit;
            this.bitPos++;
            if (this.bitPos === 8) {
                this.bytes.push(this.currentByte);
                this.currentByte = 0;
                this.bitPos = 0;
            }
        }
    }

    toBase85(): string {
        if (this.bitPos > 0) {
            this.bytes.push(this.currentByte << (8 - this.bitPos));
        }
        return encodeBase85(new Uint8Array(this.bytes));
    }
}

class BitReader {
    bytes: Uint8Array;
    bytePos = 0;
    bitPos = 7;

    constructor(base85: string) {
        this.bytes = decodeBase85(base85);
    }

    read(numBits: number): number {
        let value = 0;
        for (let i = 0; i < numBits; i++) {
            if (this.bytePos >= this.bytes.length) throw new Error("EOF");
            const bit = (this.bytes[this.bytePos] >> this.bitPos) & 1;
            value = (value << 1) | bit;
            this.bitPos--;
            if (this.bitPos < 0) {
                this.bitPos = 7;
                this.bytePos++;
            }
        }
        return value;
    }
}

// effects is a fixed 2-slot tuple
// counting it directly avoids the closure + intermediate array that Array.prototype.filter allocates on every call.
const countEffect = (item: InventoryItem, effect: ItemEffect) => {
    let n = 0;
    if (item.effects[0] === effect) n++;
    if (item.effects[1] === effect) n++;
    return n;
};

// The code format stores the module count in 8 bits,
// so a larger inventory would encode a wrapped count and produce a code that decodes into something else entirely
// Emit nothing rather than something corrupt.
export const MAX_ENCODABLE_MODULES = 255;

const generateCodeFromState = (
    currentTier: GridTier,
    maxStats: { Performance: boolean, Quality: boolean, Efficiency: boolean },
    tarStats: TargetStats,
    inv: InventoryItem[],
    brd: (InventoryItem | 'Locked' | null)[][]
) => {
    if (inv.length > MAX_ENCODABLE_MODULES) return '';

    const writer = new BitWriter();

    writer.write(currentTier, 2);

    writer.write(maxStats.Performance ? 1 : 0, 1);
    writer.write(maxStats.Quality ? 1 : 0, 1);
    writer.write(maxStats.Efficiency ? 1 : 0, 1);

    const writeTarget = (val: number | null) => {
        if (val === null) {
            writer.write(0, 1);
        } else {
            writer.write(1, 1);
            writer.write(val + 2048, 12);
        }
    };
    writeTarget(tarStats.Performance);
    writeTarget(tarStats.Quality);
    writeTarget(tarStats.Efficiency);

    writer.write(inv.length, 8);

    const placedItemsMap = new Map<string, number[]>();
    brd.forEach((row, y) => row.forEach((cell, x) => {
        if (cell && cell !== 'Locked') {
            if (!placedItemsMap.has(cell.id)) {
                placedItemsMap.set(cell.id, []);
            }
            placedItemsMap.get(cell.id)!.push(y * 7 + x);
        }
    }));

    inv.forEach(item => {
        writer.write(SHAPE_MAP.indexOf(item.shape), 4);
        writer.write(COLOR_MAP_KEYS.indexOf(item.color), 3);

        const positions = placedItemsMap.get(item.id) || [];
        writer.write(positions.length, 3);
        positions.forEach(p => writer.write(p, 6));

        item.effects.forEach((eff, idx) => {
            if (eff === 'None') {
                writer.write(0, 1);
            } else {
                writer.write(1, 1);
                writer.write(EFFECT_MAP.indexOf(eff), 4);

                if (eff === 'Learning Algorithm' || eff === 'Degrading') {
                    writer.write(1, 1);
                    writer.write(item.effectValues[idx] + 2048, 12);
                } else {
                    writer.write(0, 1);
                }
            }
        });
    });

    return writer.toBase85();
};

const saveToDatabase = (
    currentTier: GridTier,
    totals: Stats,
    code: string,
    inv: InventoryItem[]
) => {
    const hasNeuralCore = inv.some(item => item.displayName.includes('Neural Core'));
    const averageStat = (totals.Performance + totals.Quality + totals.Efficiency) / 3;

    const submission = {
        tier: currentTier,
        has_neural_core: hasNeuralCore,
        performance: totals.Performance,
        quality: totals.Quality,
        efficiency: totals.Efficiency,
        average_stat: parseFloat(averageStat.toFixed(2)),
        solution_code: code
    };

    supabase.from('leaderboards').insert([submission]).then(({ error }) => {
        if (error) console.error(error);
    });
};

export function initializeBoard(currentTier: GridTier, initialIds?: (string | 'Locked' | null)[][], inventory?: InventoryItem[]) {
    const grid = Array.from({ length: 5 }, () => Array.from({ length: 7 }, () => null as any));
    if (currentTier === 1 || currentTier === 2) {
        grid[0][0] = grid[0][6] = grid[4][0] = grid[4][6] = 'Locked';
    }
    if (currentTier === 1) {
        grid[1][3] = grid[2][2] = grid[2][3] = grid[2][4] = grid[3][3] = 'Locked';
    }

    if (initialIds && inventory) {
        for (let y = 0; y < 5; y++) {
            for (let x = 0; x < 7; x++) {
                if (grid[y][x] === 'Locked') continue;
                const cellId = initialIds[y][x];
                if (cellId && cellId !== 'Locked') {
                    const item = inventory.find(i => i.id === cellId);
                    if (item) grid[y][x] = item;
                }
            }
        }
    }
    return grid;
}

const NEIGHBOR_DX = [0, 0, -1, 1];
const NEIGHBOR_DY = [-1, 1, 0, 0];

interface PlacedPiece {
    item: InventoryItem;
    minX: number;
    minY: number;
    cells: number[];
    adjNodes: number;
}

export const indexInventoryById = (inventory: InventoryItem[]) => {
    const byId = new Map<string, InventoryItem>();
    for (const item of inventory) byId.set(item.id, item);
    return byId;
};

// `inventoryById` is only an optimisation:
// building it costs one pass over the whole inventory,
// which the solver would otherwise repeat on every iteration even though a board never holds more than 35 cells
// Callers that already have it should pass it
export const calculateBoardStats = (
    currentBoard: (InventoryItem | 'Locked' | null)[][],
    currentInventory: InventoryItem[],
    inventoryById?: Map<string, InventoryItem>
) => {
    const totals: Stats = { Performance: 0, Quality: 0, Efficiency: 0 };
    const pieceStats = new Map<string, Stats>();
    let coveredNodeSides = 0;
    let negativeContactCount = 0;
    let placedPiecesCount = 0;
    let placedAlarmsCount = 0;
    let placedJunkCount = 0;
    let placedBlastCount = 0;

    const invById = inventoryById ?? indexInventoryById(currentInventory);

    // applyInternalEffects is pure per item but was recomputed for every adjacency test; memoise it for the duration of the call
    const internalCache = new Map<string, Stats>();
    const internalOf = (item: InventoryItem): Stats => {
        let cached = internalCache.get(item.id);
        if (cached === undefined) {
            cached = applyInternalEffects(item);
            internalCache.set(item.id, cached);
        }
        return cached;
    };

    const placedPieces = new Map<string, PlacedPiece>();
    const nodeAdjacencies = new Map<string, Set<string>>();
    const gridItems: (InventoryItem | null)[] = new Array(35).fill(null);

    for (let y = 0; y < 5; y++) {
        for (let x = 0; x < 7; x++) {
            const boardCell = currentBoard[y][x];
            if (boardCell && boardCell !== 'Locked') {
                const cell = invById.get(boardCell.id) || boardCell;
                const idx = y * 7 + x;
                gridItems[idx] = cell;

                const existing = placedPieces.get(cell.id);
                if (existing === undefined) {
                    placedPieces.set(cell.id, { item: cell, minX: x, minY: y, cells: [idx], adjNodes: 0 });
                    placedPiecesCount++;
                } else {
                    if (x < existing.minX) existing.minX = x;
                    if (y < existing.minY) existing.minY = y;
                    existing.cells.push(idx);
                }
            }
        }
    }

    for (const { item, cells } of placedPieces.values()) {
        if (item.color !== 'White') continue;

        let adjSet = nodeAdjacencies.get(item.id);
        if (adjSet === undefined) {
            adjSet = new Set<string>();
            nodeAdjacencies.set(item.id, adjSet);
        }

        for (const idx of cells) {
            const x = idx % 7;
            const y = (idx - x) / 7;
            for (let d = 0; d < 4; d++) {
                const nx = x + NEIGHBOR_DX[d];
                const ny = y + NEIGHBOR_DY[d];
                if (nx < 0 || nx >= 7 || ny < 0 || ny >= 5) continue;

                const adj = gridItems[ny * 7 + nx];
                if (adj === null || adj.color === 'White') continue;

                if (!adjSet.has(adj.id)) {
                    adjSet.add(adj.id);
                    const adjPiece = placedPieces.get(adj.id);
                    if (adjPiece !== undefined) adjPiece.adjNodes++;
                }
                coveredNodeSides++;

                const adjModified = internalOf(adj);
                const ap = roundStat(adjModified.Performance);
                const aq = roundStat(adjModified.Quality);
                const ae = roundStat(adjModified.Efficiency);
                if (ap <= 0 && aq <= 0 && ae <= 0 && (ap < 0 || aq < 0 || ae < 0)) {
                    negativeContactCount++;
                }
            }
        }
    }

    const internalStats = new Map<string, Stats>();
    const absorptionStats = new Map<string, Stats>();
    for (const { item, cells } of placedPieces.values()) {
        if (item.displayName.includes('Alarm Module')) placedAlarmsCount++;
        if (item.displayName.includes('Junk Processing')) placedJunkCount++;
        if (item.displayName.includes('Blast Module')) placedBlastCount++;

        if (item.color === 'White') continue;

        const base = internalOf(item);
        let p = base.Performance, q = base.Quality, e = base.Efficiency;
        let absorbP = 0, absorbQ = 0, absorbE = 0;

        const nfCount = countEffect(item, 'Negative Feedback');
        if (nfCount > 0) {
            let nfPerf = 0, nfQual = 0, nfEff = 0;
            const counted = new Set<string>();

            for (const idx of cells) {
                const x = idx % 7;
                const y = (idx - x) / 7;
                for (let d = 0; d < 4; d++) {
                    const nx = x + NEIGHBOR_DX[d];
                    const ny = y + NEIGHBOR_DY[d];
                    if (nx < 0 || nx >= 7 || ny < 0 || ny >= 5) continue;

                    const neighbor = gridItems[ny * 7 + nx];
                    if (neighbor === null || neighbor.id === item.id || neighbor.color === 'White') continue;
                    if (counted.has(neighbor.id)) continue;
                    counted.add(neighbor.id);

                    const neighborBase = internalOf(neighbor);
                    if (neighborBase.Performance < 0) nfPerf += neighborBase.Performance;
                    if (neighborBase.Quality < 0) nfQual += neighborBase.Quality;
                    if (neighborBase.Efficiency < 0) nfEff += neighborBase.Efficiency;
                }
            }

            absorbP = nfCount * 0.25 * nfPerf;
            absorbQ = nfCount * 0.25 * nfQual;
            absorbE = nfCount * 0.25 * nfEff;
        }

        internalStats.set(item.id, {
            Performance: p,
            Quality: q,
            Efficiency: e
        });

        absorptionStats.set(item.id, {
            Performance: absorbP,
            Quality: absorbQ,
            Efficiency: absorbE
        });
    }

    for (const { item, minX, minY, adjNodes } of placedPieces.values()) {
        if (item.color === 'White') continue;

        let { Performance: p, Quality: q, Efficiency: e } = internalStats.get(item.id)!;

        let pBonus = 0, qBonus = 0, eBonus = 0;
        if (minX === 0 && item.effects.includes('Side Mount')) {
            pBonus += roundStat(p * 0.20);
            qBonus += roundStat(q * 0.20);
            eBonus += roundStat(e * 0.20);
        }
        if (minY === 0 && item.effects.includes('Top Mount')) {
            pBonus += roundStat(p * 0.20);
            qBonus += roundStat(q * 0.20);
            eBonus += roundStat(e * 0.20);
        }
        if (item.effects.includes('Receiver')) {
            pBonus += roundStat(p * 0.10 * adjNodes);
            qBonus += roundStat(q * 0.10 * adjNodes);
            eBonus += roundStat(e * 0.10 * adjNodes);
        }

        p += pBonus;
        q += qBonus;
        e += eBonus;

        const absorb = absorptionStats.get(item.id)!;
        p += absorb.Performance;
        q += absorb.Quality;
        e += absorb.Efficiency;

        const finalStats = { Performance: roundStat(p), Quality: roundStat(q), Efficiency: roundStat(e) };

        pieceStats.set(item.id, finalStats);
        totals.Performance += finalStats.Performance;
        totals.Quality += finalStats.Quality;
        totals.Efficiency += finalStats.Efficiency;
    }

    nodeAdjacencies.forEach((adjIds, nodeId) => {
        let nodeP = 0, nodeQ = 0, nodeE = 0;

        adjIds.forEach(adjId => {
            const adjacentItemData = placedPieces.get(adjId);
            if (adjacentItemData) {
                const baseAdj = internalOf(adjacentItemData.item);
                nodeP += baseAdj.Performance;
                nodeQ += baseAdj.Quality;
                nodeE += baseAdj.Efficiency;
            }
        });

        const nodeStat = {
            Performance: roundStat(nodeP * 0.20),
            Quality: roundStat(nodeQ * 0.20),
            Efficiency: roundStat(nodeE * 0.20)
        };

        pieceStats.set(nodeId, nodeStat);
        totals.Performance += nodeStat.Performance;
        totals.Quality += nodeStat.Quality;
        totals.Efficiency += nodeStat.Efficiency;
    });

    return { totals, pieceStats, coveredNodeSides, negativeContactCount, placedPiecesCount, placedAlarmsCount, placedJunkCount, placedBlastCount };
};

// Per-piece values that do not change as the piece is slid across the board
// Hoisting them out of the placement scan keeps the inner loop free of Map lookups and of the temporary arrays that includes()/filter() would allocate for every candidate cell
export interface PlacementContext {
    piece: InventoryItem;
    internal: Stats;
    isWhite: boolean;
    hasSideMount: boolean;
    hasTopMount: boolean;
    hasReceiver: boolean;
    nfCount: number;
    isPureNegative: boolean;
    size: number;
}

export const buildPlacementContext = (piece: InventoryItem, precomputedInternal: Map<string, Stats>): PlacementContext => {
    const internal = precomputedInternal.get(piece.id)!;
    const { Performance: p, Quality: q, Efficiency: e } = internal;
    const orientations = PRECOMPUTED_ORIENTATIONS.get(piece.shape);

    return {
        piece,
        internal,
        isWhite: piece.color === 'White',
        hasSideMount: piece.effects.includes('Side Mount'),
        hasTopMount: piece.effects.includes('Top Mount'),
        hasReceiver: piece.effects.includes('Receiver'),
        nfCount: countEffect(piece, 'Negative Feedback'),
        isPureNegative: p <= 0 && q <= 0 && e <= 0 && (p < 0 || q < 0 || e < 0),
        size: orientations ? orientations[0].count : 0
    };
};

// Scratch buffer for the distinct neighbours of a candidate placement
// A piece covers at most 5 cells, so the neighbour count is small and bounded
// reusing one array keeps this function allocation-free, which matters because it is the solver's innermost loop
const NEIGHBOR_SCRATCH: InventoryItem[] = [];

export const evaluatePlacementDelta = (
    ctx: PlacementContext,
    x: number, y: number,
    orientation: Orientation,
    testBoard: (InventoryItem | 'Locked' | null)[][],
    isBoardEmpty: boolean,
    precomputedInternal: Map<string, Stats>,
    weightP: number, weightQ: number, weightE: number
) => {
    if (x + orientation.minX < 0 || x + orientation.maxX > 6 ||
        y + orientation.minY < 0 || y + orientation.maxY > 4) {
        return -Infinity;
    }

    const { xs, ys, count } = orientation;
    const { internal, isWhite, nfCount, isPureNegative } = ctx;

    let isConnected = false;
    let adjNodes = 0;
    let negativeContactCount = 0;
    let neighborCount = 0;

    for (let i = 0; i < count; i++) {
        const px = x + xs[i];
        const py = y + ys[i];

        if (testBoard[py][px] !== null) return -Infinity;
        if (px === 0 || px === 6 || py === 0 || py === 4) isConnected = true;

        for (let d = 0; d < 4; d++) {
            const nx = px + NEIGHBOR_DX[d];
            const ny = py + NEIGHBOR_DY[d];
            if (nx < 0 || nx >= 7 || ny < 0 || ny >= 5) continue;

            const adjCell = testBoard[ny][nx];
            if (!adjCell || adjCell === 'Locked') continue;

            isConnected = true;

            const adjIsWhite = adjCell.color === 'White';
            if (isWhite) {
                if (!adjIsWhite) {
                    const adjInt = precomputedInternal.get(adjCell.id);
                    if (adjInt !== undefined &&
                        adjInt.Performance <= 0 && adjInt.Quality <= 0 && adjInt.Efficiency <= 0 &&
                        (adjInt.Performance < 0 || adjInt.Quality < 0 || adjInt.Efficiency < 0)) {
                        negativeContactCount++;
                    }
                }
            } else if (isPureNegative && adjIsWhite) {
                negativeContactCount++;
            }

            let seen = false;
            for (let k = 0; k < neighborCount; k++) {
                if (NEIGHBOR_SCRATCH[k].id === adjCell.id) { seen = true; break; }
            }
            if (!seen) NEIGHBOR_SCRATCH[neighborCount++] = adjCell;
        }
    }

    if (!isConnected && !isBoardEmpty) return -10000;

    let nodeBonusScore = 0;
    let nfPerf = 0, nfQual = 0, nfEff = 0;

    for (let k = 0; k < neighborCount; k++) {
        const adjPiece = NEIGHBOR_SCRATCH[k];
        const adjInternal = precomputedInternal.get(adjPiece.id);
        if (adjInternal === undefined) continue;

        const adjIsWhite = adjPiece.color === 'White';
        if (!isWhite && adjIsWhite) {
            adjNodes++;
            nodeBonusScore += roundStat(internal.Performance * 0.20) * weightP;
            nodeBonusScore += roundStat(internal.Quality * 0.20) * weightQ;
            nodeBonusScore += roundStat(internal.Efficiency * 0.20) * weightE;
        } else if (isWhite && !adjIsWhite) {
            nodeBonusScore += roundStat(adjInternal.Performance * 0.20) * weightP;
            nodeBonusScore += roundStat(adjInternal.Quality * 0.20) * weightQ;
            nodeBonusScore += roundStat(adjInternal.Efficiency * 0.20) * weightE;
        }

        if (nfCount > 0 && !adjIsWhite) {
            if (adjInternal.Performance < 0) nfPerf += adjInternal.Performance;
            if (adjInternal.Quality < 0) nfQual += adjInternal.Quality;
            if (adjInternal.Efficiency < 0) nfEff += adjInternal.Efficiency;
        }
    }

    // Negative Feedback is folded into each stat separately and before the mount/receiver multiplier,
    // so the heuristic ranks placements on the same terms the accepted score is computed with.
    let p = internal.Performance;
    let q = internal.Quality;
    let e = internal.Efficiency;

    let pBonus = 0, qBonus = 0, eBonus = 0;
    if (ctx.hasSideMount && x + orientation.minX === 0) {
        pBonus += roundStat(internal.Performance * 0.20);
        qBonus += roundStat(internal.Quality * 0.20);
        eBonus += roundStat(internal.Efficiency * 0.20);
    }
    if (ctx.hasTopMount && y + orientation.minY === 0) {
        pBonus += roundStat(internal.Performance * 0.20);
        qBonus += roundStat(internal.Quality * 0.20);
        eBonus += roundStat(internal.Efficiency * 0.20);
    }
    if (ctx.hasReceiver) {
        pBonus += roundStat(internal.Performance * 0.10 * adjNodes);
        qBonus += roundStat(internal.Quality * 0.10 * adjNodes);
        eBonus += roundStat(internal.Efficiency * 0.10 * adjNodes);
    }

    p += pBonus;
    q += qBonus;
    e += eBonus;

    if (nfCount > 0) {
        p += nfCount * 0.25 * nfPerf;
        q += nfCount * 0.25 * nfQual;
        e += nfCount * 0.25 * nfEff;
    }

    p = roundStat(p);
    q = roundStat(q);
    e = roundStat(e);

    const statScore = (p * weightP) + (q * weightQ) + (e * weightE) + nodeBonusScore;
    return statScore + (adjNodes * 0.05) - (negativeContactCount * 1000);
};

export type MachineConfig = {
    id: string;
    tier: GridTier;
    targetStats: TargetStats;
    maximizeStats: any;
    ignoreStats?: Partial<Record<keyof Stats, boolean>>;
    // Rank per stat, 1 being the most important
    // Stats sharing a rank are traded off against each other exactly as they always were
    // A lower rank is only ever consulted once every higher one is tied, so a met high-priority target can never be dropped to meet a lower-priority one
    // Absent or all-equal means the single combined objective as before
    statPriority?: Partial<Record<keyof Stats, number>>;
};

const STAT_KEYS: (keyof Stats)[] = ['Performance', 'Quality', 'Efficiency'];

// Alarm / Junk Processing / Blast modules exist for reasons the grid does not model
// On stats alone they are neutral at best and negative at worst, so a stat optimizer left to its own devices either ignores them or, worse, treats them as free filler
// Deciding how many of them a build should carry is a separate question from maximising stats, so the solver neither adds one nor takes one off a board
// Where they sit is still the solver's problem. A Blast module against a Node costs real stats, so a special already on a board is free to move around it
export const isSpecialModule = (item: InventoryItem) =>
    item.displayName.includes('Alarm Module')
    || item.displayName.includes('Junk Processing')
    || item.displayName.includes('Blast Module');

// An ignored stat is worth nothing to this machine in either direction
const statIsIgnored = (m: MachineConfig, key: keyof Stats) => Boolean(m.ignoreStats?.[key]);
const DEFAULT_STAT_PRIORITY = 1;
const priorityOf = (m: MachineConfig, key: keyof Stats) =>
    m.statPriority?.[key] ?? DEFAULT_STAT_PRIORITY;

// How much harder the placement heuristic leans on a stat per rank it is above the least important one
// The acceptance test is strictly ordered on its own; this only points the greedy fill in the same direction so it does not spend the search fighting the objective
const PRIORITY_WEIGHT_STEP = 4;

/* How many pool entries the fill looks at before committing to one

 * The fill decides where a module goes, never which modules get tried, so with a pool much larger than a board the set placed eachiteration was close to a uniform random sample
 * and the acceptance test had to sift good samples out of bad ones by luck, which it could not do
 * On a 100-module inventory, 250ms and 4s of search reached the identical board
 * Drawing this many candidates and keeping the best-scoring one biases the sample toward modules worth placing
 * Small on purpose. A large tournament, or a straight sort by value, would propose the same board every iteration and stop exploring entirely
 */
const DRAW_TOURNAMENT = 4;

// How much of a target's pull on the draw survives once the board already meets it
// The score pays nothing for overshooting, so it should fall; it cannot fall to zero, or the modules that hold the target stop being offered and the target cannot be defended
const TARGET_MET_DRAW_SCALE = 0.25;

// How many big ruins may come back empty-handed before the search abandons the board it is on and starts a fresh one
// The best board found is kept and reported throughout, so this only decides how the remaining iterations are spent
const RESTART_AFTER_STAGNATIONS = 8;

/* How hard the score pushes machines maximising the same stat towards each other.

 * This has to stay well under 20, or the score stops being monotone in each machine's stats
 * Above that bound, raising one machine costs more in balance than it earns, so every single-machine gain is rejected and LOWERING a good
 * machine to match a poor one actually scores better
 * At 50 that is exactly what happened, and Max on several machines would sit pinned to an almost-zero spread rather than improve
 * It is also why a stat held to a target behaved so much better, a target exempts it from this penalty entirely
 * Below the bound the penalty still drags on the gradient, so it wants real headroom rather than the largest legal value
 * Measured across 2-4 machines, 5 keeps around 95% of the stats an unbalanced search reaches while still cutting the spread between machines by more than half
 * By 8 the search climbs visibly slower
 */
const BALANCE_PENALTY_WEIGHT = 5;

// Lexicographic: the first rank that differs decides, so nothing below it can outvote it.
const compareTiers = (a: Float64Array, b: Float64Array) => {
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return 0;
};
const statIsScored = (m: MachineConfig, key: keyof Stats) =>
    !statIsIgnored(m, key) && (Boolean(m.maximizeStats?.[key]) || m.targetStats[key] !== null);

// Effects whose value depends on where the module ends up (edge contact, adjacent nodes, adjacent negatives)
// Modules carrying different ones cannot be compared on their stats alone, so they are only ever compared against modules carrying the same ones
const PLACEMENT_DEPENDENT_EFFECTS: ItemEffect[] = ['Side Mount', 'Top Mount', 'Receiver', 'Negative Feedback'];

// A 35-cell board cannot hold more than 17 pieces (the 2-cell Node is the smallest),
// so this many candidates per group is always enough to build any layout.
const MAX_PIECES_PER_BOARD = 18;

const dominates = (a: number[], b: number[]) => {
    let strictlyBetter = false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] < b[i]) return false;
        if (a[i] > b[i]) strictlyBetter = true;
    }
    return strictlyBetter;
};

/* Drops modules the search can never benefit from trying.
 *
 * A module is only worth considering if no other module of the same shape is at least as good on every stat that actually scores
 * Swapping a dominated module for the one that dominates it occupies the same cells and scores at least as well,
 * so any layout using the dominated one is matched by a layout without it, and trying it only costs time
 *
 * Three things keep this from throwing away real options: modules are only compared within the same shape and the same placement-dependent effects,
 * stats no machine scores on are left out of the comparison entirely, and enough candidates are kept per group to fill every board,
 * so pruning can never make a layout unreachable for lack of copies
 * Nodes are never dropped, and the special modules are left out of the pool entirely
 * The pool is what the fill draws NEW modules from, and those are never the solver's to add
 */
export const buildSearchPool = (
    inventory: InventoryItem[],
    precomputedInternal: Map<string, Stats>,
    machines: MachineConfig[]
): InventoryItem[] => {
    const scoredKeys = STAT_KEYS.filter(key => machines.some(m => statIsScored(m, key)));

    if (scoredKeys.length === 0) return inventory.filter(item => !isSpecialModule(item) && !item.isLocked);

    const keepCap = machines.length * MAX_PIECES_PER_BOARD;
    const kept: InventoryItem[] = [];
    const groups = new Map<string, Map<string, InventoryItem[]>>();

    for (const item of inventory) {
        if (isSpecialModule(item)) continue;
        if (item.isLocked) continue;

        if (item.color === 'White') {
            kept.push(item);
            continue;
        }

        const signature = PLACEMENT_DEPENDENT_EFFECTS.filter(eff => item.effects.includes(eff)).join('+');
        const groupKey = `${item.shape}|${signature}`;

        const stats = precomputedInternal.get(item.id)!;
        const tupleKey = scoredKeys.map(key => stats[key]).join(',');

        let group = groups.get(groupKey);
        if (group === undefined) {
            group = new Map<string, InventoryItem[]>();
            groups.set(groupKey, group);
        }
        const bucket = group.get(tupleKey);
        if (bucket === undefined) group.set(tupleKey, [item]);
        else bucket.push(item);
    }

    for (const group of groups.values()) {
        const tuples = [...group.keys()];
        const parsed = tuples.map(t => t.split(',').map(Number));

        const frontier: InventoryItem[] = [];
        const rest: InventoryItem[] = [];
        for (let i = 0; i < tuples.length; i++) {
            let isDominated = false;
            for (let j = 0; j < tuples.length && !isDominated; j++) {
                if (i !== j && dominates(parsed[j], parsed[i])) isDominated = true;
            }
            const items = group.get(tuples[i])!;
            if (isDominated) rest.push(...items);
            else frontier.push(...items);
        }

        // Keep the undominated candidates first; top up from the rest so a group never ends up with fewer modules than a board could actually use
        for (const item of frontier) kept.push(item);
        for (let i = 0; i < rest.length && frontier.length + i < keepCap; i++) kept.push(rest[i]);
    }

    return kept;
};

type BoardStats = ReturnType<typeof calculateBoardStats>;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// Unbiased Fisher-Yates
// `sort(() => Math.random() - 0.5)` is not a shuffle: it leaves the ordering strongly correlated with the input, which narrows the range of layouts the solver actually explores
const shuffleInPlace = <T,>(arr: T[]) => {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
    }
};

// The solver has to hand the event loop back periodically or the page freezes, but `setTimeout(..., 0)` is clamped to ~4ms once it nests a few levels deep,
// which caps the search at a few hundred iterations per second no matter how fast the search itself is
// A MessagePort task is not clamped, so most yields go through one of those
// Leaning on it exclusively is not safe though: a steady stream of port messages can crowd out timer callbacks entirely,
// so every so often we yield through a timer instead to guarantee they still get serviced
const createYielder = () => {
    const timerYield = () => new Promise<void>(resolve => { setTimeout(resolve, 0); });

    if (typeof MessageChannel === 'undefined') {
        return { portYield: timerYield, timerYield, dispose: () => {} };
    }

    const channel = new MessageChannel();
    let pending: (() => void) | null = null;
    channel.port1.onmessage = () => {
        const resolve = pending;
        pending = null;
        if (resolve) resolve();
    };

    return {
        portYield: () => new Promise<void>(resolve => {
            pending = resolve;
            channel.port2.postMessage(0);
        }),
        timerYield,
        dispose: () => {
            channel.port1.onmessage = null;
            channel.port1.close();
            channel.port2.close();
        }
    };
};

// How long the solver may run before handing control back to the host
// One frame's worth of work per yield keeps the UI responsive while amortising the cost of yielding.
const FRAME_BUDGET_MS = 12;
// How often one of those yields must be a timer yield, so timer callbacks cannot starve.
const TIMER_YIELD_INTERVAL_MS = 32;

export const runOptimizationEngine = async (
    machines: MachineConfig[],
    initialBoards: any[][][],
    searchPoolInventory: InventoryItem[],
    fullInventory: InventoryItem[],
    isSolvingRef: { current: boolean },
    onUpdate: (updates: Map<string, { board: any[][], totals: Stats, pieceStats: Map<string, Stats>, code: string }>) => void
) => {
    const machineCount = machines.length;
    const precomputedInternal = new Map<string, Stats>();
    fullInventory.forEach(item => precomputedInternal.set(item.id, applyInternalEffects(item)));

    const placementContexts = new Map<string, PlacementContext>();
    fullInventory.forEach(item => placementContexts.set(item.id, buildPlacementContext(item, precomputedInternal)));

    // Boards may already hold modules the search itself would not pick up, so the pruned pool is only used for choosing what to place
    const searchPool = buildSearchPool(searchPoolInventory, precomputedInternal, machines);

    // The inner loops used to key everything off item.id, which meant hashing a string for every pool entry on every iteration
    // At a 883-piece pool and three machines that is thousands of string hashes per iteration and it dominated the search
    // Everything hot is addressed by pool index instead:
    // the item -> index map is walked once per placed cell (a few dozen), and the per-candidate work becomes a typed-array read
    const poolIndexOf = new Map<string, number>();
    searchPool.forEach((item, i) => poolIndexOf.set(item.id, i));
    const ctxByIndex: PlacementContext[] = searchPool.map(item => placementContexts.get(item.id)!);
    const orientationsByIndex = searchPool.map(item => PRECOMPUTED_ORIENTATIONS.get(item.shape));

    // A board holds at most MAX_PIECES_PER_BOARD pieces, so shuffling the entire pool to fill one was work thrown away
    // A 883-piece pool cost 883 random draws per machine per iteration to place around fifteen pieces
    // This permutation is drawn from a Fisher-Yates that stops as soon as the board can take nothing more
    // and it persists across iterations, staying a valid permutation because a partial shuffle only ever swaps within it
    const poolOrder = new Int32Array(searchPool.length);
    for (let i = 0; i < poolOrder.length; i++) poolOrder[i] = i;
    const poolShapeCount = new Set(searchPool.map(item => item.shape)).size;
    const inventoryById = indexInventoryById(fullInventory);

    // One tier per distinct rank in play, most important first
    // With no priorities set this collapses to a single tier holding everything, which is the original objective
    const activeRanks = new Set<number>();
    for (const m of machines) {
        for (const key of STAT_KEYS) {
            if (!statIsIgnored(m, key)) activeRanks.add(priorityOf(m, key));
        }
    }
    if (activeRanks.size === 0) activeRanks.add(DEFAULT_STAT_PRIORITY);
    const rankOrder = [...activeRanks].sort((a, b) => a - b);
    const tierCount = rankOrder.length;
    const tierOfRank = new Map<number, number>(rankOrder.map((r, i) => [r, i]));
    const tierOf = (m: MachineConfig, key: keyof Stats) => tierOfRank.get(priorityOf(m, key))!;

    const currentTiers = new Float64Array(tierCount);
    // epochTiers is the best this attempt has reached, bestTiers the best ever reached
    // They are the same thing until the search restarts; (see RESTART_AFTER_STAGNATIONS)
    const epochTiers = new Float64Array(tierCount).fill(-Infinity);
    const bestTiers = new Float64Array(tierCount).fill(-Infinity);
    const currentBoards = initialBoards.map(b => b.map(row => [...row]));

    // Only the machine picked for this iteration can change, so the stats and the solution code of every other machine stay valid:
    // cache them instead of recomputing all of them (and re-running the BigInt encoder) on every improvement
    const currentStats: BoardStats[] = currentBoards.map(b => calculateBoardStats(b, fullInventory, inventoryById));
    const currentCodes: string[] = new Array(machineCount).fill('');
    const codeIsStale: boolean[] = new Array(machineCount).fill(true);

    // The best boards ever seen, which is what gets reported
    // Once the search can restart, the boards it is working on are no longer guaranteed to be the best ones found,
    // so the record is kept separately. A restart must never be able to lose a result that has already been shown
    const bestBoards = currentBoards.map(b => b.map(row => [...row]));
    const bestStats: BoardStats[] = [...currentStats];

    // Reused across iterations so the search does not allocate a fresh board per attempt
    const testBoards: (InventoryItem | 'Locked' | null)[][][] =
        currentBoards.map(b => b.map(row => [...row]));

    let stagnationCounter = 0;
    let stagnationRuns = 0;
    const STAGNATION_LIMIT = 150;

    // A stat marked ignored gets weight 0 so the placement heuristic stops steering away from it at all;
    // otherwise an unmaximised stat keeps the small 0.1 tiebreak weight
    const baseWeights = machines.map(m => {
        let wp = m.ignoreStats?.Performance ? 0 : (m.maximizeStats.Performance ? 10 : 0.1);
        let wq = m.ignoreStats?.Quality ? 0 : (m.maximizeStats.Quality ? 10 : 0.1);
        let we = m.ignoreStats?.Efficiency ? 0 : (m.maximizeStats.Efficiency ? 10 : 0.1);
        if (m.targetStats.Performance !== null) wp += 15;
        if (m.targetStats.Quality !== null) wq += 15;
        if (m.targetStats.Efficiency !== null) we += 15;

        const boost = (key: keyof Stats) =>
            statIsIgnored(m, key) ? 1 : Math.pow(PRIORITY_WEIGHT_STEP, tierCount - 1 - tierOf(m, key));
        wp *= boost('Performance');
        wq *= boost('Quality');
        we *= boost('Efficiency');
        return { wp, wq, we };
    });

    /* What each pool entry is worth to this machine per cell it occupies, used to decide which modules the fill is offered
     * Board space is the scarce resource, so per-cell is the comparison that matters
     *
     * These weights are not the placement weights above, and the difference is the point
     * The score pays nothing for overshooting a target, so once a target is met, another point of that stat is worth next to nothing for a stat that is only being held to a target
     * A machine sitting comfortably above P 500 and Q 150 should be offered Efficiency modules, not more of what it already has
     * The placement heuristic keeps the full target weight in every case, and that is what stops a met target being undercut. This only decides what gets offered to it
     *
     * Which targets are met changes as the boards move, so there is one table per combination of met targets (at most eight), built once here, picked by bitmask per fill
     * Rebuilding a table whenever the totals shifted would costs more than the bias is worth
     */
    const targetedKeys = machines.map(m => STAT_KEYS.filter(key => m.targetStats[key] !== null));

    const buildDrawValues = (w: Stats) => {
        const values = new Float64Array(searchPool.length);
        const stated: number[] = [];
        for (let i = 0; i < searchPool.length; i++) {
            const ctx = ctxByIndex[i];
            if (ctx.isWhite || ctx.size === 0) continue;
            const s = ctx.internal;
            values[i] = (s.Performance * w.Performance + s.Quality * w.Quality
                + s.Efficiency * w.Efficiency) / ctx.size;
            stated.push(values[i]);
        }
        // Nodes carry no stats of their own: all their worth is the 20% they add to whatever ends up beside them, which only evaluatePlacementDelta can see
        // Scoring them at the median leaves them drawn about as often as an ordinary module instead of never
        if (stated.length > 0) {
            stated.sort((a, b) => a - b);
            const median = stated[stated.length >> 1];
            for (let i = 0; i < searchPool.length; i++) {
                if (ctxByIndex[i].isWhite) values[i] = median;
            }
        }
        return values;
    };

    const drawValues: Float64Array[][] = machines.map((m, mIdx) => {
        const targeted = targetedKeys[mIdx];
        const tables: Float64Array[] = [];
        for (let mask = 0; mask < (1 << targeted.length); mask++) {
            const w: Stats = { Performance: 0, Quality: 0, Efficiency: 0 };
            for (const key of STAT_KEYS) {
                let v = statIsIgnored(m, key) ? 0 : (m.maximizeStats[key] ? 10 : 0.1);
                const ti = targeted.indexOf(key);
                // Bit set means the target is already met, so the push for it is cut back, but never to nothing
                // The draw decides which modules the fill is even offered,
                // so a stat whose modules stop being drawn cannot be rebuilt when a ruin knocks it below its target, and every repair after that is rejected
                if (ti !== -1) v += 15 * ((mask & (1 << ti)) !== 0 ? TARGET_MET_DRAW_SCALE : 1);
                w[key] = v * Math.pow(PRIORITY_WEIGHT_STEP, tierCount - 1 - tierOf(m, key));
            }
            tables.push(buildDrawValues(w));
        }
        return tables;
    });

    // Scratch buffers, cleared per iteration rather than reallocated
    // placedMark: pool entries sitting on some board this iteration
    // consumedMark: pool entries taken during this iteration's fill, since machines share one pool and a piece used by one rebuild is off the table for the machines rebuilt after it
    // Both are generation-stamped rather than cleared, so a new iteration invalidates every stale entry by bumping a counter instead of walking the array
    const placedMark = new Int32Array(searchPool.length);
    const consumedMark = new Int32Array(searchPool.length);
    let markGen = 0;
    let consumedGen = 0;
    const piecesOnTarget: InventoryItem[] = [];
    const seenOnTarget = new Set<string>();
    const removedIds = new Set<string>();
    // Every special sitting on each rebuilt board, with the cells it is currently standing on
    // They stay put until the fill lifts them one at a time, so the board is never in a state where one is missing
    const specialsOnBoard: { piece: InventoryItem; cells: number[] }[][] = machines.map(() => []);
    const freeCells: number[] = [];
    const rebuiltMachines: number[] = [];
    const isRebuilt: boolean[] = new Array(machineCount).fill(false);
    // Whether a shape fits is a property of the shape and the free cells, never of the individual module, and filling a board only ever removes free cells
    // So once one module of a shape finds nowhere to go, every later module of that shape in the same pass finds nowhere either, and can be skipped without scanning
    const infeasibleShapes = new Set<ModuleShape>();
    const rebuiltStats: (BoardStats | null)[] = new Array(machineCount).fill(null);
    // A board is empty exactly when every cell it has is free, and which cells it has is fixed by its tier
    const openCellCount = currentBoards.map(b => {
        let open = 0;
        for (let y = 0; y < 5; y++) for (let x = 0; x < 7; x++) if (b[y][x] !== 'Locked') open++;
        return open;
    });

    // Drops the cells that are no longer free, keeping the rest in scan order
    const compactFreeCells = (fillBoard: (InventoryItem | 'Locked' | null)[][]) => {
        let write = 0;
        for (let c = 0; c < freeCells.length; c++) {
            const idx = freeCells[c];
            const cx = idx % 7;
            const cy = (idx - cx) / 7;
            if (fillBoard[cy][cx] === null) freeCells[write++] = idx;
        }
        freeCells.length = write;
    };

    /* Commits one piece at its best-scoring placement among the free cells, and reports whether it found one
     * The pool fill and the special-module relocation both go through here on purpose:
     * a special is only allowed to move because the fill can judge where it should go, and it has to judge it on exactly the terms it judges everything else
     *
     * `incumbent` is where the piece is standing already, for a piece being relocated rather than placed for the first time
     * It is scored ahead of everything else and the scan only takes a strictly better cell, so a piece with nowhere better to be simply stays
     * Without it the ties decide, and for a module whose score barely varies across the board (which is every special) that means the first cell in scan order:
     * a Line4 lands in the top-left of whatever the ruin opened up, every iteration, taking the best space on the board from the modules that would have earned something with it
     */
    const placeBestFit = (
        ctx: PlacementContext,
        orientations: Orientation[],
        piece: InventoryItem,
        fillBoard: (InventoryItem | 'Locked' | null)[][],
        fillBoardEmpty: boolean,
        weightP: number, weightQ: number, weightE: number,
        incumbent: { x: number; y: number; orientation: Orientation } | null = null
    ) => {
        let bestX = -1, bestY = -1;
        let bestOrientation: Orientation | null = null;
        let highestHeuristic = -Infinity;

        if (incumbent !== null) {
            const incumbentScore = evaluatePlacementDelta(
                ctx, incumbent.x, incumbent.y, incumbent.orientation, fillBoard, fillBoardEmpty,
                precomputedInternal, weightP, weightQ, weightE
            );
            if (incumbentScore !== -Infinity) {
                highestHeuristic = incumbentScore;
                bestX = incumbent.x; bestY = incumbent.y;
                bestOrientation = incumbent.orientation;
            }
        }

        for (let c = 0; c < freeCells.length; c++) {
            const idx = freeCells[c];
            const x = idx % 7;
            const y = (idx - x) / 7;

            for (let o = 0; o < orientations.length; o++) {
                const orientation = orientations[o];
                // evaluatePlacementDelta rejects these too, but most anchors on a 7x5 board are out of bounds for a given orientation,
                // and the bounding box settles it here without the nine-argument call
                if (x + orientation.minX < 0 || x + orientation.maxX > 6 ||
                    y + orientation.minY < 0 || y + orientation.maxY > 4) continue;

                const deltaScore = evaluatePlacementDelta(
                    ctx, x, y, orientation, fillBoard, fillBoardEmpty,
                    precomputedInternal, weightP, weightQ, weightE
                );
                if (deltaScore > highestHeuristic && deltaScore !== -Infinity) {
                    highestHeuristic = deltaScore;
                    bestX = x; bestY = y;
                    bestOrientation = orientation;
                }
            }
        }

        if (!bestOrientation) return false;

        const { xs, ys, count } = bestOrientation;
        for (let i = 0; i < count; i++) {
            fillBoard[bestY + ys[i]][bestX + xs[i]] = piece;
        }
        compactFreeCells(fillBoard);
        return true;
    };

    let pendingUpdate = false;
    const flushUpdate = () => {
        if (!pendingUpdate) return;
        pendingUpdate = false;

        const updates = new Map<string, { board: any[][], totals: Stats, pieceStats: Map<string, Stats>, code: string }>();

        for (let mIdx = 0; mIdx < machineCount; mIdx++) {
            const m = machines[mIdx];
            if (codeIsStale[mIdx]) {
                const usedCloneIds = new Set<string>();
                bestBoards[mIdx].forEach(row => row.forEach(cell => {
                    if (cell && cell !== 'Locked' && cell.id.includes('_clone_')) {
                        usedCloneIds.add(cell.id);
                    }
                }));
                const inventoryForCode = fullInventory.filter(item => !item.id.includes('_clone_') || usedCloneIds.has(item.id));

                currentCodes[mIdx] = generateCodeFromState(m.tier, m.maximizeStats, m.targetStats, inventoryForCode, bestBoards[mIdx]);
                codeIsStale[mIdx] = false;
            }
            updates.set(m.id, {
                board: bestBoards[mIdx].map(row => [...row]),
                totals: bestStats[mIdx].totals,
                pieceStats: bestStats[mIdx].pieceStats,
                code: currentCodes[mIdx]
            });
        }
        onUpdate(updates);
    };

    const { portYield, timerYield, dispose } = createYielder();
    let lastYield = now();
    let lastTimerYield = lastYield;

    try {
        while (isSolvingRef.current) {
            const isStagnant = stagnationCounter >= STAGNATION_LIMIT;

            // Normally one random machine is rebuilt per iteration. That alone cannot climb a multi-machine setup
            // The balance penalty outweighs the stat reward, so once the machines are level, every single-machine gain scores worse than standing still and the search is stuck for good
            // So the ruin-and-recreate step rebuilds every machine at once, which is the only move that can reach a better balanced layout
            // The objective itself is unchanged
            const rebuildAll = isStagnant && machineCount > 1;
            const targetMIdx = Math.floor(Math.random() * machineCount);

            rebuiltMachines.length = 0;
            if (rebuildAll) {
                for (let mIdx = 0; mIdx < machineCount; mIdx++) rebuiltMachines.push(mIdx);
                shuffleInPlace(rebuiltMachines);
            } else {
                rebuiltMachines.push(targetMIdx);
            }

            // Only a rebuilt board is written to, so the others are read straight off currentBoards instead of being copied into a scratch board that would come out identical
            for (let mIdx = 0; mIdx < machineCount; mIdx++) isRebuilt[mIdx] = false;
            for (const mIdx of rebuiltMachines) {
                isRebuilt[mIdx] = true;
                const src = currentBoards[mIdx];
                const dst = testBoards[mIdx];
                for (let y = 0; y < 5; y++) {
                    const srcRow = src[y];
                    const dstRow = dst[y];
                    for (let x = 0; x < 7; x++) dstRow[x] = srcRow[x];
                }
            }

            markGen++;

            for (let mIdx = 0; mIdx < machineCount; mIdx++) {
                const board = isRebuilt[mIdx] ? testBoards[mIdx] : currentBoards[mIdx];
                if (isRebuilt[mIdx]) {
                    piecesOnTarget.length = 0;
                    seenOnTarget.clear();
                    specialsOnBoard[mIdx].length = 0;

                    for (let y = 0; y < 5; y++) {
                        for (let x = 0; x < 7; x++) {
                            const cell = board[y][x];
                            if (!cell || cell === 'Locked') continue;

                            /* A special is offered a better cell every iteration instead of taking a share of the ruin's removal budget
                             * It is not the ruin's kind of move: the ruin takes a piece away and lets the fill find something better to do with the space,
                             * and a special is going straight back down whatever happens. Spending a removal on one only means one fewer real piece is reconsidered that iteration
                             */
                            if (isSpecialModule(cell) || cell.isLocked) {
                                let entry = specialsOnBoard[mIdx].find(e => e.piece.id === cell.id);
                                if (entry === undefined) {
                                    entry = { piece: cell, cells: [] };
                                    specialsOnBoard[mIdx].push(entry);
                                }
                                entry.cells.push(y * 7 + x);
                                continue;
                            }

                            if (!seenOnTarget.has(cell.id)) {
                                seenOnTarget.add(cell.id);
                                piecesOnTarget.push(cell);
                            }
                        }
                    }

                    if (piecesOnTarget.length > 0) {
                        const removeCount = isStagnant
                            ? Math.max(1, Math.floor(piecesOnTarget.length * (0.5 + Math.random() * 0.4)))
                            : Math.floor(Math.random() * Math.min(3, piecesOnTarget.length)) + 1;

                        shuffleInPlace(piecesOnTarget);
                        removedIds.clear();
                        for (let i = 0; i < removeCount; i++) removedIds.add(piecesOnTarget[i].id);

                        for (let y = 0; y < 5; y++) {
                            for (let x = 0; x < 7; x++) {
                                const cell = board[y][x];
                                if (cell && cell !== 'Locked') {
                                    if (removedIds.has(cell.id)) {
                                        board[y][x] = null;
                                    } else {
                                        const pIdx = poolIndexOf.get(cell.id);
                                        if (pIdx !== undefined) placedMark[pIdx] = markGen;
                                    }
                                }
                            }
                        }
                    }
                } else {
                    for (let y = 0; y < 5; y++) {
                        for (let x = 0; x < 7; x++) {
                            const cell = board[y][x];
                            if (cell && cell !== 'Locked') {
                                const pIdx = poolIndexOf.get(cell.id);
                                if (pIdx !== undefined) placedMark[pIdx] = markGen;
                            }
                        }
                    }
                }
            }

            consumedGen++;

            for (const fillMIdx of rebuiltMachines) {
                let dynWp = baseWeights[fillMIdx].wp;
                let dynWq = baseWeights[fillMIdx].wq;
                let dynWe = baseWeights[fillMIdx].we;

                // dynamic heuristic weight adjustment if stats% are behind other machines
                const fillConfig = machines[fillMIdx];
                if (machineCount > 1) {
                    let sumP = 0, sumQ = 0, sumE = 0;
                    for (let mIdx = 0; mIdx < machineCount; mIdx++) {
                        const t = currentStats[mIdx].totals;
                        sumP += t.Performance; sumQ += t.Quality; sumE += t.Efficiency;
                    }
                    const mine = currentStats[fillMIdx].totals;
                    const laggingOn = (key: keyof Stats, sum: number) =>
                        !statIsIgnored(fillConfig, key) && fillConfig.maximizeStats[key]
                        && fillConfig.targetStats[key] === null && mine[key] < sum / machineCount;

                    if (laggingOn('Performance', sumP)) dynWp *= 2.0;
                    if (laggingOn('Quality', sumQ)) dynWq *= 2.0;
                    if (laggingOn('Efficiency', sumE)) dynWe *= 2.0;
                }

                const fillBoard = testBoards[fillMIdx];

                // Every orientation is normalised so its first cell is the anchor, so only  empty cells can anchor a placement
                // Tracking them prunes the scan as the board fills up
                freeCells.length = 0;
                for (let y = 0; y < 5; y++) {
                    for (let x = 0; x < 7; x++) {
                        if (fillBoard[y][x] === null) freeCells.push(y * 7 + x);
                    }
                }
                let fillBoardEmpty = freeCells.length === openCellCount[fillMIdx];

                /* The board's specials, offered a better cell one at a time and before anything is drawn
                 *
                 * One at a time is what makes this safe: at the moment a special is placed its own cells are still free, and an anchor-normalised orientation always has an
                 * anchor among them, so placeBestFit can never come back empty-handed and a special can never be lost on the way. Lifting them all at once would let the
                 * first one take the second one's cells and leave the second with nowhere guaranteed to go
                 * Going before the draw also means they choose out of the whole ruined area rather than whatever the fill leaves over
                 */
                for (const special of specialsOnBoard[fillMIdx]) {
                    const ctx = placementContexts.get(special.piece.id);
                    const orientations = PRECOMPUTED_ORIENTATIONS.get(special.piece.shape);
                    if (ctx === undefined || orientations === undefined) continue;

                    // The cells were collected in row-major order, and an orientation's offsets are in that same order and anchored on its first cell,
                    // so the cells the piece is standing on say which orientation it is standing in
                    const anchor = special.cells[0];
                    const homeX = anchor % 7;
                    const homeY = (anchor - homeX) / 7;
                    let home: Orientation | null = null;
                    for (const orientation of orientations) {
                        if (orientation.count !== special.cells.length) continue;
                        let matches = true;
                        for (let i = 0; i < orientation.count; i++) {
                            if (special.cells[i] !== anchor + orientation.ys[i] * 7 + orientation.xs[i]) { matches = false; break; }
                        }
                        if (matches) { home = orientation; break; }
                    }

                    for (const idx of special.cells) {
                        const cx = idx % 7;
                        fillBoard[(idx - cx) / 7][cx] = null;
                        freeCells.push(idx);
                    }
                    placeBestFit(
                        ctx, orientations, special.piece, fillBoard, fillBoardEmpty, dynWp, dynWq, dynWe,
                        home === null ? null : { x: homeX, y: homeY, orientation: home }
                    );
                    fillBoardEmpty = false;
                }

                infeasibleShapes.clear();

                // Which of this machine's targets the accepted board already meets picks the draw table, so the fill stops being offered more of a stat it has enough of
                const targeted = targetedKeys[fillMIdx];
                let metMask = 0;
                for (let i = 0; i < targeted.length; i++) {
                    const key = targeted[i];
                    if (currentStats[fillMIdx].totals[key] >= machines[fillMIdx].targetStats[key]!) {
                        metMask |= 1 << i;
                    }
                }
                const values = drawValues[fillMIdx][metMask];

                // Stops once every shape in the pool has been shown to fit nowhere, which cannot change while the board is only losing free cells
                let drawn = 0;
                while (drawn < poolOrder.length && infeasibleShapes.size < poolShapeCount) {
                    // Best of DRAW_TOURNAMENT random candidates rather than the first one drawn
                    // The permutation is still only partially shuffled, so the losers stay in the undrawn region and can be picked again later this fill
                    const remaining = poolOrder.length - drawn;
                    let swapAt = drawn + Math.floor(Math.random() * remaining);
                    for (let t = 1; t < DRAW_TOURNAMENT && t < remaining; t++) {
                        const alt = drawn + Math.floor(Math.random() * remaining);
                        if (values[poolOrder[alt]] > values[poolOrder[swapAt]]) swapAt = alt;
                    }
                    const pieceIdx = poolOrder[swapAt];
                    poolOrder[swapAt] = poolOrder[drawn];
                    poolOrder[drawn] = pieceIdx;
                    drawn++;

                    if (placedMark[pieceIdx] === markGen) continue;
                    if (consumedMark[pieceIdx] === consumedGen) continue;

                    const piece = searchPool[pieceIdx];
                    if (infeasibleShapes.has(piece.shape)) continue;

                    const ctx = ctxByIndex[pieceIdx];
                    // Too few cells left for this shape is itself a permanent verdict on it
                    if (freeCells.length < ctx.size) {
                        infeasibleShapes.add(piece.shape);
                        continue;
                    }

                    const orientations = orientationsByIndex[pieceIdx];
                    if (!orientations) continue;

                    if (placeBestFit(ctx, orientations, piece, fillBoard, fillBoardEmpty, dynWp, dynWq, dynWe)) {
                        fillBoardEmpty = false;
                        consumedMark[pieceIdx] = consumedGen;
                    } else {
                        infeasibleShapes.add(piece.shape);
                    }
                }
            }

            // Only rebuilt machines can have changed, so the rest keep their cached stats
            for (const mIdx of rebuiltMachines) {
                rebuiltStats[mIdx] = calculateBoardStats(testBoards[mIdx], fullInventory, inventoryById);
            }
            const statsFor = (mIdx: number) =>
                isRebuilt[mIdx] ? rebuiltStats[mIdx]! : currentStats[mIdx];

            currentTiers.fill(0);
            let totalPiecesPlaced = 0;

            for (let mIdx = 0; mIdx < machineCount; mIdx++) {
                const stats = statsFor(mIdx);
                totalPiecesPlaced += stats.placedPiecesCount;

                const m = machines[mIdx];
                const t = stats.totals;

                for (const key of STAT_KEYS) {
                    if (statIsIgnored(m, key)) continue;

                    const ti = tierOf(m, key);
                    const target = m.targetStats[key];
                    if (target !== null && t[key] < target) currentTiers[ti] -= (target - t[key]) * 10000;
                    if (m.maximizeStats[key]) currentTiers[ti] += (t[key] * 10);
                }
            }

            // Density reward: a general tiebreak, so it sits in the least important tier and can never take a ranked stat out of its own tier
            currentTiers[tierCount - 1] += totalPiecesPlaced * 5;

            if (machineCount > 1) {
                for (const statKey of STAT_KEYS) {
                    const isBalanced = (mIdx: number) => {
                        const m = machines[mIdx];
                        return !statIsIgnored(m, statKey) && m.maximizeStats[statKey] && m.targetStats[statKey] === null;
                    };

                    let sum = 0, count = 0;
                    // Balancing a stat is part of caring about it, so the penalty lands in the tier of whichever machine ranks it highest
                    let topTier = tierCount - 1;
                    for (let mIdx = 0; mIdx < machineCount; mIdx++) {
                        if (!isBalanced(mIdx)) continue;
                        sum += statsFor(mIdx).totals[statKey];
                        count++;
                        const ti = tierOf(machines[mIdx], statKey);
                        if (ti < topTier) topTier = ti;
                    }
                    if (count > 1) {
                        const avg = sum / count;
                        let mad = 0;
                        for (let mIdx = 0; mIdx < machineCount; mIdx++) {
                            if (!isBalanced(mIdx)) continue;
                            mad += Math.abs(statsFor(mIdx).totals[statKey] - avg);
                        }
                        currentTiers[topTier] -= (mad / count) * BALANCE_PENALTY_WEIGHT;
                    }
                }
            }

            if (!isSolvingRef.current) break;

            // Judged against the best of THIS attempt, not the best ever
            // After a restart the boards are deliberately worse than the record, and comparing them to it would reject every move and leave the restart unable to climb at all
            const ordering = compareTiers(currentTiers, epochTiers);
            const improved = ordering > 0;
            if (improved || (ordering === 0 && Math.random() > 0.5)) {
                if (improved) epochTiers.set(currentTiers);
                for (const mIdx of rebuiltMachines) {
                    currentBoards[mIdx] = testBoards[mIdx].map(row => [...row]);
                    currentStats[mIdx] = rebuiltStats[mIdx]!;
                }

                // A new record is the only thing worth reporting, and the only thing that resets the stagnation count
                if (improved && compareTiers(currentTiers, bestTiers) > 0) {
                    bestTiers.set(currentTiers);
                    for (let mIdx = 0; mIdx < machineCount; mIdx++) {
                        bestBoards[mIdx] = currentBoards[mIdx].map(row => [...row]);
                        bestStats[mIdx] = currentStats[mIdx];
                    }
                    // Every code lists the modules the other machines are not using,
                    // so moving one machine's pieces invalidates all of them, not just the rebuilt one
                    codeIsStale.fill(true);
                    pendingUpdate = true;
                    stagnationCounter = 0;
                } else {
                    stagnationCounter++;
                }
            } else {
                stagnationCounter++;
            }

            if (isStagnant) {
                stagnationCounter = 0;
                // A big ruin is still judged against the epoch's best, so it only ever gets kept if it comes out ahead
                // On a board that has been hill-climbed for thousands of iterations it almost never does
                // Past a point it is very likely that this attempt is finished, and the iterations are better spent on a fresh one than on shaking the same board forever
                // The record is already banked in bestBoards, so a restart can only cost time, never a result
                if (++stagnationRuns >= RESTART_AFTER_STAGNATIONS) {
                    stagnationRuns = 0;
                    epochTiers.fill(-Infinity);
                    for (let mIdx = 0; mIdx < machineCount; mIdx++) {
                        currentBoards[mIdx] = initialBoards[mIdx].map(row => [...row]);
                        currentStats[mIdx] = calculateBoardStats(currentBoards[mIdx], fullInventory, inventoryById);
                    }
                }
            }

            if (now() - lastYield >= FRAME_BUDGET_MS) {
                flushUpdate();
                if (now() - lastTimerYield >= TIMER_YIELD_INTERVAL_MS) {
                    await timerYield();
                    lastTimerYield = now();
                } else {
                    await portYield();
                }
                lastYield = now();
            }
        }
    } finally {
        flushUpdate();
        dispose();
    }
};

export function useOptimizer(
    inventory: InventoryItem[],
    setInventory: React.Dispatch<React.SetStateAction<InventoryItem[]>>,
    machineId: string,
    getUsedItems: (excludeId: string) => Set<string>,
    defaultTier: GridTier = 3,
    isExternallySolving: boolean = false
) {
    const getSavedState = () => {
        const saved = localStorage.getItem(`optimizer_machine_${machineId}`);
        if (saved) {
            try { return JSON.parse(saved); } catch (e) { return null; }
        }
        return null;
    };

    const savedState = getSavedState();

    const [tier, setTier] = useState<GridTier>(() => {
        const saved = localStorage.getItem(`optimizer_machine_${machineId}`);
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                if (parsed.tier && [1, 2, 3].includes(parsed.tier)) {
                    return parsed.tier as GridTier;
                }
            } catch (e) {
                console.error(e);
            }
        }
        return defaultTier;
    });

    const [targetStats, setTargetStats] = useState<TargetStats>(savedState?.targetStats ?? { Performance: null, Quality: null, Efficiency: null });
    const [maximizeStats, setMaximizeStats] = useState(savedState?.maximizeStats ?? { Performance: false, Quality: false, Efficiency: false });
    const [ignoreStats, setIgnoreStats] = useState(savedState?.ignoreStats ?? { Performance: false, Quality: false, Efficiency: false });
    const [statPriority, setStatPriority] = useState(savedState?.statPriority ?? { Performance: 1, Quality: 1, Efficiency: 1 });

    const [board, setBoard] = useState<(InventoryItem | 'Locked' | null)[][]>(() => initializeBoard(savedState?.tier ?? defaultTier, savedState?.boardIds, inventory));
    const boardRef = useRef(board);
    const setBoardSync = (newBoard: any) => {
        boardRef.current = newBoard;
        setBoard(newBoard);
    };

    const [isInitializedFromSave, setIsInitializedFromSave] = useState(false);

    useEffect(() => {
        if (!isInitializedFromSave && inventory.length > 0 && savedState?.boardIds) {
            const initialized = initializeBoard(tier, savedState.boardIds, inventory);
            setBoardSync(initialized);
            setIsInitializedFromSave(true);
        }
    }, [inventory, tier, savedState, isInitializedFromSave]);

    const [bestTotals, setBestTotals] = useState<Stats>({ Performance: 0, Quality: 0, Efficiency: 0 });
    const [bestPieceStats, setBestPieceStats] = useState<Map<string, Stats>>(new Map());

    const [isSolving, setIsSolving] = useState(false);
    const [warningMsg, setWarningMsg] = useState<string | null>(null);
    const [solutionCode, setSolutionCode] = useState<string>('');
    const isSolvingRef = useRef(false);

    const getAvailableInventory = () => {
        if (!getUsedItems || !machineId) return inventory.filter(i => !i.isLocked);
        const used = getUsedItems(machineId);
        return inventory.filter(item => !used.has(item.id) && !item.isLocked);
    };

    const getInventoryForCode = () => {
        return inventory;
    };

    const handleTierChange = (newTier: GridTier) => {
        setTier(newTier);
        setBoardSync(initializeBoard(newTier));
        setBestTotals({ Performance: 0, Quality: 0, Efficiency: 0 });
        setBestPieceStats(new Map());
        setWarningMsg(null);
        setSolutionCode('');
    };

    const resetBoard = () => {
        if (isSolving) {
            isSolvingRef.current = false;
            setIsSolving(false);
        }
        setBoardSync(initializeBoard(tier));
        setBestTotals({ Performance: 0, Quality: 0, Efficiency: 0 });
        setBestPieceStats(new Map());
        setWarningMsg(null);
        // Clear maximize settings
        //setTargetStats({ Performance: null, Quality: null, Efficiency: null });
        //setMaximizeStats({ Performance: false, Quality: false, Efficiency: false });
        //setIgnoreStats({ Performance: false, Quality: false, Efficiency: false });
        //setStatPriority({ Performance: 1, Quality: 1, Efficiency: 1 });
        setSolutionCode('');
    };

    const stopOptimization = () => {
        isSolvingRef.current = false;
        setIsSolving(false);
    };

    const manuallyPlaceItem = (item: InventoryItem, rootX: number, rootY: number, offsets: Point[]) => {
        const next = boardRef.current.map(row => [...row]);
        let swapItemIds = new Set<string>();

        for (const pt of offsets) {
            const px = rootX + pt.x;
            const py = rootY + pt.y;
            if (px >= 0 && px < 7 && py >= 0 && py < 5) {
                const cell = next[py][px];
                if (cell && cell !== 'Locked' && cell.id !== item.id) {
                    if (cell.shape === item.shape) swapItemIds.add(cell.id);
                }
            }
        }

        for (let y = 0; y < 5; y++) {
            for (let x = 0; x < 7; x++) {
                const cell = next[y][x];
                if (cell && cell !== 'Locked') {
                    if (cell.id === item.id || swapItemIds.has(cell.id)) {
                        next[y][x] = null;
                    }
                }
            }
        }

        for (const pt of offsets) {
            const px = rootX + pt.x;
            const py = rootY + pt.y;
            if (px >= 0 && px < 7 && py >= 0 && py < 5) {
                next[py][px] = item;
            }
        }
        setBoardSync(next);
    };

    const manuallyRemoveItem = (itemId: string) => {
        const next = boardRef.current.map(row => [...row]);
        for (let y = 0; y < 5; y++) {
            for (let x = 0; x < 7; x++) {
                const cell = next[y][x];
                if (cell && cell !== 'Locked' && cell.id === itemId) {
                    next[y][x] = null;
                }
            }
        }
        setBoardSync(next);
    };

    const isValidPlacement = (item: InventoryItem, rootX: number, rootY: number, offsets: Point[]) => {
        for (const pt of offsets) {
            const px = rootX + pt.x;
            const py = rootY + pt.y;
            if (px < 0 || px >= 7 || py < 0 || py >= 5) return false;
            const cell = boardRef.current[py][px];
            if (cell === 'Locked') return false;
            if (cell && cell.id !== item.id) return false;
        }
        return true;
    };

    const importSolution = (code: string) => {
        try {
            const reader = new BitReader(code);
            const decodedTier = reader.read(2) as GridTier;
            setTier(decodedTier);

            const maxP = reader.read(1) === 1;
            const maxQ = reader.read(1) === 1;
            const maxE = reader.read(1) === 1;
            setMaximizeStats({ Performance: maxP, Quality: maxQ, Efficiency: maxE });

            const readTarget = () => {
                const hasTarget = reader.read(1) === 1;
                return hasTarget ? reader.read(12) - 2048 : null;
            };

            setTargetStats({ Performance: readTarget(), Quality: readTarget(), Efficiency: readTarget() });

            const newInventory: InventoryItem[] = [];
            const newBoard: (InventoryItem | 'Locked' | null)[][] = initializeBoard(decodedTier);
            const numModules = reader.read(8);

            for (let i = 0; i < numModules; i++) {
                const shapeIdx = reader.read(4);
                const colorIdx = reader.read(3);
                const shape = SHAPE_MAP[shapeIdx];
                const color = COLOR_MAP_KEYS[colorIdx];

                const posCount = reader.read(3);
                const positions: number[] = [];
                for (let p = 0; p < posCount; p++) positions.push(reader.read(6));

                const template = shape === 'Node1x2' ? { displayName: 'Node' } : MODULE_TEMPLATES.find(m => m.shape === shape && m.color === color) || { displayName: 'Unknown Module' };
                const reconstructedEffects: [ItemEffect, ItemEffect] = ['None', 'None'];
                const base = getBaseStats({ shape, color, displayName: template.displayName } as any);
                const maxBaseValue = Math.max(Math.abs(base.Performance), Math.abs(base.Quality), Math.abs(base.Efficiency));
                const reconstructedValues: [number, number] = [maxBaseValue * 2, maxBaseValue * 2];

                for (let eIdx = 0; eIdx < 2; eIdx++) {
                    const hasEffect = reader.read(1) === 1;
                    if (hasEffect) {
                        const effIdx = reader.read(4);
                        const eff = EFFECT_MAP[effIdx];
                        reconstructedEffects[eIdx] = eff;

                        const hasValue = reader.read(1) === 1;
                        if ((eff === 'Learning Algorithm' || eff === 'Degrading') && hasValue) {
                            reconstructedValues[eIdx] = reader.read(12) - 2048;
                        }
                    }
                }

                const newItem: InventoryItem = { id: `${shape}_${color}_${Math.random().toString(36).substring(2, 8)}`, shape, color, displayName: template.displayName, effects: reconstructedEffects, effectValues: reconstructedValues };
                newInventory.push(newItem);
                positions.forEach((pos: number) => newBoard[Math.floor(pos / 7)][pos % 7] = newItem);
            }

            setInventory(newInventory);
            setBoardSync(newBoard);
            setSolutionCode(code);
            setWarningMsg(null);

            const { totals, pieceStats } = calculateBoardStats(newBoard, newInventory);
            setBestTotals(totals);
            setBestPieceStats(new Map(pieceStats));
        } catch (e) {
            setWarningMsg("Failed to import solution code. The code might be broken or from an incompatible version.");
        }
    };

    useEffect(() => {
        if (!isSolving && !isExternallySolving) {
            const invById = indexInventoryById(inventory);
            let boardChanged = false;
            const newBoard = boardRef.current.map(row => row.map(cell => {
                if (cell && cell !== 'Locked') {
                    const invMatch = invById.get(cell.id);
                    if (invMatch && invMatch !== cell) {
                        boardChanged = true;
                        return invMatch;
                    }
                }
                return cell;
            }));

            const boardToCalculate = boardChanged ? newBoard : boardRef.current;
            const availableInventory = getAvailableInventory();
            const { totals, pieceStats } = calculateBoardStats(boardToCalculate, availableInventory, indexInventoryById(availableInventory));

            setBestTotals(totals);
            setBestPieceStats(new Map(pieceStats));
            if (boardChanged) setBoardSync(newBoard);

            const boardIds = boardToCalculate.map(row => row.map(c => c && c !== 'Locked' ? c.id : c));
            localStorage.setItem(`optimizer_machine_${machineId}`, JSON.stringify({
                tier, maximizeStats, targetStats, ignoreStats, statPriority, boardIds
            }));

            if (inventory.length > 0) {
                // Remove unused infinite clones to avoid super long solution code
                const usedCloneIds = new Set<string>();
                boardToCalculate.forEach(row => row.forEach(cell => {
                    if (cell && cell !== 'Locked' && cell.id.includes('_clone_')) {
                        usedCloneIds.add(cell.id);
                    }
                }));

                const fullInventoryForMachine = getInventoryForCode();
                const availableForCode = fullInventoryForMachine.filter(item => !item.id.includes('_clone_') || usedCloneIds.has(item.id));
                const newCode = generateCodeFromState(tier, maximizeStats, targetStats, availableForCode, boardToCalculate);
                setSolutionCode(newCode);

                // Never publish a run that has no representable code
                // It is an inventory past the 8-bit module count the format allows
                if (newCode) {
                    if (totals.Performance !== 0 || totals.Quality !== 0 || totals.Efficiency !== 0) {
                        const timer = setTimeout(() => saveToDatabase(tier, totals, newCode, availableForCode), 3000000); // save timer
                        return () => clearTimeout(timer);
                    }
                }
            } else {
                setSolutionCode('');
            }
        }
    }, [inventory, tier, maximizeStats, targetStats, ignoreStats, statPriority, machineId, getUsedItems, board, isSolving, isExternallySolving]);

    const runOptimization = async () => {
        if (isSolving) {
            isSolvingRef.current = false;
            return;
        }

        const fullInventoryForMachine = getInventoryForCode();
        const usedByOthers = getUsedItems(machineId);

        const solverPool = inventory.filter(i => !i.isLocked && !usedByOthers.has(i.id));

        let boardHasMovablePieces = false;
        boardRef.current.forEach(row => row.forEach(cell => {
            if (cell && cell !== 'Locked') boardHasMovablePieces = true;
        }));

        if (solverPool.length === 0 && !boardHasMovablePieces) {
            setWarningMsg(`Cannot optimize: No unused modules available.`);
            return;
        }

        const engineInventory = inventory.map(item =>
            usedByOthers.has(item.id) ? { ...item, isLocked: true } : item
        );

        setSolutionCode('');
        setWarningMsg(null);
        setIsSolving(true);
        isSolvingRef.current = true;

        const config = { id: machineId, tier, targetStats, maximizeStats, ignoreStats, statPriority };

        await runOptimizationEngine([config], [boardRef.current], engineInventory, fullInventoryForMachine, isSolvingRef, (updates) => {
            const myUpdate = updates.get(machineId);
            if (myUpdate) {
                setBoardSync(myUpdate.board);
                setBestTotals(myUpdate.totals);
                setBestPieceStats(myUpdate.pieceStats);
                setSolutionCode(myUpdate.code);
            }
        });

        setIsSolving(false);
    };

    const applyUpdate = (updatedBoard: any[][], updatedTotals: Stats, updatedPieceStats: Map<string, Stats>, updatedCode: string) => {
        setBoardSync(updatedBoard);
        setBestTotals(updatedTotals);
        setBestPieceStats(updatedPieceStats);
        if (updatedCode) setSolutionCode(updatedCode);
    };

    return {
        tier, setTier, handleTierChange, targetStats, setTargetStats,
        maximizeStats, setMaximizeStats, ignoreStats, setIgnoreStats,
        statPriority, setStatPriority, board, bestTotals, bestPieceStats,
        isSolving, stopOptimization, warningMsg, setWarningMsg,
        solutionCode, setSolutionCode, importSolution, runOptimization, resetBoard,
        manuallyPlaceItem, manuallyRemoveItem, isValidPlacement, boardRef, applyUpdate
    };
}