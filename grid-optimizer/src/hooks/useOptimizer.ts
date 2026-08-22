import { useState, useRef, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';
import type {GridTier, InventoryItem, Stats, TargetStats, Point, ModuleShape, ModuleColor, ItemEffect} from '../types';
import { getBaseStats, applyInternalEffects, PRECOMPUTED_OFFSETS, roundStat } from '../utils';
import { MODULE_TEMPLATES } from '../constants';
import { calculateBoardStats, calculateFitness, localSearch, isAlarm, isJunk, isBlast } from '../statEngine';

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

const generateCodeFromState = (
    currentTier: GridTier,
    maxStats: { Performance: boolean, Quality: boolean, Efficiency: boolean },
    tarStats: TargetStats,
    inv: InventoryItem[],
    brd: (InventoryItem | 'Locked' | null)[][]
) => {
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

export function initializeBoard(currentTier: GridTier) {
    const grid = Array.from({ length: 5 }, () => Array.from({ length: 7 }, () => null as any));
    if (currentTier === 1 || currentTier === 2) {
        grid[0][0] = grid[0][6] = grid[4][0] = grid[4][6] = 'Locked';
    }
    if (currentTier === 1) {
        grid[1][3] = grid[2][2] = grid[2][3] = grid[2][4] = grid[3][3] = 'Locked';
    }
    return grid;
}

export const evaluatePlacementDelta = (
    piece: InventoryItem,
    x: number, y: number,
    offsets: Point[],
    testBoard: (InventoryItem | 'Locked' | null)[][],
    isBoardEmpty: boolean,
    precomputedInternal: Map<string, Stats>,
    weightP: number, weightQ: number, weightE: number,
    inventory: InventoryItem[]
) => {
    let isConnected = false;
    let adjNodes = 0;
    let negFeedbackBonusP = 0, negFeedbackBonusQ = 0, negFeedbackBonusE = 0;
    let negativeContactCount = 0;

    const internal = precomputedInternal.get(piece.id)!;
    let p = internal.Performance;
    let q = internal.Quality;
    let e = internal.Efficiency;

    const hasSideMount = piece.effects.includes('Side Mount');
    const hasTopMount = piece.effects.includes('Top Mount');
    const hasReceiver = piece.effects.includes('Receiver');
    const nfCount = piece.effects.filter(eff => eff === 'Negative Feedback').length;
    const isPureNegative = p <= 0 && q <= 0 && e <= 0 && (p < 0 || q < 0 || e < 0);

    let multiplier = 0;
    const pieceMinX = x + Math.min(...offsets.map(pt => pt.x));
    const pieceMinY = y + Math.min(...offsets.map(pt => pt.y));

    if (hasSideMount && pieceMinX === 0) multiplier += 0.20;
    if (hasTopMount && pieceMinY === 0) multiplier += 0.20;

    const neighborIds = new Set<string>();

    for (const pt of offsets) {
        const px = x + pt.x;
        const py = y + pt.y;

        if (px < 0 || px >= 7 || py < 0 || py >= 5 || testBoard[py][px] !== null) {
            return -Infinity;
        }
        if (px === 0 || px === 6 || py === 0 || py === 4) isConnected = true;

        const neighbors = [ {nx: px, ny: py - 1}, {nx: px, ny: py + 1}, {nx: px - 1, ny: py}, {nx: px + 1, ny: py} ];
        for (const {nx, ny} of neighbors) {
            if (nx >= 0 && nx < 7 && ny >= 0 && ny < 5) {
                const adjCell = testBoard[ny][nx];
                if (adjCell && adjCell !== 'Locked') {
                    isConnected = true;
                    neighborIds.add((adjCell as InventoryItem).id);

                    if (piece.color === 'White') {
                        if (adjCell.color !== 'White') {
                            const adjInt = precomputedInternal.get((adjCell as InventoryItem).id)!;
                            if (adjInt.Performance <= 0 && adjInt.Quality <= 0 && adjInt.Efficiency <= 0 && (adjInt.Performance < 0 || adjInt.Quality < 0 || adjInt.Efficiency < 0)) {
                                negativeContactCount++;
                            }
                        }
                    } else if (isPureNegative && adjCell.color === 'White') {
                        negativeContactCount++;
                    }
                }
            }
        }
    }

    if (!isConnected && !isBoardEmpty) return -10000;

    let nodeBonusScore = 0;

    neighborIds.forEach(adjId => {
        const adjPiece = inventory.find(i => i.id === adjId);
        if (!adjPiece) return;

        if (piece.color !== 'White' && adjPiece.color === 'White') {
            adjNodes++;
            nodeBonusScore += roundStat(internal.Performance * 0.20) * weightP;
            nodeBonusScore += roundStat(internal.Quality * 0.20) * weightQ;
            nodeBonusScore += roundStat(internal.Efficiency * 0.20) * weightE;
        } else if (piece.color === 'White' && adjPiece.color !== 'White') {
            const adjInternal = precomputedInternal.get(adjId)!;
            nodeBonusScore += roundStat(adjInternal.Performance * 0.20) * weightP;
            nodeBonusScore += roundStat(adjInternal.Quality * 0.20) * weightQ;
            nodeBonusScore += roundStat(adjInternal.Efficiency * 0.20) * weightE;
        }

        if (nfCount > 0 && adjPiece.color !== 'White') {
            const adjInternal = precomputedInternal.get(adjId)!;
            if (adjInternal.Performance < 0) negFeedbackBonusP += roundStat(nfCount * 0.25 * adjInternal.Performance);
            if (adjInternal.Quality < 0) negFeedbackBonusQ += roundStat(nfCount * 0.25 * adjInternal.Quality);
            if (adjInternal.Efficiency < 0) negFeedbackBonusE += roundStat(nfCount * 0.25 * adjInternal.Efficiency);
        }
    });

    if (hasReceiver) multiplier += (0.10 * adjNodes);

    if (multiplier > 0) {
        p = roundStat(p * (1 + multiplier));
        q = roundStat(q * (1 + multiplier));
        e = roundStat(e * (1 + multiplier));
    }

    p += negFeedbackBonusP;
    q += negFeedbackBonusQ;
    e += negFeedbackBonusE;

    const statScore = (p * weightP) + (q * weightQ) + (e * weightE) + nodeBonusScore;
    return statScore + (adjNodes * 0.05) - (negativeContactCount * 1000);
};

export type MachineConfig = {
    id: string;
    tier: GridTier;
    targetStats: TargetStats;
    maximizeStats: any;
};

// Beam search: each machine gets its own K independent search agents whose boards/temperatures/
// best-scores must persist across round-robin turns (a "turn" only advances ONE agent of ONE
// machine at a time, unlike the old per-machine while-loop where all K agents advanced together
// on every tick).
const BEAM_SIZE = 4;
const T0 = 50;        // initial simulated-annealing temperature
const DECAY = 0.985;  // per-turn cooling rate
const STAGNATION_LIMIT = 75;

type BeamState = {
    boards: (InventoryItem | 'Locked' | null)[][][];
    temperatures: number[];
    bestScores: number[];
    stagnation: number;
    cursor: number;
};

export const runOptimizationEngine = async (
    machines: MachineConfig[],
    initialBoards: any[][][],
    inventory: InventoryItem[],
    isSolvingRef: { current: boolean },
    onUpdate: (updates: Map<string, { board: any[][], totals: Stats, pieceStats: Map<string, Stats>, code: string }>) => void
) => {
    const precomputedInternal = new Map<string, Stats>();
    inventory.forEach(item => precomputedInternal.set(item.id, applyInternalEffects(item)));

    // Computed once from the FULL shared inventory (not any one machine's unclaimed slice) so a
    // machine that starts after another has claimed all stat-bearing items doesn't permanently
    // lock into pure packing-score mode.
    const hasAnyPositiveStats = inventory.some(item => {
        const modified = applyInternalEffects(item);
        return roundStat(modified.Performance) > 0 || roundStat(modified.Quality) > 0 || roundStat(modified.Efficiency) > 0;
    });

    let globalBestScore = -Infinity;
    let currentBoards = initialBoards.map(b => b.map(row => [...row]));
    let currentTotals = currentBoards.map(b => calculateBoardStats(b, inventory).totals);

    const baseWeights = machines.map(m => {
        let wp = m.maximizeStats.Performance ? 10 : 0.1;
        let wq = m.maximizeStats.Quality ? 10 : 0.1;
        let we = m.maximizeStats.Efficiency ? 10 : 0.1;
        if (m.targetStats.Performance !== null) wp += 15;
        if (m.targetStats.Quality !== null) wq += 15;
        if (m.targetStats.Efficiency !== null) we += 15;
        return { wp, wq, we };
    });

    const beamStates: BeamState[] = machines.map((m) => ({
        boards: new Array(BEAM_SIZE).fill(null).map(() => initializeBoard(m.tier)),
        temperatures: new Array(BEAM_SIZE).fill(T0),
        bestScores: new Array(BEAM_SIZE).fill(-Infinity),
        stagnation: 0,
        cursor: 0,
    }));

    while (isSolvingRef.current) {
        let testBoards = currentBoards.map(b => b.map(row => [...row]));

        // pick one random machine to optimize this turn
        const targetMIdx = Math.floor(Math.random() * machines.length);
        const targetConfig = machines[targetMIdx];
        const state = beamStates[targetMIdx];

        // items already committed to OTHER machines' boards are off-limits to this turn's beam agent
        const usedByOthers = new Set<string>();
        for (let mIdx = 0; mIdx < machines.length; mIdx++) {
            if (mIdx === targetMIdx) continue;
            for (let y = 0; y < 5; y++) {
                for (let x = 0; x < 7; x++) {
                    const cell = testBoards[mIdx][y][x];
                    if (cell && cell !== 'Locked') usedByOthers.add(cell.id);
                }
            }
        }

        // dynamic heuristic weight adjustment if stats% are behind other machines
        let dynWp = baseWeights[targetMIdx].wp;
        let dynWq = baseWeights[targetMIdx].wq;
        let dynWe = baseWeights[targetMIdx].we;
        if (machines.length > 1) {
            if (targetConfig.maximizeStats.Performance && targetConfig.targetStats.Performance === null) {
                const avgP = currentTotals.reduce((s, t) => s + t.Performance, 0) / machines.length;
                if (currentTotals[targetMIdx].Performance < avgP) dynWp *= 2.0;
            }
            if (targetConfig.maximizeStats.Quality && targetConfig.targetStats.Quality === null) {
                const avgQ = currentTotals.reduce((s, t) => s + t.Quality, 0) / machines.length;
                if (currentTotals[targetMIdx].Quality < avgQ) dynWq *= 2.0;
            }
            if (targetConfig.maximizeStats.Efficiency && targetConfig.targetStats.Efficiency === null) {
                const avgE = currentTotals.reduce((s, t) => s + t.Efficiency, 0) / machines.length;
                if (currentTotals[targetMIdx].Efficiency < avgE) dynWe *= 2.0;
            }
        }

        // 1. Pull this beam agent's persisted board, dropping anything claimed by another machine meanwhile
        const beamIdx = state.cursor;
        state.cursor = (state.cursor + 1) % BEAM_SIZE;

        let beamBoard = state.boards[beamIdx].map(row => [...row]);
        const placedOnBeam = new Set<string>();
        let beamBoardEmpty = true;
        for (let y = 0; y < 5; y++) {
            for (let x = 0; x < 7; x++) {
                const cell = beamBoard[y][x];
                if (cell && cell !== 'Locked') {
                    if (usedByOthers.has(cell.id)) {
                        beamBoard[y][x] = null;
                    } else {
                        placedOnBeam.add(cell.id);
                        beamBoardEmpty = false;
                    }
                }
            }
        }

        // 2. Targeted mutation: remove the worst-scoring pieces first (not a blind random restart)
        const isStagnant = state.stagnation >= STAGNATION_LIMIT;
        if (placedOnBeam.size > 0) {
            const { pieceStats } = calculateBoardStats(beamBoard, inventory);
            const scoredIds = Array.from(placedOnBeam).sort((a, b) => {
                const sa = pieceStats.get(a);
                const sb = pieceStats.get(b);
                const scoreA = sa ? sa.Performance * dynWp + sa.Quality * dynWq + sa.Efficiency * dynWe : 0;
                const scoreB = sb ? sb.Performance * dynWp + sb.Quality * dynWq + sb.Efficiency * dynWe : 0;
                return scoreA - scoreB; // worst first
            });

            let removeCount;
            if (isStagnant) {
                removeCount = Math.max(1, Math.floor(scoredIds.length * (0.5 + Math.random() * 0.4)));
                state.stagnation = 0;
            } else {
                removeCount = Math.floor(Math.random() * Math.min(3, scoredIds.length)) + 1;
            }

            const toRemove = new Set(scoredIds.slice(0, removeCount));
            for (let y = 0; y < 5; y++) {
                for (let x = 0; x < 7; x++) {
                    const cell = beamBoard[y][x];
                    if (cell && cell !== 'Locked' && toRemove.has(cell.id)) beamBoard[y][x] = null;
                }
            }
            toRemove.forEach(id => placedOnBeam.delete(id));
        }

        let boardHasJunk = false;
        let boardHasBlast = false;
        placedOnBeam.forEach(id => {
            const p = inventory.find(i => i.id === id);
            if (p) {
                if (isJunk(p)) boardHasJunk = true;
                if (isBlast(p)) boardHasBlast = true;
            }
        });

        const rawPool = inventory.filter(inv => !usedByOthers.has(inv.id) && !placedOnBeam.has(inv.id));
        const poolAlarms = rawPool.filter(isAlarm);
        const poolJunks = rawPool.filter(isJunk);
        const poolBlasts = rawPool.filter(isBlast);
        const poolOthers = rawPool.filter(p => !isAlarm(p) && !isJunk(p) && !isBlast(p));

        const mandatoryThisTurn: InventoryItem[] = [...poolAlarms];
        const fillerThisTurn: InventoryItem[] = [];
        const mandatoryIds = new Set<string>();

        if (!boardHasJunk && poolJunks.length > 0) {
            const shuffled = [...poolJunks].sort(() => Math.random() - 0.5);
            mandatoryThisTurn.push(shuffled.shift()!);
            fillerThisTurn.push(...shuffled);
        } else {
            fillerThisTurn.push(...poolJunks);
        }

        if (!boardHasBlast && poolBlasts.length > 0) {
            const shuffled = [...poolBlasts].sort(() => Math.random() - 0.5);
            mandatoryThisTurn.push(shuffled.shift()!);
            fillerThisTurn.push(...shuffled);
        } else {
            fillerThisTurn.push(...poolBlasts);
        }

        mandatoryThisTurn.forEach(p => mandatoryIds.add(p.id));

        let itemsToPlace = [
            ...mandatoryThisTurn.sort(() => Math.random() - 0.5),
            ...poolOthers.sort(() => Math.random() - 0.5),
            ...fillerThisTurn.sort(() => Math.random() - 0.5)
        ];

        beamBoardEmpty = true;
        findNonEmpty: for (let y = 0; y < 5; y++) {
            for (let x = 0; x < 7; x++) {
                if (beamBoard[y][x] && beamBoard[y][x] !== 'Locked') { beamBoardEmpty = false; break findNonEmpty; }
            }
        }

        // 3. Constraint-aware ordering: place the most constrained pieces first (fewer valid spots = higher priority)
        itemsToPlace = itemsToPlace.slice().sort((a, b) => {
            const countValid = (piece: InventoryItem) => {
                const pieceOrientations = PRECOMPUTED_OFFSETS.get(piece.shape) || [];
                let valid = 0;
                for (const offs of pieceOrientations) {
                    for (let y = 0; y < 5 && valid < 16; y++) {
                        for (let x = 0; x < 7 && valid < 16; x++) {
                            if (evaluatePlacementDelta(piece, x, y, offs, beamBoard, beamBoardEmpty, precomputedInternal, dynWp, dynWq, dynWe, inventory) !== -Infinity) valid++;
                        }
                    }
                }
                return valid;
            };
            return countValid(a) - countValid(b);
        });

        // 4. Greedy placement (top-3 randomized among the best heuristic spots)
        for (const piece of itemsToPlace) {
            const isFiller = (isJunk(piece) || isBlast(piece)) && !mandatoryIds.has(piece.id);
            const orientations = PRECOMPUTED_OFFSETS.get(piece.shape) || [];
            const validPlacements: { x: number, y: number, offsets: Point[], heuristicScore: number }[] = [];

            for (const offsets of orientations) {
                for (let y = 0; y < 5; y++) {
                    for (let x = 0; x < 7; x++) {
                        const deltaScore = evaluatePlacementDelta(piece, x, y, offsets, beamBoard, beamBoardEmpty, precomputedInternal, dynWp, dynWq, dynWe, inventory);
                        if (deltaScore !== -Infinity) {
                            if (isFiller && deltaScore < 0) continue;
                            validPlacements.push({ x, y, offsets, heuristicScore: deltaScore });
                        }
                    }
                }
            }

            if (validPlacements.length > 0) {
                validPlacements.sort((a, b) => b.heuristicScore - a.heuristicScore);
                const topN = Math.min(3, validPlacements.length);
                const picked = validPlacements[Math.floor(Math.random() * topN)];
                for (const pt of picked.offsets) beamBoard[picked.y + pt.y][picked.x + pt.x] = piece;
                beamBoardEmpty = false;
            }
        }

        // 5. Local search polish
        const targetAlarmCount = inventory.filter(isAlarm).filter(i => !usedByOthers.has(i.id)).length;
        const targetJunkCount = (boardHasJunk || rawPool.some(isJunk)) ? 1 : 0;
        const targetBlastCount = (boardHasBlast || rawPool.some(isBlast)) ? 1 : 0;

        const lsResult = localSearch(beamBoard, inventory, targetConfig.maximizeStats, targetConfig.targetStats, targetAlarmCount, targetJunkCount, targetBlastCount, 100);
        beamBoard = lsResult.board;

        // 6. Score this beam agent's candidate and apply the simulated-annealing acceptance rule —
        // this only gates what the NEXT turn for this beam agent explores from; it is independent
        // of whether the candidate gets committed/broadcast (that's the cross-machine gate below).
        const beamBoardResult = calculateBoardStats(beamBoard, inventory);
        const beamFitness = calculateFitness(
            beamBoardResult.totals, beamBoardResult.placedPiecesCount, beamBoardResult.placedAlarmsCount,
            beamBoardResult.placedJunkCount, beamBoardResult.placedBlastCount,
            hasAnyPositiveStats, targetConfig.maximizeStats, targetConfig.targetStats,
            targetAlarmCount, targetJunkCount, targetBlastCount
        ).score;

        const delta = beamFitness - state.bestScores[beamIdx];
        if (delta > 0 || Math.random() < Math.exp(delta / state.temperatures[beamIdx])) {
            state.bestScores[beamIdx] = beamFitness;
            state.boards[beamIdx] = beamBoard.map(row => [...row]);
            state.temperatures[beamIdx] = delta > 0 ? T0 : state.temperatures[beamIdx] * DECAY;
        } else {
            state.temperatures[beamIdx] *= DECAY;
            state.stagnation++;
        }

        // Every BEAM_SIZE turns for this machine, prune its worst-performing agent so it restarts fresh
        if (beamIdx === BEAM_SIZE - 1) {
            let worst = 0;
            for (let b = 1; b < BEAM_SIZE; b++) {
                if (state.bestScores[b] < state.bestScores[worst]) worst = b;
            }
            state.boards[worst] = initializeBoard(targetConfig.tier);
            state.temperatures[worst] = T0;
            state.bestScores[worst] = -Infinity;
        }

        testBoards[targetMIdx] = beamBoard;

        let currentScore = 0;
        const machineTotals: Stats[] = [];
        const machinePieceStats: Map<string, Stats>[] = [];
        let totalPiecesPlaced = 0;

        for (let mIdx = 0; mIdx < machines.length; mIdx++) {
            const stats = calculateBoardStats(testBoards[mIdx], inventory);
            machineTotals.push(stats.totals);
            machinePieceStats.push(stats.pieceStats);
            totalPiecesPlaced += stats.placedPiecesCount;

            const m = machines[mIdx];
            const t = stats.totals;

            if (m.targetStats.Performance !== null && t.Performance < m.targetStats.Performance) currentScore -= (m.targetStats.Performance - t.Performance) * 10000;
            if (m.targetStats.Quality !== null && t.Quality < m.targetStats.Quality) currentScore -= (m.targetStats.Quality - t.Quality) * 10000;
            if (m.targetStats.Efficiency !== null && t.Efficiency < m.targetStats.Efficiency) currentScore -= (m.targetStats.Efficiency - t.Efficiency) * 10000;

            if (m.maximizeStats.Performance) currentScore += (t.Performance * 10);
            if (m.maximizeStats.Quality) currentScore += (t.Quality * 10);
            if (m.maximizeStats.Efficiency) currentScore += (t.Efficiency * 10);
        }

        // density reward
        currentScore += totalPiecesPlaced * 5;

        if (machines.length > 1) {
            ['Performance', 'Quality', 'Efficiency'].forEach((statKey) => {
                const key = statKey as keyof Stats;
                const balancers = machines.map((m, idx) => ({ m, t: machineTotals[idx][key] }))
                    .filter(obj => obj.m.maximizeStats[key] && obj.m.targetStats[key] === null);

                if (balancers.length > 1) {
                    const avg = balancers.reduce((sum, obj) => sum + obj.t, 0) / balancers.length;
                    const mad = balancers.reduce((sum, obj) => sum + Math.abs(obj.t - avg), 0) / balancers.length;
                    currentScore -= (mad * 50);
                }
            });
        }

        if (!isSolvingRef.current) break;

        if (currentScore > globalBestScore) {
            globalBestScore = currentScore;
            currentBoards = testBoards.map(b => b.map(row => [...row]));
            currentTotals = machineTotals;

            const updates = new Map();
            for (let mIdx = 0; mIdx < machines.length; mIdx++) {
                const m = machines[mIdx];

                const placedOnOtherMachines = new Set<string>();
                for (let otherIdx = 0; otherIdx < machines.length; otherIdx++) {
                    if (otherIdx !== mIdx) {
                        for (let y = 0; y < 5; y++) {
                            for (let x = 0; x < 7; x++) {
                                const cell = testBoards[otherIdx][y][x];
                                if (cell && cell !== 'Locked') placedOnOtherMachines.add(cell.id);
                            }
                        }
                    }
                }
                const inventoryForCode = inventory.filter(item => !placedOnOtherMachines.has(item.id));

                const finalCode = generateCodeFromState(m.tier, m.maximizeStats, m.targetStats, inventoryForCode, testBoards[mIdx]);
                updates.set(m.id, {
                    board: testBoards[mIdx].map(row => [...row]),
                    totals: machineTotals[mIdx],
                    pieceStats: machinePieceStats[mIdx],
                    code: finalCode
                });
            }
            onUpdate(updates);
            state.stagnation = 0;
        } else if (currentScore === globalBestScore && Math.random() > 0.5) {
            currentBoards = testBoards.map(b => b.map(row => [...row]));
            currentTotals = machineTotals;
        }

        await new Promise(resolve => setTimeout(resolve, 0));
    }
};

export function useOptimizer(
    inventory: InventoryItem[],
    setInventory: React.Dispatch<React.SetStateAction<InventoryItem[]>>,
    machineId: string,
    getUsedItems: (excludeId: string) => Set<string>,
    initialTier: GridTier = 3,
    initialMax = { Performance: false, Quality: false, Efficiency: false },
    initialTarget: TargetStats = { Performance: null, Quality: null, Efficiency: null }
) {
    const [tier, setTier] = useState<GridTier>(initialTier);
    const [targetStats, setTargetStats] = useState<TargetStats>(initialTarget);
    const [maximizeStats, setMaximizeStats] = useState(initialMax);

    const [board, setBoard] = useState<(InventoryItem | 'Locked' | null)[][]>(() => initializeBoard(initialTier));
    const boardRef = useRef(board);
    const setBoardSync = (newBoard: any) => {
        boardRef.current = newBoard;
        setBoard(newBoard);
    };

    const [bestTotals, setBestTotals] = useState<Stats>({ Performance: 0, Quality: 0, Efficiency: 0 });
    const [bestPieceStats, setBestPieceStats] = useState<Map<string, Stats>>(new Map());

    const [isSolving, setIsSolving] = useState(false);
    const [warningMsg, setWarningMsg] = useState<string | null>(null);
    const [solutionCode, setSolutionCode] = useState<string>('');
    const isSolvingRef = useRef(false);

    const getAvailableInventory = () => {
        if (!getUsedItems || !machineId) return inventory;
        const used = getUsedItems(machineId);
        return inventory.filter(item => !used.has(item.id));
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
        setTargetStats({ Performance: null, Quality: null, Efficiency: null });
        setMaximizeStats({ Performance: false, Quality: false, Efficiency: false });
        setSolutionCode('');
    };

    const stopOptimization = () => {
        isSolvingRef.current = false;
        setIsSolving(false);
    };

    const manuallyPlaceItem = (item: InventoryItem, rootX: number, rootY: number, offsets: Point[]) => {
        const next = boardRef.current.map(row => [...row]);
        const swapItemIds = new Set<string>();

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
        if (!isSolvingRef.current) {
            let boardChanged = false;
            const newBoard = boardRef.current.map(row => row.map(cell => {
                if (cell && cell !== 'Locked') {
                    const invMatch = inventory.find(i => i.id === cell.id);
                    if (invMatch && invMatch !== cell) {
                        boardChanged = true;
                        return invMatch;
                    }
                }
                return cell;
            }));

            const boardToCalculate = boardChanged ? newBoard : boardRef.current;
            const { totals, pieceStats } = calculateBoardStats(boardToCalculate, getAvailableInventory());

            setBestTotals(totals);
            setBestPieceStats(new Map(pieceStats));
            if (boardChanged) setBoardSync(newBoard);

            if (inventory.length > 0) {
                const availableForCode = getAvailableInventory();
                const newCode = generateCodeFromState(tier, maximizeStats, targetStats, availableForCode, boardToCalculate);
                setSolutionCode(newCode);
                const timer = setTimeout(() => saveToDatabase(tier, totals, newCode, availableForCode), 60000);
                return () => clearTimeout(timer);
            } else {
                setSolutionCode('');
            }
        }
    }, [inventory, tier, maximizeStats, targetStats, machineId, getUsedItems, board]);

    const runOptimization = async () => {
        if (isSolving) {
            isSolvingRef.current = false;
            return;
        }

        const availableInventory = getAvailableInventory();
        if (availableInventory.length === 0) {
            setWarningMsg(`Cannot optimize: No unused modules available.`);
            return;
        }

        setSolutionCode('');
        setWarningMsg(null);
        setIsSolving(true);
        isSolvingRef.current = true;

        const config = { id: machineId, tier, targetStats, maximizeStats };

        await runOptimizationEngine([config], [boardRef.current], availableInventory, isSolvingRef, (updates) => {
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
        maximizeStats, setMaximizeStats, board, bestTotals, bestPieceStats,
        isSolving, stopOptimization, warningMsg, setWarningMsg,
        solutionCode, setSolutionCode, importSolution, runOptimization, resetBoard,
        manuallyPlaceItem, manuallyRemoveItem, isValidPlacement, boardRef, applyUpdate
    };
}