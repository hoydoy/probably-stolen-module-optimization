// ──────────────────────────────────────────────────────────────────────
// Pure stat engine — no React, no closures, fully testable.
// Mirrors the logic in hooks/useOptimizer.ts:calculateBoardStats and runOptimizationEngine.
// ──────────────────────────────────────────────────────────────────────

import type { InventoryItem, Stats, Point } from './types';
import { applyInternalEffects, PRECOMPUTED_OFFSETS, roundStat } from './utils';

/** Result of calculateBoardStats — consumed by the optimizer loop. */
export interface BoardResult {
    totals: Stats;
    pieceStats: Map<string, Stats>;
    coveredNodeSides: number;
    negativeContactCount: number;
    placedPiecesCount: number;
    placedAlarmsCount: number;
    placedJunkCount: number;
    placedBlastCount: number;
}

/** Result of a fitness evaluation. */
export interface FitnessResult {
    score: number;
    placedPiecesCount: number;
    alarmsCount: number;
    junkCount: number;
    blastCount: number;
}

const offsets = [{ x: 0, y: -1 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 }];

/** Compute the total board stats for a given board layout. */
export function calculateBoardStats(
    currentBoard: (InventoryItem | 'Locked' | null)[][],
    currentInventory: InventoryItem[]
): BoardResult {
    const totals: Stats = { Performance: 0, Quality: 0, Efficiency: 0 };
    const pieceStats = new Map<string, Stats>();
    let coveredNodeSides = 0;
    let negativeContactCount = 0;
    let placedPiecesCount = 0;
    let placedAlarmsCount = 0;
    let placedJunkCount = 0;
    let placedBlastCount = 0;

    const placedPieces = new Map<string, { item: InventoryItem; minX: number; minY: number }>();
    const nodeAdjacencies = new Map<string, Set<string>>();
    const gridItemMap = new Map<string, InventoryItem>();

    for (let y = 0; y < 5; y++) {
        for (let x = 0; x < 7; x++) {
            const boardCell = currentBoard[y][x];
            if (boardCell && boardCell !== 'Locked') {
                const cell = currentInventory.find(i => i.id === boardCell.id) || boardCell;
                gridItemMap.set(`${x},${y}`, cell);

                if (!placedPieces.has(cell.id)) {
                    placedPieces.set(cell.id, { item: cell, minX: x, minY: y });
                    placedPiecesCount++;
                } else {
                    const p = placedPieces.get(cell.id)!;
                    if (x < p.minX) p.minX = x;
                    if (y < p.minY) p.minY = y;
                }

                if (cell.color === 'White') {
                    if (!nodeAdjacencies.has(cell.id)) nodeAdjacencies.set(cell.id, new Set());
                    offsets.forEach(off => {
                        const nx = x + off.x;
                        const ny = y + off.y;
                        if (nx >= 0 && nx < 7 && ny >= 0 && ny < 5) {
                            const adjBoardCell = currentBoard[ny][nx];
                            if (adjBoardCell && adjBoardCell !== 'Locked') {
                                const adj = currentInventory.find(i => i.id === adjBoardCell.id) || adjBoardCell;
                                if (adj.color !== 'White') {
                                    nodeAdjacencies.get(cell.id)!.add(adj.id);
                                    coveredNodeSides++;

                                    const adjModified = applyInternalEffects(adj);
                                    const isPureNegative =
                                        (roundStat(adjModified.Performance) <= 0 && roundStat(adjModified.Quality) <= 0 && roundStat(adjModified.Efficiency) <= 0) &&
                                        (roundStat(adjModified.Performance) < 0 || roundStat(adjModified.Quality) < 0 || roundStat(adjModified.Efficiency) < 0);

                                    if (isPureNegative) {
                                        negativeContactCount++;
                                    }
                                }
                            }
                        }
                    });
                }
            }
        }
    }

    const selfStats = new Map<string, Stats>();
    const absorptionStats = new Map<string, Stats>();
    placedPieces.forEach(({ item }) => {
        if (item.displayName.includes('Alarm Module')) placedAlarmsCount++;
        if (item.displayName.includes('Junk Processing')) placedJunkCount++;
        if (item.displayName.includes('Blast Module')) placedBlastCount++;

        if (item.color !== 'White') {
            selfStats.set(item.id, applyInternalEffects(item));

            const nfCount = item.effects.filter(e => e === 'Negative Feedback').length;
            let nfPerf = 0, nfQual = 0, nfEff = 0;
            if (nfCount > 0) {
                const adjacentNeighborIds = new Set<string>();

                gridItemMap.forEach((cellItem, coordStr) => {
                    if (cellItem.id === item.id) {
                        const [cx, cy] = coordStr.split(',').map(Number);
                        offsets.forEach(off => {
                            const nx = cx + off.x;
                            const ny = cy + off.y;
                            const neighborItem = gridItemMap.get(`${nx},${ny}`);
                            if (neighborItem && neighborItem.id !== item.id && neighborItem.color !== 'White') {
                                adjacentNeighborIds.add(neighborItem.id);
                            }
                        });
                    }
                });

                adjacentNeighborIds.forEach(neighborId => {
                    const neighborItem = Array.from(gridItemMap.values()).find(i => i.id === neighborId);
                    if (neighborItem) {
                        const neighborBase = applyInternalEffects(neighborItem);
                        if (neighborBase.Performance < 0) nfPerf += neighborBase.Performance;
                        if (neighborBase.Quality < 0) nfQual += neighborBase.Quality;
                        if (neighborBase.Efficiency < 0) nfEff += neighborBase.Efficiency;
                    }
                });
            }

            absorptionStats.set(item.id, {
                Performance: nfCount * 0.25 * nfPerf,
                Quality: nfCount * 0.25 * nfQual,
                Efficiency: nfCount * 0.25 * nfEff,
            });
        }
    });

    placedPieces.forEach(({ item, minX, minY }) => {
        if (item.color !== 'White') {
            let { Performance: p, Quality: q, Efficiency: e } = selfStats.get(item.id)!;

            let multiplier = 0;
            if (item.effects.includes('Side Mount') && minX === 0) multiplier += 0.20;
            if (item.effects.includes('Top Mount') && minY === 0) multiplier += 0.20;

            if (item.effects.includes('Receiver')) {
                let adjNodes = 0;
                nodeAdjacencies.forEach(adjSet => { if (adjSet.has(item.id)) adjNodes++; });
                multiplier += 0.10 * adjNodes;
            }

            if (multiplier > 0) {
                p = roundStat(p * (1 + multiplier));
                q = roundStat(q * (1 + multiplier));
                e = roundStat(e * (1 + multiplier));
            }

            const absorb = absorptionStats.get(item.id)!;
            p += absorb.Performance;
            q += absorb.Quality;
            e += absorb.Efficiency;

            const finalStats = {
                Performance: roundStat(p),
                Quality: roundStat(q),
                Efficiency: roundStat(e),
            };

            pieceStats.set(item.id, finalStats);
            totals.Performance += finalStats.Performance;
            totals.Quality += finalStats.Quality;
            totals.Efficiency += finalStats.Efficiency;
        }
    });

    nodeAdjacencies.forEach((adjIds, nodeId) => {
        let nodeP = 0, nodeQ = 0, nodeE = 0;

        adjIds.forEach(adjId => {
            const adjSelf = selfStats.get(adjId);
            if (adjSelf) {
                nodeP += adjSelf.Performance;
                nodeQ += adjSelf.Quality;
                nodeE += adjSelf.Efficiency;
            }
        });

        const nodeStat = {
            Performance: roundStat(nodeP * 0.20),
            Quality: roundStat(nodeQ * 0.20),
            Efficiency: roundStat(nodeE * 0.20),
        };

        pieceStats.set(nodeId, nodeStat);
        totals.Performance += nodeStat.Performance;
        totals.Quality += nodeStat.Quality;
        totals.Efficiency += nodeStat.Efficiency;
    });

    return { totals, pieceStats, coveredNodeSides, negativeContactCount, placedPiecesCount, placedAlarmsCount, placedJunkCount, placedBlastCount };
}

/** Compute fitness score from board totals — includes the packing-only fallback for stat-less inventories. */
export function calculateFitness(
    t: Stats,
    piecesCount: number,
    alarmsCount: number,
    junkCount: number,
    blastCount: number,
    hasAnyPositiveStats: boolean,
    activeMax: { Performance: boolean; Quality: boolean; Efficiency: boolean },
    activeTar: { Performance: number | null; Quality: number | null; Efficiency: number | null },
    targetAlarmCount: number,
    targetJunkCount: number,
    targetBlastCount: number
): FitnessResult {
    let score = 0;

    if (!hasAnyPositiveStats) {
        score = piecesCount;
        if (alarmsCount < targetAlarmCount) score -= (targetAlarmCount - alarmsCount) * 100000;
        if (junkCount < targetJunkCount) score -= 100000;
        if (blastCount < targetBlastCount) score -= 100000;
        return { score, placedPiecesCount: piecesCount, alarmsCount, junkCount, blastCount };
    }

    if (alarmsCount < targetAlarmCount) score -= (targetAlarmCount - alarmsCount) * 100000;
    if (junkCount < targetJunkCount) score -= 100000;
    if (blastCount < targetBlastCount) score -= 100000;

    if (activeTar.Performance !== null && t.Performance < activeTar.Performance) score -= (activeTar.Performance - t.Performance) * 10000;
    if (activeTar.Quality !== null && t.Quality < activeTar.Quality) score -= (activeTar.Quality - t.Quality) * 10000;
    if (activeTar.Efficiency !== null && t.Efficiency < activeTar.Efficiency) score -= (activeTar.Efficiency - t.Efficiency) * 10000;

    if (activeMax.Performance) score += t.Performance * 10;
    if (activeMax.Quality) score += t.Quality * 10;
    if (activeMax.Efficiency) score += t.Efficiency * 10;

    return { score, placedPiecesCount: piecesCount, alarmsCount, junkCount, blastCount };
}

export function isJunk(p: InventoryItem) {
    return p.displayName.includes('Junk Processing');
}
export function isBlast(p: InventoryItem) {
    return p.displayName.includes('Blast Module');
}
export function isAlarm(p: InventoryItem) {
    return p.displayName.includes('Alarm Module');
}

/** Try swapping piece at 'here' with each adjacent non-White non-'here' piece. */
function trySwapMoves(
    bestBoard: (InventoryItem | 'Locked' | null)[][],
    bestFitness: number,
    pieceId: string,
    herePositions: Point[],
    hereOffsetsAll: Point[][],
    item: InventoryItem,
    inventory: InventoryItem[],
    activeMax: { Performance: boolean; Quality: boolean; Efficiency: boolean },
    activeTar: { Performance: number | null; Quality: number | null; Efficiency: number | null },
    targetAlarmCount: number,
    targetJunkCount: number,
    targetBlastCount: number,
    hasAnyPositiveStats: boolean,
    maxMoves: number,
    currentMoves: { count: number }
): { board: (InventoryItem | 'Locked' | null)[][]; fitness: number; improved: boolean; moves: number } {
    // Current orientation of the piece on the board (use first one as the "original")
    const hereOrigOrientation = hereOffsetsAll[0];
    const hereRootX = herePositions[0].x - hereOrigOrientation[0].x;
    const hereRootY = herePositions[0].y - hereOrigOrientation[0].y;
    let bestResultFitness = bestFitness;
    let bestResultBoard = bestBoard;
    let improved = false;
    let moves = 0;

    // Collect adjacent non-White cells that belong to different pieces
    const adjacentCells: Array<{ cell: InventoryItem; x: number; y: number; offsets: Point[][] }> = [];
    for (const pos of herePositions) {
        for (const off of [{ x: 0, y: -1 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 }]) {
            const nx = pos.x + off.x;
            const ny = pos.y + off.y;
            if (nx >= 0 && nx < 7 && ny >= 0 && ny < 5) {
                const adjCell = bestBoard[ny][nx];
                if (adjCell && adjCell !== 'Locked' && adjCell.id !== pieceId) {
                    const adjItem = inventory.find(i => i.id === adjCell.id) || (adjCell as InventoryItem);
                    if (adjItem.color !== 'White') {
                        const adjOffsets = PRECOMPUTED_OFFSETS.get(adjItem.shape)!;
                        adjacentCells.push({ cell: adjItem, x: nx, y: ny, offsets: adjOffsets });
                    }
                }
            }
        }
    }

    // Try swapping this piece with each adjacent piece, trying all orientation combos
    for (const adj of adjacentCells) {
        for (const hereOrientation of hereOffsetsAll) {
            // Check if 'here' piece can fit at adj's position (in this orientation)
            let hereCanFit = true;
            for (const pt of hereOrientation) {
                const px = adj.x + pt.x;
                const py = adj.y + pt.y;
                if (px < 0 || px >= 7 || py < 0 || py >= 5) { hereCanFit = false; break; }
                if (bestBoard[py][px] !== null) { hereCanFit = false; break; }
            }
            if (!hereCanFit) continue;

            for (const adjOrientation of adj.offsets) {
                // Check if adj piece can fit at 'here' position (in this orientation)
                let adjCanFit = true;
                for (const pt of adjOrientation) {
                    const px = hereRootX + pt.x;
                    const py = hereRootY + pt.y;
                    if (px < 0 || px >= 7 || py < 0 || py >= 5) { adjCanFit = false; break; }
                    if (bestBoard[py][px] !== null) { adjCanFit = false; break; }
                }
                if (!adjCanFit) continue;

                // Perform swap: here at adj's spot, adj at here's spot
                const testBoard = bestBoard.map(row => [...row]);

                // Clear old positions — use the piece's actual current-orientation cells, not the
                // canonical allOrientations[0] offsets (those can point at the wrong cells, or
                // out of bounds, when the piece is currently placed in a rotated orientation).
                for (const pos of herePositions) {
                    testBoard[pos.y][pos.x] = null;
                }

                // Place here at adj position (in chosen orientation)
                for (const pt of hereOrientation) {
                    testBoard[adj.y + pt.y][adj.x + pt.x] = item;
                }

                // Place adj at here position (in chosen orientation)
                for (const pt of adjOrientation) {
                    testBoard[hereRootY + pt.y][hereRootX + pt.x] = adj.cell;
                }

                const testResult = calculateBoardStats(testBoard, inventory);
                const testFitness = calculateFitness(
                    testResult.totals,
                    testResult.placedPiecesCount,
                    testResult.placedAlarmsCount,
                    testResult.placedJunkCount,
                    testResult.placedBlastCount,
                    hasAnyPositiveStats,
                    activeMax,
                    activeTar,
                    targetAlarmCount,
                    targetJunkCount,
                    targetBlastCount
                ).score;

                if (testFitness > bestResultFitness) {
                    bestBoard = testBoard;
                    bestResultFitness = testFitness;
                    improved = true;
                    moves++;
                    if (maxMoves > 0 && moves >= maxMoves) return { board: bestBoard, fitness: bestResultFitness, improved, moves };
                    break;
                }
            }
            if (improved) break;
        }
        if (improved) break;
    }

    return { board: bestBoard, fitness: bestResultFitness, improved, moves };
}

/**
 * Try to improve a completed board via local search.
 * For each piece on the board, iteratively:
 *   1. Try moving it to every valid empty position (all orientations)
 *   2. Try swapping it with each adjacent non-White piece
 *
 * On each successful move, restart the search from the beginning (greedy local descent).
 * Returns the improved board and stats, or the original if no improvement found.
 *
 * @param maxMoves - stop after this many successful local moves (0 = run until local optimum)
 */
export function localSearch(
    board: (InventoryItem | 'Locked' | null)[][],
    inventory: InventoryItem[],
    activeMax: { Performance: boolean; Quality: boolean; Efficiency: boolean },
    activeTar: { Performance: number | null; Quality: number | null; Efficiency: number | null },
    targetAlarmCount: number,
    targetJunkCount: number,
    targetBlastCount: number,
    maxMoves: number = 0
): { board: (InventoryItem | 'Locked' | null)[][]; result: BoardResult } {
    const hasAnyPositiveStats = inventory.some(item => {
        const modified = applyInternalEffects(item);
        return roundStat(modified.Performance) > 0 || roundStat(modified.Quality) > 0 || roundStat(modified.Efficiency) > 0;
    });

    let bestBoard = board.map(row => [...row]);
    let bestResult = calculateBoardStats(bestBoard, inventory);
    let bestFitness = calculateFitness(
        bestResult.totals,
        bestResult.placedPiecesCount,
        bestResult.placedAlarmsCount,
        bestResult.placedJunkCount,
        bestResult.placedBlastCount,
        hasAnyPositiveStats,
        activeMax,
        activeTar,
        targetAlarmCount,
        targetJunkCount,
        targetBlastCount
    ).score;

    let improved = true;
    while (improved) {
        improved = false;
        const movesAccum = { count: 0 };

        const placed = new Map<string, Point[]>();
        for (let y = 0; y < 5; y++) {
            for (let x = 0; x < 7; x++) {
                const cell = bestBoard[y][x];
                if (cell && cell !== 'Locked') {
                    const item = inventory.find(i => i.id === cell.id) || cell as InventoryItem;
                    if (!placed.has(item.id)) placed.set(item.id, []);
                    placed.get(item.id)!.push({ x, y });
                }
            }
        }

        // 1. Try moving each piece to a better position
        for (const [pieceId, positions] of placed) {
            const item = inventory.find(i => i.id === pieceId);
            if (!item) continue;

            const allOrientations = PRECOMPUTED_OFFSETS.get(item.shape)!;
            const rootX = positions[0].x - allOrientations[0][0].x;
            const rootY = positions[0].y - allOrientations[0][0].y;

            for (const shapeOffsets of allOrientations) {
                for (let tryY = 0; tryY < 5; tryY++) {
                    for (let tryX = 0; tryX < 7; tryX++) {
                        if (tryX === rootX && tryY === rootY && shapeOffsets === allOrientations[0]) continue;

                        let valid = true;
                        for (const pt of shapeOffsets) {
                            const px = tryX + pt.x;
                            const py = tryY + pt.y;
                            if (px < 0 || px >= 7 || py < 0 || py >= 5) { valid = false; break; }
                            if (bestBoard[py][px] !== null) { valid = false; break; }
                        }
                        if (!valid) continue;

                        // Clear the piece's actual current-orientation cells, not allOrientations[0]
                        // — if the piece is currently rotated, that canonical offset set points at
                        // the wrong cells (or out of bounds), which crashed with a TypeError.
                        const testBoard = bestBoard.map(row => [...row]);
                        for (const pos of positions) {
                            testBoard[pos.y][pos.x] = null;
                        }
                        for (const pt of shapeOffsets) {
                            testBoard[tryY + pt.y][tryX + pt.x] = item;
                        }

                        const testResult = calculateBoardStats(testBoard, inventory);
                        const testFitness = calculateFitness(
                            testResult.totals,
                            testResult.placedPiecesCount,
                            testResult.placedAlarmsCount,
                            testResult.placedJunkCount,
                            testResult.placedBlastCount,
                            hasAnyPositiveStats,
                            activeMax,
                            activeTar,
                            targetAlarmCount,
                            targetJunkCount,
                            targetBlastCount
                        ).score;

                        if (testFitness > bestFitness) {
                            bestBoard = testBoard;
                            bestResult = testResult;
                            bestFitness = testFitness;
                            improved = true;
                            movesAccum.count++;
                            if (maxMoves > 0 && movesAccum.count >= maxMoves) {
                                return { board: bestBoard, result: bestResult };
                            }
                            break;
                        }
                    }
                    if (improved) break;
                }
                if (improved) break;
            }
            if (improved) continue;

            // 2. Try swapping with adjacent non-White pieces
            const pieceOffsets = PRECOMPUTED_OFFSETS.get(item.shape)!;
            const swapResult = trySwapMoves(
                bestBoard, bestFitness, pieceId, positions, pieceOffsets, item,
                inventory, activeMax, activeTar, targetAlarmCount, targetJunkCount, targetBlastCount,
                hasAnyPositiveStats, maxMoves, movesAccum
            );
            if (swapResult.improved) {
                bestBoard = swapResult.board;
                bestFitness = swapResult.fitness;
                improved = true;
                if (maxMoves > 0 && movesAccum.count >= maxMoves) {
                    return { board: bestBoard, result: bestResult };
                }
                continue;
            }

            // 3. Rotation is covered by the move step (step 1) which tries all orientations at all positions
        }
    }

    return { board: bestBoard, result: bestResult };
}
