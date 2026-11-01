import {useState, useRef, useEffect} from 'react';
import {createClient} from '@supabase/supabase-js';
import type {GridTier, InventoryItem, Stats, TargetStats, Point, ModuleShape, ModuleColor, ItemEffect} from '../types';
import type {Orientation} from '../utils';
import {
    getBaseStats,
    applyInternalEffects,
    PRECOMPUTED_ORIENTATIONS,
    roundStat,
    isEvaporatorMachine,
    isModuleAllowedInMachine,
    getMachineTypeName
} from '../utils';
import {MODULE_TEMPLATES, getGridSize, EVAPORATOR_GRID_SIZE} from '../constants';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://yhiojdutwgfxrgakbrjs.supabase.co';
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InloaW9qZHV0d2dmeHJnYWticmpzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY0ODcwMjMsImV4cCI6MjEwMjA2MzAyM30.lVkU06tLfM64aFYL2Gx-UMPFL9KCRSaadu58TDWMmSI';
const supabase = createClient(supabaseUrl, supabaseKey);

const SHAPE_MAP: ModuleShape[] = ['Node1x2', 'Line1x2', 'L3', 'L4_Base', 'T4_Base', 'Square4_Base', 'L4_High', 'T4_High', 'Square4_High', 'P5', 'C5', 'Line4'];
const COLOR_MAP_KEYS: ModuleColor[] = ['White', 'Red', 'Yellow', 'Green', 'Purple', 'DarkRed', 'Grey', 'Blue', 'Gold', 'Brown', 'DarkGreen', 'DarkPurple'];
const EFFECT_MAP: ItemEffect[] = ['None', 'Premium', 'Inferior', 'Overcharged', 'Degrading', 'Negative Feedback', 'Receiver', 'Side Mount', 'Top Mount', 'Learning Algorithm'];

const SPECIAL_MODULE_IDS: string[] = [
    'Neural Core Module (Uncapped)',
    'Neural Core Module (Capped)',
    'Alarm Transmitter Module',
    'Furnace Module (Junk Processing)',
    'Furnace Module (Blast)',
    'Evaporator Solvent Recovery Module',
    'Dream Cap Neutralizer Hydroponic Module',
    'Dream Cap Nightmare Hydroponic Module',
    'Hydroponic Smuggler Module',
    'Kotton Auto Loom Hydroponic Module',
    'Chemical Equipment Module',
    'Negative Trait Filter Module',
    'Positive Trait Filter Module',
    'Precision Extraction Module',
    'Genetic Stabilizer Module',
    'Filterweed Production Hydroponic Module',
    'Hydroreed Filter Hydroponic Module',
    'Nutrifruit Hydroponic Module',
    'Computer Numerical Control Module',
    'Melee Batch Module',
    'Metal Printer Module',
    'Glitched Module'
];

const CODE_FORMAT_VERSION = 1;

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

const countEffect = (item: InventoryItem, effect: ItemEffect) => {
    let n = 0;
    if (item.effects[0] === effect) n++;
    if (item.effects[1] === effect) n++;
    return n;
};

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

    const isEvaporatorGrid = brd.length === EVAPORATOR_GRID_SIZE.rows && (brd[0]?.length ?? 0) === EVAPORATOR_GRID_SIZE.cols;

    writer.write(0, 2);
    writer.write(CODE_FORMAT_VERSION, 4);
    writer.write(isEvaporatorGrid ? 1 : 0, 1);
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

    const cols = brd[0]?.length || 7;
    const placedItemsMap = new Map<string, number[]>();
    brd.forEach((row, y) => row.forEach((cell, x) => {
        if (cell && cell !== 'Locked') {
            if (!placedItemsMap.has(cell.id)) {
                placedItemsMap.set(cell.id, []);
            }
            placedItemsMap.get(cell.id)!.push(y * cols + x);
        }
    }));

    inv.forEach(item => {
        const specialIdx = SPECIAL_MODULE_IDS.indexOf(item.displayName);
        if (specialIdx >= 0) {
            writer.write(1, 1);
            writer.write(specialIdx, 6);
        } else {
            writer.write(0, 1);
            writer.write(SHAPE_MAP.indexOf(item.shape), 4);
            writer.write(COLOR_MAP_KEYS.indexOf(item.color), 4);
        }

        const positions = placedItemsMap.get(item.id) || [];
        writer.write(positions.length, 3);
        positions.forEach(p => writer.write(p, 6));

        writer.write(item.isLocked ? 1 : 0, 1);
        writer.write(item.isStuck ? 1 : 0, 1);

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

    supabase.from('leaderboards').insert([submission]).then(({error}) => {
        if (error) console.error(error);
    });
};

export function initializeBoard(currentTier: GridTier, initialIds?: (string | 'Locked' | null)[][], inventory?: InventoryItem[], isEvaporator: boolean = false) {
    const {rows, cols} = getGridSize(isEvaporator);
    const grid = Array.from({length: rows}, () => Array.from({length: cols}, () => null as any));
    if (!isEvaporator) {
        if (currentTier === 1 || currentTier === 2) {
            grid[0][0] = grid[0][6] = grid[4][0] = grid[4][6] = 'Locked';
        }
        if (currentTier === 1) {
            grid[1][3] = grid[2][2] = grid[2][3] = grid[2][4] = grid[3][3] = 'Locked';
        }
    }

    if (initialIds && inventory) {
        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
                if (grid[y][x] === 'Locked') continue;
                const cellId = initialIds[y]?.[x];
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

export const calculateBoardStats = (
    currentBoard: (InventoryItem | 'Locked' | null)[][],
    currentInventory: InventoryItem[],
    inventoryById?: Map<string, InventoryItem>
) => {
    const totals: Stats = {Performance: 0, Quality: 0, Efficiency: 0};
    const pieceStats = new Map<string, Stats>();
    let coveredNodeSides = 0;
    let negativeContactCount = 0;
    let placedPiecesCount = 0;
    let placedAlarmsCount = 0;
    let placedJunkCount = 0;
    let placedBlastCount = 0;

    const invById = inventoryById ?? indexInventoryById(currentInventory);

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
    const rows = currentBoard.length;
    const cols = currentBoard[0]?.length || 7;
    const gridItems: (InventoryItem | null)[] = new Array(rows * cols).fill(null);

    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            const boardCell = currentBoard[y][x];
            if (boardCell && boardCell !== 'Locked') {
                const cell = invById.get(boardCell.id) || boardCell;
                const idx = y * cols + x;
                gridItems[idx] = cell;

                const existing = placedPieces.get(cell.id);
                if (existing === undefined) {
                    placedPieces.set(cell.id, {item: cell, minX: x, minY: y, cells: [idx], adjNodes: 0});
                    placedPiecesCount++;
                } else {
                    if (x < existing.minX) existing.minX = x;
                    if (y < existing.minY) existing.minY = y;
                    existing.cells.push(idx);
                }
            }
        }
    }

    for (const {item, cells} of placedPieces.values()) {
        if (item.color !== 'White') continue;

        let adjSet = nodeAdjacencies.get(item.id);
        if (adjSet === undefined) {
            adjSet = new Set<string>();
            nodeAdjacencies.set(item.id, adjSet);
        }

        for (const idx of cells) {
            const x = idx % cols;
            const y = (idx - x) / cols;
            for (let d = 0; d < 4; d++) {
                const nx = x + NEIGHBOR_DX[d];
                const ny = y + NEIGHBOR_DY[d];
                if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;

                const adj = gridItems[ny * cols + nx];
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
    for (const {item, cells} of placedPieces.values()) {
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
                const x = idx % cols;
                const y = (idx - x) / cols;
                for (let d = 0; d < 4; d++) {
                    const nx = x + NEIGHBOR_DX[d];
                    const ny = y + NEIGHBOR_DY[d];
                    if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;

                    const neighbor = gridItems[ny * cols + nx];
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

    for (const {item, minX, minY, adjNodes} of placedPieces.values()) {
        if (item.color === 'White') continue;

        let {Performance: p, Quality: q, Efficiency: e} = internalStats.get(item.id)!;

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

        const finalStats = {Performance: roundStat(p), Quality: roundStat(q), Efficiency: roundStat(e)};

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

    return {
        totals,
        pieceStats,
        coveredNodeSides,
        negativeContactCount,
        placedPiecesCount,
        placedAlarmsCount,
        placedJunkCount,
        placedBlastCount
    };
};

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
    const {Performance: p, Quality: q, Efficiency: e} = internal;
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

const NEIGHBOR_SCRATCH: InventoryItem[] = [];

const isPureNegativeScored = (s: Stats, ignP: boolean, ignQ: boolean, ignE: boolean) =>
    (ignP || s.Performance <= 0) && (ignQ || s.Quality <= 0) && (ignE || s.Efficiency <= 0)
    && ((!ignP && s.Performance < 0) || (!ignQ && s.Quality < 0) || (!ignE && s.Efficiency < 0));

export const evaluatePlacementDelta = (
    ctx: PlacementContext,
    x: number, y: number,
    orientation: Orientation,
    testBoard: (InventoryItem | 'Locked' | null)[][],
    isBoardEmpty: boolean,
    precomputedInternal: Map<string, Stats>,
    dynWp: number, dynWq: number, dynWe: number,
    currentP: number, currentQ: number, currentE: number,
    config: MachineConfig
) => {
    const rows = testBoard.length;
    const cols = testBoard[0]?.length || 7;

    if (x + orientation.minX < 0 || x + orientation.maxX >= cols ||
        y + orientation.minY < 0 || y + orientation.maxY >= rows) {
        return -Infinity;
    }

    const {xs, ys, count} = orientation;
    const {internal, isWhite, nfCount} = ctx;
    const ignP = statIsIgnored(config, 'Performance');
    const ignQ = statIsIgnored(config, 'Quality');
    const ignE = statIsIgnored(config, 'Efficiency');
    const isPureNegative = isPureNegativeScored(internal, ignP, ignQ, ignE);

    let isConnected = false;
    let adjNodes = 0;
    let negativeContactCount = 0;
    let neighborCount = 0;

    for (let i = 0; i < count; i++) {
        const px = x + xs[i];
        const py = y + ys[i];

        if (testBoard[py][px] !== null) return -Infinity;
        if (px === 0 || px === cols - 1 || py === 0 || py === rows - 1) isConnected = true;

        for (let d = 0; d < 4; d++) {
            const nx = px + NEIGHBOR_DX[d];
            const ny = py + NEIGHBOR_DY[d];
            if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;

            const adjCell = testBoard[ny][nx];
            if (!adjCell || adjCell === 'Locked') continue;

            isConnected = true;

            const adjIsWhite = adjCell.color === 'White';
            if (isWhite) {
                if (!adjIsWhite) {
                    const adjInt = precomputedInternal.get(adjCell.id);
                    if (adjInt !== undefined && isPureNegativeScored(adjInt, ignP, ignQ, ignE)) {
                        negativeContactCount++;
                    }
                }
            } else if (isPureNegative && adjIsWhite) {
                negativeContactCount++;
            }

            let seen = false;
            for (let k = 0; k < neighborCount; k++) {
                if (NEIGHBOR_SCRATCH[k].id === adjCell.id) {
                    seen = true;
                    break;
                }
            }
            if (!seen) NEIGHBOR_SCRATCH[neighborCount++] = adjCell;
        }
    }

    if (!isConnected && !isBoardEmpty) return -10000;

    let pDelta = 0, qDelta = 0, eDelta = 0;
    let nfPerf = 0, nfQual = 0, nfEff = 0;

    for (let k = 0; k < neighborCount; k++) {
        const adjPiece = NEIGHBOR_SCRATCH[k];
        const adjInternal = precomputedInternal.get(adjPiece.id);
        if (adjInternal === undefined) continue;

        const adjIsWhite = adjPiece.color === 'White';
        if (!isWhite && adjIsWhite) {
            adjNodes++;
            pDelta += roundStat(internal.Performance * 0.20);
            qDelta += roundStat(internal.Quality * 0.20);
            eDelta += roundStat(internal.Efficiency * 0.20);
        } else if (isWhite && !adjIsWhite) {
            pDelta += roundStat(adjInternal.Performance * 0.20);
            qDelta += roundStat(adjInternal.Quality * 0.20);
            eDelta += roundStat(adjInternal.Efficiency * 0.20);
        }

        if (nfCount > 0 && !adjIsWhite) {
            if (adjInternal.Performance < 0) nfPerf += adjInternal.Performance;
            if (adjInternal.Quality < 0) nfQual += adjInternal.Quality;
            if (adjInternal.Efficiency < 0) nfEff += adjInternal.Efficiency;
        }
    }

    let myP = internal.Performance;
    let myQ = internal.Quality;
    let myE = internal.Efficiency;

    let pBonus = 0, qBonus = 0, eBonus = 0;
    if (ctx.hasSideMount && x + orientation.minX === 0) {
        pBonus += roundStat(myP * 0.20);
        qBonus += roundStat(myQ * 0.20);
        eBonus += roundStat(myE * 0.20);
    }
    if (ctx.hasTopMount && y + orientation.minY === 0) {
        pBonus += roundStat(myP * 0.20);
        qBonus += roundStat(myQ * 0.20);
        eBonus += roundStat(myE * 0.20);
    }
    if (ctx.hasReceiver) {
        pBonus += roundStat(myP * 0.10 * adjNodes);
        qBonus += roundStat(myQ * 0.10 * adjNodes);
        eBonus += roundStat(myE * 0.10 * adjNodes);
    }

    myP += pBonus;
    myQ += qBonus;
    myE += eBonus;

    if (nfCount > 0) {
        myP += nfCount * 0.25 * nfPerf;
        myQ += nfCount * 0.25 * nfQual;
        myE += nfCount * 0.25 * nfEff;
    }

    pDelta += roundStat(myP);
    qDelta += roundStat(myQ);
    eDelta += roundStat(myE);

    let statScore = 0;
    const scoreStat = (key: keyof Stats, delta: number, current: number, dynW: number) => {
        if (statIsIgnored(config, key)) return 0;
        if (delta === 0) return 0;

        const target = config.targetStats[key];
        const maximize = config.maximizeStats[key];

        if (target !== null && !maximize) {
            const before = current;
            const after = current + delta;

            if (before >= target && after >= target) return 0;
            if (before >= target && after < target) return delta * dynW * 100;
            if (before < target) {
                if (after <= target) return delta * dynW;
                else return (target - before) * dynW;
            }
        } else if (target !== null && maximize) {
            const before = current;
            const after = current + delta;
            if (before >= target) {
                return delta * dynW;
            } else {
                if (after <= target) return delta * dynW * 10;
                else return ((target - before) * dynW * 10) + ((after - target) * dynW);
            }
        } else if (maximize) {
            return delta * dynW;
        }
        return 0;
    };

    statScore += scoreStat('Performance', pDelta, currentP, dynWp);
    statScore += scoreStat('Quality', qDelta, currentQ, dynWq);
    statScore += scoreStat('Efficiency', eDelta, currentE, dynWe);

    const tiebreakers = (adjNodes * 0.05) - (negativeContactCount * 1000);
    if (statScore <= 0) return -10000 + tiebreakers;
    return statScore + tiebreakers;
};

export type MachineConfig = {
    id: string;
    tier: GridTier;
    targetStats: TargetStats;
    maximizeStats: any;
    ignoreStats?: Partial<Record<keyof Stats, boolean>>;
    statPriority?: Partial<Record<keyof Stats, number>>;
    machineType?: string;
};

const STAT_KEYS: (keyof Stats)[] = ['Performance', 'Quality', 'Efficiency'];

export const isLumpyModule = (item: InventoryItem) => item.displayName.includes('Neural Core');

export const isSpecialModule = (item: InventoryItem) =>
    item.displayName.includes('Alarm Transmitter Module')
    || item.displayName.includes('Junk Processing')
    || item.displayName.includes('(Blast)')
    || item.displayName.includes('Evaporator Solvent Recovery Module')
    || item.displayName.includes('Dream Cap Neutralizer')
    || item.displayName.includes('Dream Cap Nightmare')
    || item.displayName.includes('Hydroponic Smuggler')
    || item.displayName.includes('Kotton Auto Loom')
    || item.displayName.includes('Chemical Equipment Module')
    || item.displayName.includes('Negative Trait Filter Module')
    || item.displayName.includes('Positive Trait Filter Module')
    || item.displayName.includes('Precision Extraction Module')
    || item.displayName.includes('Genetic Stabilizer Module')
    || item.displayName.includes('Filterweed Production')
    || item.displayName.includes('Hydroreed Filter')
    || item.displayName.includes('Nutrifruit Hydroponic Module')
    || item.displayName.includes('Computer Numerical Control Module')
    || item.displayName.includes('Melee Batch Module')
    || item.displayName.includes('Metal Printer Module')
    || item.displayName.includes('Glitched Module');

const statIsIgnored = (m: MachineConfig, key: keyof Stats) => Boolean(m.ignoreStats?.[key]);
const DEFAULT_STAT_PRIORITY = 1;
const priorityOf = (m: MachineConfig, key: keyof Stats) =>
    m.statPriority?.[key] ?? DEFAULT_STAT_PRIORITY;

const PRIORITY_WEIGHT_STEP = 4;
const DRAW_TOURNAMENT = 4;
const TARGET_MET_DRAW_SCALE = 0.25;
const RESTART_AFTER_STAGNATIONS = 8;
const BALANCE_PENALTY_WEIGHT = 14;
const PAIR_REBUILD_PROBABILITY = 0.35;
const SPECIAL_RELOCATE_PROBABILITY = 0.6;
const SPECIAL_EXPLORE_PROBABILITY = 0.25;

const compareTiers = (a: Float64Array, b: Float64Array) => {
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return 0;
};
const statIsScored = (m: MachineConfig, key: keyof Stats) =>
    !statIsIgnored(m, key) && (Boolean(m.maximizeStats?.[key]) || m.targetStats[key] !== null);

const PLACEMENT_DEPENDENT_EFFECTS: ItemEffect[] = ['Side Mount', 'Top Mount', 'Receiver', 'Negative Feedback'];
const MAX_PIECES_PER_BOARD = 18;

const dominates = (a: number[], b: number[]) => {
    let strictlyBetter = false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] < b[i]) return false;
        if (a[i] > b[i]) strictlyBetter = true;
    }
    return strictlyBetter;
};

export const buildSearchPool = (
    inventory: InventoryItem[],
    precomputedInternal: Map<string, Stats>,
    machines: MachineConfig[]
): InventoryItem[] => {
    const scoredKeys = STAT_KEYS.filter(key => machines.some(m => statIsScored(m, key)));

    if (scoredKeys.length === 0) return inventory.filter(item => !isSpecialModule(item) && !item.isLocked && !item.isStuck);

    const keepCap = machines.length * MAX_PIECES_PER_BOARD;
    const kept: InventoryItem[] = [];
    const groups = new Map<string, Map<string, InventoryItem[]>>();

    for (const item of inventory) {
        if (isSpecialModule(item)) continue;
        if (item.isLocked || item.isStuck) continue;

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

        for (const item of frontier) kept.push(item);
        for (let i = 0; i < rest.length && frontier.length + i < keepCap; i++) kept.push(rest[i]);
    }

    return kept;
};

type BoardStats = ReturnType<typeof calculateBoardStats>;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const shuffleInPlace = <T, >(arr: T[]) => {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
    }
};

const createYielder = () => {
    const timerYield = () => new Promise<void>(resolve => {
        setTimeout(resolve, 0);
    });

    if (typeof MessageChannel === 'undefined') {
        return {
            portYield: timerYield, timerYield, dispose: () => {
            }
        };
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

const FRAME_BUDGET_MS = 12;
const TIMER_YIELD_INTERVAL_MS = 32;

export const runOptimizationEngine = async (
    machines: MachineConfig[],
    initialBoards: any[][][],
    searchPoolInventory: InventoryItem[],
    fullInventory: InventoryItem[],
    isSolvingRef: { current: boolean },
    onUpdate: (updates: Map<string, {
        board: any[][],
        totals: Stats,
        pieceStats: Map<string, Stats>,
        code: string
    }>) => void
) => {
    const machineCount = machines.length;
    const precomputedInternal = new Map<string, Stats>();
    fullInventory.forEach(item => precomputedInternal.set(item.id, applyInternalEffects(item)));

    const placementContexts = new Map<string, PlacementContext>();
    fullInventory.forEach(item => placementContexts.set(item.id, buildPlacementContext(item, precomputedInternal)));

    const searchPool = buildSearchPool(searchPoolInventory, precomputedInternal, machines);

    const poolIndexOf = new Map<string, number>();
    searchPool.forEach((item, i) => poolIndexOf.set(item.id, i));
    const ctxByIndex: PlacementContext[] = searchPool.map(item => placementContexts.get(item.id)!);
    const orientationsByIndex = searchPool.map(item => PRECOMPUTED_ORIENTATIONS.get(item.shape));

    const poolOrder = new Int32Array(searchPool.length);
    for (let i = 0; i < poolOrder.length; i++) poolOrder[i] = i;
    const poolShapeCount = new Set(searchPool.map(item => item.shape)).size;
    const inventoryById = indexInventoryById(fullInventory);

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

    const currentTiers = new Float64Array(tierCount + 1);
    const epochTiers = new Float64Array(tierCount + 1).fill(-Infinity);
    const bestTiers = new Float64Array(tierCount + 1).fill(-Infinity);
    const currentBoards = initialBoards.map(b => b.map(row => [...row]));

    const currentStats: BoardStats[] = currentBoards.map(b => calculateBoardStats(b, fullInventory, inventoryById));
    const currentCodes: string[] = new Array(machineCount).fill('');
    const codeIsStale: boolean[] = new Array(machineCount).fill(true);

    const bestBoards = currentBoards.map(b => b.map(row => [...row]));
    const bestStats: BoardStats[] = [...currentStats];

    const testBoards: (InventoryItem | 'Locked' | null)[][][] =
        currentBoards.map(b => b.map(row => [...row]));

    let stagnationCounter = 0;
    let stagnationRuns = 0;
    const STAGNATION_LIMIT = 150;

    const baseWeights = machines.map(m => {
        const getW = (key: keyof Stats) => {
            if (statIsIgnored(m, key)) return 0;
            let w = 0;
            if (m.maximizeStats[key]) w += 10;
            if (m.targetStats[key] !== null) w += 15;
            return w;
        };

        let wp = getW('Performance');
        let wq = getW('Quality');
        let we = getW('Efficiency');

        const boost = (key: keyof Stats) =>
            statIsIgnored(m, key) ? 1 : Math.pow(PRIORITY_WEIGHT_STEP, tierCount - 1 - tierOf(m, key));
        wp *= boost('Performance');
        wq *= boost('Quality');
        we *= boost('Efficiency');
        return {wp, wq, we};
    });

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
            const w: Stats = {Performance: 0, Quality: 0, Efficiency: 0};
            for (const key of STAT_KEYS) {
                if (statIsIgnored(m, key)) {
                    w[key] = 0;
                    continue;
                }
                let v = 0;
                if (m.maximizeStats[key]) v += 10;
                const ti = targeted.indexOf(key);
                if (ti !== -1) v += 15 * ((mask & (1 << ti)) !== 0 ? TARGET_MET_DRAW_SCALE : 1);
                w[key] = v * Math.pow(PRIORITY_WEIGHT_STEP, tierCount - 1 - tierOf(m, key));
            }
            tables.push(buildDrawValues(w));
        }
        return tables;
    });

    const isIneligible = machines.map((m, mIdx) => {
        const flags = new Uint8Array(searchPool.length);
        const board = currentBoards[mIdx];
        const isSmallGrid = board.length === EVAPORATOR_GRID_SIZE.rows && (board[0]?.length ?? 0) === EVAPORATOR_GRID_SIZE.cols;
        for (let i = 0; i < searchPool.length; i++) {
            if (!isLumpyModule(searchPool[i])) continue;
            const s = ctxByIndex[i].internal;
            let usedValue = 0;
            let wastedValue = 0;
            for (const key of STAT_KEYS) {
                if (s[key] <= 0) continue;
                if (!statIsIgnored(m, key) && (m.maximizeStats[key] || m.targetStats[key] !== null)) usedValue += s[key];
                else wastedValue += s[key];
            }
            if (isSmallGrid || wastedValue > usedValue) flags[i] = 1;
        }
        return flags;
    });

    const lumpyIds = fullInventory.filter(isLumpyModule).map(item => item.id);
    const balanceVals: Stats[] = machines.map(() => ({Performance: 0, Quality: 0, Efficiency: 0}));

    const countAdjacentNodes = (board: (InventoryItem | 'Locked' | null)[][], id: string) => {
        const rows = board.length;
        const cols = board[0]?.length || 7;
        const nodeIds = new Set<string>();
        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
                const cell = board[y][x];
                if (!cell || cell === 'Locked' || cell.id !== id) continue;
                for (let d = 0; d < 4; d++) {
                    const nx = x + NEIGHBOR_DX[d];
                    const ny = y + NEIGHBOR_DY[d];
                    if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
                    const adj = board[ny][nx];
                    if (adj && adj !== 'Locked' && adj.color === 'White') nodeIds.add(adj.id);
                }
            }
        }
        return nodeIds.size;
    };

    const placedMark = new Int32Array(searchPool.length);
    const consumedMark = new Int32Array(searchPool.length);
    let markGen = 0;
    let consumedGen = 0;
    const piecesOnTarget: InventoryItem[] = [];
    const seenOnTarget = new Set<string>();
    const removedIds = new Set<string>();
    const specialsOnBoard: { piece: InventoryItem; cells: number[] }[][] = machines.map(() => []);
    const freeCells: number[] = [];
    const rebuiltMachines: number[] = [];
    const isRebuilt: boolean[] = new Array(machineCount).fill(false);
    const infeasibleShapes = new Set<ModuleShape>();
    const rebuiltStats: (BoardStats | null)[] = new Array(machineCount).fill(null);
    const openCellCount = currentBoards.map(b => {
        let open = 0;
        const rows = b.length;
        const cols = b[0]?.length || 7;
        for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (b[y][x] !== 'Locked') open++;
        return open;
    });

    const compactFreeCells = (fillBoard: (InventoryItem | 'Locked' | null)[][]) => {
        const cols = fillBoard[0]?.length || 7;
        let write = 0;
        for (let c = 0; c < freeCells.length; c++) {
            const idx = freeCells[c];
            const cx = idx % cols;
            const cy = (idx - cx) / cols;
            if (fillBoard[cy][cx] === null) freeCells[write++] = idx;
        }
        freeCells.length = write;
    };

    const placeBestFit = (
        ctx: PlacementContext,
        orientations: Orientation[],
        piece: InventoryItem,
        fillBoard: (InventoryItem | 'Locked' | null)[][],
        fillBoardEmpty: boolean,
        dynWp: number, dynWq: number, dynWe: number,
        currentP: number, currentQ: number, currentE: number,
        config: MachineConfig,
        incumbent: { x: number; y: number; orientation: Orientation } | null = null
    ) => {
        let bestX = -1, bestY = -1;
        let bestOrientation: Orientation | null = null;
        let highestHeuristic = incumbent !== null ? -Infinity : 0.0001;

        if (incumbent !== null) {
            const incumbentScore = evaluatePlacementDelta(
                ctx, incumbent.x, incumbent.y, incumbent.orientation, fillBoard, fillBoardEmpty,
                precomputedInternal, dynWp, dynWq, dynWe, currentP, currentQ, currentE, config
            );
            if (incumbentScore !== -Infinity) {
                highestHeuristic = incumbentScore;
                bestX = incumbent.x;
                bestY = incumbent.y;
                bestOrientation = incumbent.orientation;
            }
        }

        const rows = fillBoard.length;
        const cols = fillBoard[0]?.length || 7;

        for (let c = 0; c < freeCells.length; c++) {
            const idx = freeCells[c];
            const x = idx % cols;
            const y = (idx - x) / cols;

            for (let o = 0; o < orientations.length; o++) {
                const orientation = orientations[o];
                if (x + orientation.minX < 0 || x + orientation.maxX >= cols ||
                    y + orientation.minY < 0 || y + orientation.maxY >= rows) continue;

                const deltaScore = evaluatePlacementDelta(
                    ctx, x, y, orientation, fillBoard, fillBoardEmpty,
                    precomputedInternal, dynWp, dynWq, dynWe, currentP, currentQ, currentE, config
                );
                if (deltaScore > highestHeuristic && deltaScore !== -Infinity) {
                    highestHeuristic = deltaScore;
                    bestX = x;
                    bestY = y;
                    bestOrientation = orientation;
                }
            }
        }

        if (!bestOrientation) return false;

        const {xs, ys, count} = bestOrientation;
        for (let i = 0; i < count; i++) {
            fillBoard[bestY + ys[i]][bestX + xs[i]] = piece;
        }
        compactFreeCells(fillBoard);
        return true;
    };

    const candX: number[] = [];
    const candY: number[] = [];
    const candO: Orientation[] = [];
    const candScore: number[] = [];

    const packingScore = (board: (InventoryItem | 'Locked' | null)[][], x: number, y: number, orientation: Orientation) => {
        const rows = board.length;
        const cols = board[0]?.length || 7;
        let score = 0;
        for (let i = 0; i < orientation.count; i++) {
            const px = x + orientation.xs[i];
            const py = y + orientation.ys[i];
            for (let d = 0; d < 4; d++) {
                const nx = px + NEIGHBOR_DX[d];
                const ny = py + NEIGHBOR_DY[d];
                if (nx < 0 || nx >= cols || ny < 0 || ny >= rows || board[ny][nx] !== null) score++;
            }
        }
        return score;
    };

    const placeSpecialFlexibly = (
        ctx: PlacementContext,
        orientations: Orientation[],
        piece: InventoryItem,
        fillBoard: (InventoryItem | 'Locked' | null)[][],
        fillBoardEmpty: boolean,
        dynWp: number, dynWq: number, dynWe: number,
        currentP: number, currentQ: number, currentE: number,
        config: MachineConfig,
        incumbent: { x: number; y: number; orientation: Orientation } | null
    ) => {
        const rows = fillBoard.length;
        const cols = fillBoard[0]?.length || 7;
        candX.length = 0;
        candY.length = 0;
        candO.length = 0;
        candScore.length = 0;
        let best = -Infinity;

        for (let c = 0; c < freeCells.length; c++) {
            const idx = freeCells[c];
            const x = idx % cols;
            const y = (idx - x) / cols;
            for (let o = 0; o < orientations.length; o++) {
                const orientation = orientations[o];
                if (x + orientation.minX < 0 || x + orientation.maxX >= cols ||
                    y + orientation.minY < 0 || y + orientation.maxY >= rows) continue;
                const score = evaluatePlacementDelta(
                    ctx, x, y, orientation, fillBoard, fillBoardEmpty,
                    precomputedInternal, dynWp, dynWq, dynWe, currentP, currentQ, currentE, config
                );
                if (score === -Infinity) continue;
                candX.push(x);
                candY.push(y);
                candO.push(orientation);
                candScore.push(score);
                if (score > best) best = score;
            }
        }

        if (candX.length === 0) {
            return placeBestFit(ctx, orientations, piece, fillBoard, fillBoardEmpty, dynWp, dynWq, dynWe, currentP, currentQ, currentE, config, incumbent);
        }

        const valuable = best > 0;
        const threshold = valuable ? best * 0.75 : best - 500;
        const explore = Math.random() < SPECIAL_EXPLORE_PROBABILITY;
        let chosen = -1;
        let chosenPack = -1;
        let eligibleCount = 0;
        for (let k = 0; k < candX.length; k++) {
            if (candScore[k] < threshold) continue;
            eligibleCount++;
            if (valuable || explore) {
                if (Math.random() * eligibleCount < 1) chosen = k;
                continue;
            }
            const pack = packingScore(fillBoard, candX[k], candY[k], candO[k]);
            if (pack > chosenPack || (pack === chosenPack && Math.random() < 0.5)) {
                chosenPack = pack;
                chosen = k;
            }
        }
        if (chosen === -1) return false;

        const {xs, ys, count} = candO[chosen];
        for (let i = 0; i < count; i++) {
            fillBoard[candY[chosen] + ys[i]][candX[chosen] + xs[i]] = piece;
        }
        compactFreeCells(fillBoard);
        return true;
    };

    let pendingUpdate = false;
    const flushUpdate = () => {
        if (!pendingUpdate) return;
        pendingUpdate = false;

        const updates = new Map<string, {
            board: any[][],
            totals: Stats,
            pieceStats: Map<string, Stats>,
            code: string
        }>();

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

    const {portYield, timerYield, dispose} = createYielder();
    let lastYield = now();
    let lastTimerYield = lastYield;

    try {
        while (isSolvingRef.current) {
            const isStagnant = stagnationCounter >= STAGNATION_LIMIT;

            const rebuildAll = isStagnant && machineCount > 1;
            const targetMIdx = Math.floor(Math.random() * machineCount);

            rebuiltMachines.length = 0;
            if (rebuildAll) {
                for (let mIdx = 0; mIdx < machineCount; mIdx++) rebuiltMachines.push(mIdx);
                shuffleInPlace(rebuiltMachines);
            } else if (machineCount > 1 && Math.random() < PAIR_REBUILD_PROBABILITY) {
                let partnerMIdx = Math.floor(Math.random() * (machineCount - 1));
                if (partnerMIdx >= targetMIdx) partnerMIdx++;
                rebuiltMachines.push(targetMIdx, partnerMIdx);
            } else {
                rebuiltMachines.push(targetMIdx);
            }

            for (let mIdx = 0; mIdx < machineCount; mIdx++) isRebuilt[mIdx] = false;
            for (const mIdx of rebuiltMachines) {
                isRebuilt[mIdx] = true;
                const src = currentBoards[mIdx];
                const dst = testBoards[mIdx];
                const rows = src.length;
                const cols = src[0]?.length || 7;
                for (let y = 0; y < rows; y++) {
                    const srcRow = src[y];
                    const dstRow = dst[y];
                    for (let x = 0; x < cols; x++) dstRow[x] = srcRow[x];
                }
            }

            markGen++;

            for (let mIdx = 0; mIdx < machineCount; mIdx++) {
                const board = isRebuilt[mIdx] ? testBoards[mIdx] : currentBoards[mIdx];
                const rows = board.length;
                const cols = board[0]?.length || 7;
                if (isRebuilt[mIdx]) {
                    piecesOnTarget.length = 0;
                    seenOnTarget.clear();
                    specialsOnBoard[mIdx].length = 0;

                    for (let y = 0; y < rows; y++) {
                        for (let x = 0; x < cols; x++) {
                            const cell = board[y][x];
                            if (!cell || cell === 'Locked') continue;

                            if (cell.isStuck) continue;

                            if (isSpecialModule(cell) || cell.isLocked) {
                                let entry = specialsOnBoard[mIdx].find(e => e.piece.id === cell.id);
                                if (entry === undefined) {
                                    entry = {piece: cell, cells: []};
                                    specialsOnBoard[mIdx].push(entry);
                                }
                                entry.cells.push(y * cols + x);
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

                        for (let y = 0; y < rows; y++) {
                            for (let x = 0; x < cols; x++) {
                                const cell = board[y][x];
                                if (cell && cell !== 'Locked') {
                                    if (cell.isStuck) continue;
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
                    for (let y = 0; y < rows; y++) {
                        for (let x = 0; x < cols; x++) {
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

                const fillConfig = machines[fillMIdx];
                if (machineCount > 1) {
                    const mine = currentStats[fillMIdx].totals;
                    const laggingOn = (key: keyof Stats) => {
                        if (statIsIgnored(fillConfig, key) || !fillConfig.maximizeStats[key] || fillConfig.targetStats[key] !== null) return false;
                        const myTier = tierOf(fillConfig, key);
                        let sum = 0, count = 0;
                        for (let mIdx = 0; mIdx < machineCount; mIdx++) {
                            const peer = machines[mIdx];
                            if (statIsIgnored(peer, key) || !peer.maximizeStats[key] || peer.targetStats[key] !== null) continue;
                            if (tierOf(peer, key) !== myTier) continue;
                            sum += currentStats[mIdx].totals[key];
                            count++;
                        }
                        return count > 1 && mine[key] < sum / count;
                    };

                    if (laggingOn('Performance')) dynWp *= 2.0;
                    if (laggingOn('Quality')) dynWq *= 2.0;
                    if (laggingOn('Efficiency')) dynWe *= 2.0;
                }

                const fillBoard = testBoards[fillMIdx];
                const rows = fillBoard.length;
                const cols = fillBoard[0]?.length || 7;

                freeCells.length = 0;
                for (let y = 0; y < rows; y++) {
                    for (let x = 0; x < cols; x++) {
                        if (fillBoard[y][x] === null) freeCells.push(y * cols + x);
                    }
                }
                shuffleInPlace(freeCells);
                let fillBoardEmpty = freeCells.length === openCellCount[fillMIdx];

                let currentTotals = calculateBoardStats(fillBoard, fullInventory, inventoryById).totals;

                for (const special of specialsOnBoard[fillMIdx]) {
                    const ctx = placementContexts.get(special.piece.id);
                    const orientations = PRECOMPUTED_ORIENTATIONS.get(special.piece.shape);
                    if (ctx === undefined || orientations === undefined) continue;

                    const anchor = special.cells[0];
                    const homeX = anchor % cols;
                    const homeY = (anchor - homeX) / cols;
                    let home: Orientation | null = null;
                    for (const orientation of orientations) {
                        if (orientation.count !== special.cells.length) continue;
                        let matches = true;
                        for (let i = 0; i < orientation.count; i++) {
                            if (special.cells[i] !== anchor + orientation.ys[i] * cols + orientation.xs[i]) {
                                matches = false;
                                break;
                            }
                        }
                        if (matches) {
                            home = orientation;
                            break;
                        }
                    }

                    for (const idx of special.cells) {
                        const cx = idx % cols;
                        fillBoard[(idx - cx) / cols][cx] = null;
                        freeCells.push(idx);
                    }
                    const incumbent = home === null ? null : {x: homeX, y: homeY, orientation: home};
                    if (Math.random() < SPECIAL_RELOCATE_PROBABILITY) {
                        placeSpecialFlexibly(
                            ctx, orientations, special.piece, fillBoard, fillBoardEmpty, dynWp, dynWq, dynWe,
                            currentTotals.Performance, currentTotals.Quality, currentTotals.Efficiency, fillConfig, incumbent
                        );
                    } else {
                        placeBestFit(
                            ctx, orientations, special.piece, fillBoard, fillBoardEmpty, dynWp, dynWq, dynWe,
                            currentTotals.Performance, currentTotals.Quality, currentTotals.Efficiency, fillConfig, incumbent
                        );
                    }
                    fillBoardEmpty = false;
                    currentTotals = calculateBoardStats(fillBoard, fullInventory, inventoryById).totals;
                }

                infeasibleShapes.clear();

                const targeted = targetedKeys[fillMIdx];
                let metMask = 0;
                for (let i = 0; i < targeted.length; i++) {
                    const key = targeted[i];
                    if (currentStats[fillMIdx].totals[key] >= machines[fillMIdx].targetStats[key]!) {
                        metMask |= 1 << i;
                    }
                }
                const values = drawValues[fillMIdx][metMask];

                let drawn = 0;
                while (drawn < poolOrder.length && infeasibleShapes.size < poolShapeCount) {
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
                    if (isIneligible[fillMIdx][pieceIdx] === 1) continue;

                    const piece = searchPool[pieceIdx];
                    if (infeasibleShapes.has(piece.shape)) continue;

                    const ctx = ctxByIndex[pieceIdx];
                    if (freeCells.length < ctx.size) {
                        infeasibleShapes.add(piece.shape);
                        continue;
                    }

                    const orientations = orientationsByIndex[pieceIdx];
                    if (!orientations) continue;

                    if (placeBestFit(ctx, orientations, piece, fillBoard, fillBoardEmpty, dynWp, dynWq, dynWe, currentTotals.Performance, currentTotals.Quality, currentTotals.Efficiency, fillConfig)) {
                        fillBoardEmpty = false;
                        consumedMark[pieceIdx] = consumedGen;
                        currentTotals = calculateBoardStats(fillBoard, fullInventory, inventoryById).totals;
                    } else {
                        infeasibleShapes.add(piece.shape);
                    }
                }
            }

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

            currentTiers[tierCount] -= totalPiecesPlaced * 5;

            if (machineCount > 1) {
                for (let mIdx = 0; mIdx < machineCount; mIdx++) {
                    const stats = statsFor(mIdx);
                    const board = isRebuilt[mIdx] ? testBoards[mIdx] : currentBoards[mIdx];
                    const vals = balanceVals[mIdx];
                    vals.Performance = stats.totals.Performance;
                    vals.Quality = stats.totals.Quality;
                    vals.Efficiency = stats.totals.Efficiency;
                    for (const id of lumpyIds) {
                        const own = stats.pieceStats.get(id);
                        if (own === undefined) continue;
                        const factor = 1 + 0.2 * countAdjacentNodes(board, id);
                        vals.Performance -= own.Performance * factor;
                        vals.Quality -= own.Quality * factor;
                        vals.Efficiency -= own.Efficiency * factor;
                    }
                }

                for (const statKey of STAT_KEYS) {
                    const isBalanced = (mIdx: number) => {
                        const m = machines[mIdx];
                        return !statIsIgnored(m, statKey) && m.maximizeStats[statKey] && m.targetStats[statKey] === null;
                    };

                    for (let tier = 0; tier < tierCount; tier++) {
                        let sum = 0, count = 0;
                        for (let mIdx = 0; mIdx < machineCount; mIdx++) {
                            if (!isBalanced(mIdx) || tierOf(machines[mIdx], statKey) !== tier) continue;
                            sum += balanceVals[mIdx][statKey];
                            count++;
                        }
                        if (count > 1) {
                            const avg = sum / count;
                            let mad = 0;
                            for (let mIdx = 0; mIdx < machineCount; mIdx++) {
                                if (!isBalanced(mIdx) || tierOf(machines[mIdx], statKey) !== tier) continue;
                                mad += Math.abs(balanceVals[mIdx][statKey] - avg);
                            }
                            currentTiers[tier] -= (mad / count) * BALANCE_PENALTY_WEIGHT;
                        }
                    }
                }
            }

            if (!isSolvingRef.current) break;

            const ordering = compareTiers(currentTiers, epochTiers);
            const improved = ordering > 0;
            if (improved || (ordering === 0 && Math.random() > 0.5)) {
                if (improved) epochTiers.set(currentTiers);
                for (const mIdx of rebuiltMachines) {
                    currentBoards[mIdx] = testBoards[mIdx].map(row => [...row]);
                    currentStats[mIdx] = rebuiltStats[mIdx]!;
                }

                if (improved && compareTiers(currentTiers, bestTiers) > 0) {
                    bestTiers.set(currentTiers);
                    for (let mIdx = 0; mIdx < machineCount; mIdx++) {
                        bestBoards[mIdx] = currentBoards[mIdx].map(row => [...row]);
                        bestStats[mIdx] = currentStats[mIdx];
                    }
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
    const getSavedType = () => localStorage.getItem(`optimizer_machine_type_${machineId}`) || '';
    const [machineType, setMachineType] = useState(getSavedType);

    const isEvaporator = isEvaporatorMachine(machineType);

    const getSavedState = () => {
        const saved = localStorage.getItem(`optimizer_machine_${machineId}`);
        if (saved) {
            try {
                return JSON.parse(saved);
            } catch (e) {
                return null;
            }
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

    const [targetStats, setTargetStats] = useState<TargetStats>(savedState?.targetStats ?? {
        Performance: null,
        Quality: null,
        Efficiency: null
    });
    const [maximizeStats, setMaximizeStats] = useState(savedState?.maximizeStats ?? {
        Performance: false,
        Quality: false,
        Efficiency: false
    });
    const [ignoreStats, setIgnoreStats] = useState(savedState?.ignoreStats ?? {
        Performance: false,
        Quality: false,
        Efficiency: false
    });
    const [statPriority, setStatPriority] = useState(savedState?.statPriority ?? {
        Performance: 1,
        Quality: 1,
        Efficiency: 1
    });

    const [board, setBoard] = useState<(InventoryItem | 'Locked' | null)[][]>(() => initializeBoard(savedState?.tier ?? defaultTier, savedState?.boardIds, inventory, isEvaporator));
    const boardRef = useRef(board);
    const setBoardSync = (newBoard: any) => {
        boardRef.current = newBoard;
        setBoard(newBoard);
    };

    const [isInitializedFromSave, setIsInitializedFromSave] = useState(false);

    useEffect(() => {
        if (!isInitializedFromSave && inventory.length > 0 && savedState?.boardIds) {
            const initialized = initializeBoard(tier, savedState.boardIds, inventory, isEvaporator);
            setBoardSync(initialized);
            setIsInitializedFromSave(true);
        }
    }, [inventory, tier, savedState, isInitializedFromSave, isEvaporator]);

    const [bestTotals, setBestTotals] = useState<Stats>({Performance: 0, Quality: 0, Efficiency: 0});
    const [bestPieceStats, setBestPieceStats] = useState(new Map());

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
        setBoardSync(initializeBoard(newTier, undefined, undefined, isEvaporator));
        setBestTotals({Performance: 0, Quality: 0, Efficiency: 0});
        setBestPieceStats(new Map());
        setWarningMsg(null);
        setSolutionCode('');
    };

    const updateMachineType = (newType: string) => {
        setMachineType(newType);
        localStorage.setItem(`optimizer_machine_type_${machineId}`, newType);
        const nextIsEvaporator = isEvaporatorMachine(newType);
        if (nextIsEvaporator !== isEvaporator) {
            setBoardSync(initializeBoard(tier, undefined, undefined, nextIsEvaporator));
            setBestTotals({Performance: 0, Quality: 0, Efficiency: 0});
            setBestPieceStats(new Map());
            setWarningMsg(null);
            setSolutionCode('');
            return;
        }
        if (newType === machineType) return;
        const removedNames = new Set<string>();
        const nextBoard = boardRef.current.map(row => row.map(cell => {
            if (cell && cell !== 'Locked' && !cell.isStuck && !isModuleAllowedInMachine(cell, newType)) {
                removedNames.add(cell.displayName);
                return null;
            }
            return cell;
        }));
        if (removedNames.size > 0) {
            setBoardSync(nextBoard);
            setWarningMsg(`Removed ${[...removedNames].join(', ')}: incompatible with ${getMachineTypeName(newType)}.`);
        }
    };

    const resetBoard = () => {
        if (isSolving) {
            isSolvingRef.current = false;
            setIsSolving(false);
        }
        setBoardSync(initializeBoard(tier, undefined, undefined, isEvaporator));
        setBestTotals({Performance: 0, Quality: 0, Efficiency: 0});
        setBestPieceStats(new Map());
        setWarningMsg(null);
        setSolutionCode('');
    };

    const stopOptimization = () => {
        isSolvingRef.current = false;
        setIsSolving(false);
    };

    const isModuleAllowed = (item: InventoryItem): boolean => isModuleAllowedInMachine(item, machineType);

    const checkModuleAllowed = (item: InventoryItem): boolean => {
        if (isModuleAllowed(item)) return true;
        setWarningMsg(`Cannot place ${item.displayName}: Incompatible with ${machineType ? getMachineTypeName(machineType) : 'this machine'}.`);
        return false;
    };

    const manuallyPlaceItem = (item: InventoryItem, rootX: number, rootY: number, offsets: Point[]) => {
        if (!isModuleAllowed(item)) {
            setWarningMsg(`Cannot place ${item.displayName}: Incompatible with ${machineType || 'this machine'}.`);
            return;
        }
        setWarningMsg(null);
        const next = boardRef.current.map(row => [...row]);
        let swapItemIds = new Set<string>();

        const rows = next.length;
        const cols = next[0]?.length || 7;

        for (const pt of offsets) {
            const px = rootX + pt.x;
            const py = rootY + pt.y;
            if (px >= 0 && px < cols && py >= 0 && py < rows) {
                const cell = next[py][px];
                if (cell && cell !== 'Locked' && cell.id !== item.id) {
                    if (cell.shape === item.shape) swapItemIds.add(cell.id);
                }
            }
        }

        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
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
            if (px >= 0 && px < cols && py >= 0 && py < rows) {
                next[py][px] = item;
            }
        }
        setBoardSync(next);
    };

    const manuallyRemoveItem = (itemId: string) => {
        const next = boardRef.current.map(row => [...row]);
        const rows = next.length;
        const cols = next[0]?.length || 7;
        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
                const cell = next[y][x];
                if (cell && cell !== 'Locked' && cell.id === itemId) {
                    if (cell.isStuck) {
                        setWarningMsg("Cannot remove stuck module.");
                        return;
                    }
                    next[y][x] = null;
                }
            }
        }
        setBoardSync(next);
    };

    const isValidPlacement = (item: InventoryItem, rootX: number, rootY: number, offsets: Point[]) => {
        if (!isModuleAllowed(item)) return false;
        const rows = boardRef.current.length;
        const cols = boardRef.current[0]?.length || 7;
        for (const pt of offsets) {
            const px = rootX + pt.x;
            const py = rootY + pt.y;
            if (px < 0 || px >= cols || py < 0 || py >= rows) return false;
            const cell = boardRef.current[py][px];
            if (cell === 'Locked') return false;
            if (cell && cell.id !== item.id) return false;
        }
        return true;
    };

    const importSolution = (code: string) => {
        try {
            const reader = new BitReader(code);
            const header = reader.read(2);
            let formatVersion = 0;
            let codeIsEvaporator = false;
            let decodedTier = header as GridTier;
            if (header === 0) {
                formatVersion = reader.read(4);
                if (formatVersion !== CODE_FORMAT_VERSION) throw new Error('Unsupported code version');
                codeIsEvaporator = reader.read(1) === 1;
                decodedTier = reader.read(2) as GridTier;
            }
            if (codeIsEvaporator !== isEvaporator) {
                setWarningMsg(codeIsEvaporator
                    ? 'This solution code was made for an Evaporator (4x4 grid). Select an Evaporator machine to import it.'
                    : 'This solution code was made for a standard (7x5 grid) machine and cannot be imported into an Evaporator.');
                return;
            }
            const maxP = reader.read(1) === 1;
            const maxQ = reader.read(1) === 1;
            const maxE = reader.read(1) === 1;
            const importedMax = {Performance: maxP, Quality: maxQ, Efficiency: maxE};

            const readTarget = () => {
                const hasTarget = reader.read(1) === 1;
                return hasTarget ? reader.read(12) - 2048 : null;
            };

            const importedTargets = {Performance: readTarget(), Quality: readTarget(), Efficiency: readTarget()};

            const newInventory: InventoryItem[] = [];
            const newBoard: (InventoryItem | 'Locked' | null)[][] = initializeBoard(decodedTier, undefined, undefined, isEvaporator);
            const numModules = reader.read(8);
            const cols = newBoard[0]?.length || 7;

            for (let i = 0; i < numModules; i++) {
                let shape: ModuleShape;
                let color: ModuleColor;
                let specialDisplayName: string | null = null;
                if (formatVersion >= 1 && reader.read(1) === 1) {
                    const specialName = SPECIAL_MODULE_IDS[reader.read(6)];
                    const specialTemplate = MODULE_TEMPLATES.find(m => m.displayName === specialName);
                    if (!specialTemplate) throw new Error('Unknown special module');
                    shape = specialTemplate.shape;
                    color = specialTemplate.color;
                    specialDisplayName = specialTemplate.displayName;
                } else {
                    shape = SHAPE_MAP[reader.read(4)];
                    color = COLOR_MAP_KEYS[reader.read(formatVersion >= 1 ? 4 : 3)];
                }
                if (shape === 'Node1x2' && color !== 'White') shape = 'Line1x2';

                const posCount = reader.read(3);
                const positions: number[] = [];
                for (let p = 0; p < posCount; p++) positions.push(reader.read(6));

                const isLockedFlag = formatVersion >= 1 && reader.read(1) === 1;
                const isStuckFlag = formatVersion >= 1 && reader.read(1) === 1;

                const template = {displayName: specialDisplayName ?? (color === 'White' ? 'Node' : (MODULE_TEMPLATES.find(m => m.shape === shape && m.color === color)?.displayName ?? 'Unknown Module'))};
                const reconstructedEffects: [ItemEffect, ItemEffect] = ['None', 'None'];
                const base = getBaseStats({shape, color, displayName: template.displayName} as any);
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

                const newItem: InventoryItem = {
                    id: `${shape}_${color}_${Math.random().toString(36).substring(2, 8)}`,
                    shape,
                    color,
                    displayName: template.displayName,
                    effects: reconstructedEffects,
                    effectValues: reconstructedValues, ...(isLockedFlag ? {isLocked: true} : {}), ...(isStuckFlag ? {isStuck: true} : {})
                };
                newInventory.push(newItem);
                positions.forEach((pos: number) => newBoard[Math.floor(pos / cols)][pos % cols] = newItem);
            }

            if (machineType) {
                const incompatible = new Set<string>();
                newBoard.forEach(row => row.forEach(cell => {
                    if (cell && cell !== 'Locked' && !isModuleAllowedInMachine(cell, machineType)) incompatible.add(cell.displayName);
                }));
                if (incompatible.size > 0) {
                    setWarningMsg(`This solution contains modules that cannot be placed in ${getMachineTypeName(machineType)}: ${[...incompatible].join(', ')}.`);
                    return;
                }
            }

            setTier(decodedTier);
            setMaximizeStats(importedMax);
            setTargetStats(importedTargets);
            setIsInitializedFromSave(true);
            setInventory(newInventory);
            setBoardSync(newBoard);
            setSolutionCode(code);
            setWarningMsg(null);

            const {totals, pieceStats} = calculateBoardStats(newBoard, newInventory);
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
            const {
                totals,
                pieceStats
            } = calculateBoardStats(boardToCalculate, availableInventory, indexInventoryById(availableInventory));

            setBestTotals(totals);
            setBestPieceStats(new Map(pieceStats));
            if (boardChanged) setBoardSync(newBoard);

            const boardIds = boardToCalculate.map(row => row.map(c => c && c !== 'Locked' ? c.id : c));
            localStorage.setItem(`optimizer_machine_${machineId}`, JSON.stringify({
                tier, maximizeStats, targetStats, ignoreStats, statPriority, boardIds
            }));

            if (inventory.length > 0) {
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

                if (newCode && !isEvaporator) {
                    if (totals.Performance !== 0 || totals.Quality !== 0 || totals.Efficiency !== 0) {
                        const timer = setTimeout(() => saveToDatabase(tier, totals, newCode, availableForCode), 30000);
                        return () => clearTimeout(timer);
                    }
                }
            } else {
                setSolutionCode('');
            }
        }
    }, [inventory, tier, maximizeStats, targetStats, ignoreStats, statPriority, machineId, getUsedItems, board, isSolving, isExternallySolving, isEvaporator]);

    const runOptimization = async () => {
        if (isSolving) {
            isSolvingRef.current = false;
            return;
        }

        const fullInventoryForMachine = getInventoryForCode();
        const usedByOthers = getUsedItems(machineId);

        const solverPool = inventory.filter(i => !i.isLocked && !i.isStuck && !usedByOthers.has(i.id));

        let boardHasMovablePieces = false;
        boardRef.current.forEach(row => row.forEach(cell => {
            if (cell && cell !== 'Locked' && !cell.isStuck) boardHasMovablePieces = true;
        }));

        if (solverPool.length === 0 && !boardHasMovablePieces) {
            setWarningMsg(`Cannot optimize: No unused modules available.`);
            return;
        }

        const engineInventory = inventory.map(item =>
            (usedByOthers.has(item.id) || item.isStuck) ? {...item, isLocked: true} : item
        );

        setSolutionCode('');
        setWarningMsg(null);
        setIsSolving(true);
        isSolvingRef.current = true;

        const config = {id: machineId, tier, targetStats, maximizeStats, ignoreStats, statPriority, machineType};

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
        manuallyPlaceItem, manuallyRemoveItem, isValidPlacement, checkModuleAllowed, boardRef, applyUpdate,
        machineType, updateMachineType, isEvaporator
    };
}