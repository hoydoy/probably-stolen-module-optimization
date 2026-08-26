import type { FurnaceModules, GridTier, InventoryItem, ModuleShape, Stats, TargetStats } from './types';
import { PRECOMPUTED_OFFSETS, applyInternalEffects } from './utils.ts';
import { isAlarm, isBlast, isJunk, isModuleAllowedForMachine } from './moduleRules.ts';

export type Board = (InventoryItem | 'Locked' | null)[][];

export type OptimizerMachine = {
    id: string;
    tier: GridTier;
    targetStats: TargetStats;
    maximizeStats: Record<keyof Stats, boolean>;
    statPriority?: Partial<Record<keyof Stats, number>>;
    moduleType?: string;
    furnaceModules?: FurnaceModules;
    alarmModule?: boolean;
    requiredModuleIds?: string[];
};

export type OptimizerUpdate = {
    id: string;
    board: Board;
    totals: Stats;
    pieceStats: Map<string, Stats>;
};

type Placement = { cells: number[]; low: number; high: number; touchesEdge: boolean };
type BoardStats = { totals: Stats; pieceStats: Map<string, Stats>; placedIds: Set<string>; placedPiecesCount: number; placedAlarmsCount: number; placedJunkCount: number; placedBlastCount: number };

const DIRECTIONS = [[0, -1], [0, 1], [-1, 0], [1, 0]] as const;
const placementCache = new Map<string, Placement[]>();
const trunc = (value: number) => value < 0 ? Math.ceil(value - 1e-9) : Math.floor(value + 1e-9);
const cloneBoard = (board: Board): Board => board.map(row => [...row]);
const sameCells = (a: number[], b: number[]) => a.length === b.length && a.every(cell => b.includes(cell));
function shuffled<T>(values: T[]) {
    const result = [...values];
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}

export function emptyBoard(tier: GridTier): Board {
    const board: Board = Array.from({ length: 5 }, () => Array(7).fill(null));
    if (tier < 3) board[0][0] = board[0][6] = board[4][0] = board[4][6] = 'Locked';
    if (tier === 1) board[1][3] = board[2][2] = board[2][3] = board[2][4] = board[3][3] = 'Locked';
    return board;
}

function placementsFor(shape: ModuleShape, tier: GridTier) {
    const key = `${shape}:${tier}`;
    const cached = placementCache.get(key);
    if (cached) return cached;
    const locked = emptyBoard(tier);
    const placements: Placement[] = [];
    for (const offsets of PRECOMPUTED_OFFSETS.get(shape) || []) {
        for (let y = 0; y < 5; y++) {
            for (let x = 0; x < 7; x++) {
                const cells = offsets.map(point => (y + point.y) * 7 + x + point.x);
                if (cells.some(cell => cell < 0 || cell >= 35 || Math.floor(cell / 7) !== y + offsets[cells.indexOf(cell)].y || locked[Math.floor(cell / 7)][cell % 7] === 'Locked')) continue;
                let low = 0, high = 0;
                cells.forEach(cell => cell < 32 ? low |= (1 << cell) : high |= (1 << (cell - 32)));
                placements.push({ cells, low: low >>> 0, high: high >>> 0, touchesEdge: cells.some(cell => cell < 7 || cell >= 28 || cell % 7 === 0 || cell % 7 === 6) });
            }
        }
    }
    placementCache.set(key, placements);
    return placements;
}

function occupancy(board: Board) {
    let low = 0, high = 0;
    const ids = new Set<string>();
    board.flat().forEach((cell, index) => {
        if (cell) {
            if (index < 32) low |= (1 << index);
            else high |= (1 << (index - 32));
        }
        if (cell && cell !== 'Locked') ids.add(cell.id);
    });
    return { low: low >>> 0, high: high >>> 0, pieces: ids.size };
}

function placementConnects(board: Board, placement: Placement) {
    if (placement.touchesEdge) return true;
    return placement.cells.some(cell => {
        const x = cell % 7, y = Math.floor(cell / 7);
        return DIRECTIONS.some(([dx, dy]) => {
            const nx = x + dx, ny = y + dy;
            return nx >= 0 && nx < 7 && ny >= 0 && ny < 5 && board[ny][nx] && board[ny][nx] !== 'Locked';
        });
    });
}

function isConnected(board: Board) {
    const cells = board.flatMap((row, y) => row.flatMap((cell, x) => cell && cell !== 'Locked' ? [y * 7 + x] : []));
    if (!cells.length) return true;
    const wanted = new Set(cells), seen = new Set([cells[0]]), pending = [cells[0]];
    while (pending.length) {
        const cell = pending.pop()!, x = cell % 7, y = Math.floor(cell / 7);
        DIRECTIONS.forEach(([dx, dy]) => {
            const next = (y + dy) * 7 + x + dx;
            if (x + dx >= 0 && x + dx < 7 && y + dy >= 0 && y + dy < 5 && wanted.has(next) && !seen.has(next)) {
                seen.add(next);
                pending.push(next);
            }
        });
    }
    return seen.size === cells.length;
}

export function calculateBoardStats(board: Board, cachedInternal?: Map<string, Stats>): BoardStats {
    const totals: Stats = { Performance: 0, Quality: 0, Efficiency: 0 };
    const pieceStats = new Map<string, Stats>();
    const pieces = new Map<string, { item: InventoryItem; cells: number[]; minX: number; minY: number }>();
    board.flat().forEach((cell, index) => {
        if (!cell || cell === 'Locked') return;
        const piece = pieces.get(cell.id);
        if (piece) {
            piece.cells.push(index);
            piece.minX = Math.min(piece.minX, index % 7);
            piece.minY = Math.min(piece.minY, Math.floor(index / 7));
        } else pieces.set(cell.id, { item: cell, cells: [index], minX: index % 7, minY: Math.floor(index / 7) });
    });

    const nodeAdjacencies = new Map<string, Set<string>>();
    pieces.forEach(({ item, cells }) => {
        if (item.color !== 'White') return;
        const adjacent = new Set<string>();
        cells.forEach(cell => {
            const x = cell % 7, y = Math.floor(cell / 7);
            DIRECTIONS.forEach(([dx, dy]) => {
                const neighbor = board[y + dy]?.[x + dx];
                if (neighbor && neighbor !== 'Locked' && neighbor.color !== 'White') adjacent.add(neighbor.id);
            });
        });
        nodeAdjacencies.set(item.id, adjacent);
    });

    const internalOf = (item: InventoryItem) => cachedInternal?.get(item.id) ?? applyInternalEffects(item);
    const internal = new Map<string, Stats>();
    pieces.forEach(({ item, cells }) => {
        if (item.color === 'White') return;
        const stats = { ...internalOf(item) };
        const nfCount = item.effects.filter(effect => effect === 'Negative Feedback').length;
        if (nfCount) {
            const neighbors = new Set<string>();
            cells.forEach(cell => {
                const x = cell % 7, y = Math.floor(cell / 7);
                DIRECTIONS.forEach(([dx, dy]) => {
                    const neighbor = board[y + dy]?.[x + dx];
                    if (neighbor && neighbor !== 'Locked' && neighbor.id !== item.id && neighbor.color !== 'White') neighbors.add(neighbor.id);
                });
            });
            neighbors.forEach(id => {
                const neighbor = pieces.get(id);
                if (!neighbor) return;
                const adjacent = internalOf(neighbor.item);
                if (adjacent.Performance < 0) stats.Performance += nfCount * 0.25 * adjacent.Performance;
                if (adjacent.Quality < 0) stats.Quality += nfCount * 0.25 * adjacent.Quality;
                if (adjacent.Efficiency < 0) stats.Efficiency += nfCount * 0.25 * adjacent.Efficiency;
            });
        }
        internal.set(item.id, { Performance: trunc(stats.Performance), Quality: trunc(stats.Quality), Efficiency: trunc(stats.Efficiency) });
    });

    pieces.forEach(({ item, minX, minY }) => {
        if (item.color === 'White') return;
        const stats = { ...internal.get(item.id)! };
        let multiplier = 0;
        if (item.effects.includes('Side Mount') && minX === 0) multiplier += 0.2;
        if (item.effects.includes('Top Mount') && minY === 0) multiplier += 0.2;
        if (item.effects.includes('Receiver')) {
            let nodes = 0;
            nodeAdjacencies.forEach(adjacent => { if (adjacent.has(item.id)) nodes++; });
            multiplier += nodes * 0.1;
        }
        const final = {
            Performance: trunc(stats.Performance * (1 + multiplier)),
            Quality: trunc(stats.Quality * (1 + multiplier)),
            Efficiency: trunc(stats.Efficiency * (1 + multiplier))
        };
        pieceStats.set(item.id, final);
        totals.Performance += final.Performance;
        totals.Quality += final.Quality;
        totals.Efficiency += final.Efficiency;
    });

    nodeAdjacencies.forEach((adjacent, nodeId) => {
        const sum: Stats = { Performance: 0, Quality: 0, Efficiency: 0 };
        adjacent.forEach(id => {
            const item = pieces.get(id)?.item;
            if (!item) return;
            const stats = internalOf(item);
            sum.Performance += stats.Performance;
            sum.Quality += stats.Quality;
            sum.Efficiency += stats.Efficiency;
        });
        const final = { Performance: trunc(sum.Performance * 0.2), Quality: trunc(sum.Quality * 0.2), Efficiency: trunc(sum.Efficiency * 0.2) };
        pieceStats.set(nodeId, final);
        totals.Performance += final.Performance;
        totals.Quality += final.Quality;
        totals.Efficiency += final.Efficiency;
    });

    const items = [...pieces.values()].map(piece => piece.item);
    return {
        totals,
        pieceStats,
        placedIds: new Set(items.map(item => item.id)),
        placedPiecesCount: items.length,
        placedAlarmsCount: items.filter(isAlarm).length,
        placedJunkCount: items.filter(isJunk).length,
        placedBlastCount: items.filter(isBlast).length
    };
}

function requiredSpecial(item: InventoryItem, machine: OptimizerMachine) {
    if (isAlarm(item)) return machine.moduleType === 'MODULE_TYPE_ALARM' && machine.alarmModule === true;
    if (isJunk(item)) return machine.furnaceModules === 'junk' || machine.furnaceModules === 'both';
    if (isBlast(item)) return machine.furnaceModules === 'blast' || machine.furnaceModules === 'both';
    return false;
}

type Score = number[];
const scoreRanks = (machines: OptimizerMachine[]) => [...new Set(machines.flatMap(machine =>
    (Object.keys(machine.maximizeStats) as (keyof Stats)[])
        .map(key => machine.statPriority?.[key] ?? 1)
))].sort((a, b) => a - b);
const compareScores = (a: Score, b: Score) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const difference = (a[i] ?? 0) - (b[i] ?? 0);
        if (Math.abs(difference) > 1e-9) return difference;
    }
    return 0;
};

function machineScore(machine: OptimizerMachine, stats: BoardStats, requiredAlarms: number, ranks = scoreRanks([machine])): Score {
    const score = [0, ...ranks.map(() => 0)];
    (Object.keys(stats.totals) as (keyof Stats)[]).forEach(key => {
        const tier = 1 + ranks.indexOf(machine.statPriority?.[key] ?? 1);
        const target = machine.targetStats[key];
        if (target !== null && stats.totals[key] < target) score[tier] -= (target - stats.totals[key]) * 10000;
        if (machine.maximizeStats[key]) score[tier] += stats.totals[key] * 10;
    });
    if (machine.moduleType === 'MODULE_TYPE_ALARM' && machine.alarmModule && stats.placedAlarmsCount < requiredAlarms) score[0] -= requiredAlarms - stats.placedAlarmsCount;
    if ((machine.furnaceModules === 'junk' || machine.furnaceModules === 'both') && stats.placedJunkCount < 1) score[0]--;
    if ((machine.furnaceModules === 'blast' || machine.furnaceModules === 'both') && stats.placedBlastCount < 1) score[0]--;
    score[0] -= (machine.requiredModuleIds || []).filter(id => !stats.placedIds.has(id)).length;
    return score;
}

function utility(item: InventoryItem, machine: OptimizerMachine, internal: Map<string, Stats>, current?: Stats, requiredByItem?: Map<string, string>) {
    const requiredMachine = requiredByItem?.get(item.id);
    if (requiredMachine && requiredMachine !== machine.id) return -Infinity;
    if (!isModuleAllowedForMachine(item, machine)) return -Infinity;
    if (requiredMachine === machine.id) return 2_000_000;
    if (requiredSpecial(item, machine)) return 1_000_000;
    const stats = internal.get(item.id)!;
    let value = item.color === 'White' ? 1 : 0;
    (Object.keys(stats) as (keyof Stats)[]).forEach(key => {
        const priorityWeight = 4 ** (3 - (machine.statPriority?.[key] ?? 1));
        const target = machine.targetStats[key];
        if (target !== null) {
            const before = Math.max(0, target - (current?.[key] ?? 0));
            const after = Math.max(0, target - (current?.[key] ?? 0) - stats[key]);
            value += (before - after) * 10000 * priorityWeight;
        }
        if (machine.maximizeStats[key]) value += stats[key] * 10 * priorityWeight;
    });
    return value;
}

function cellsFor(board: Board, itemId: string) {
    return board.flatMap((row, y) => row.flatMap((cell, x) => cell && cell !== 'Locked' && cell.id === itemId ? [y * 7 + x] : []));
}

function placeBest(board: Board, item: InventoryItem, machine: OptimizerMachine, requiredAlarms: number, internal: Map<string, Stats>, preferred?: Board) {
    const occupied = occupancy(board);
    const before = machineScore(machine, calculateBoardStats(board, internal), requiredAlarms);
    let bestScore = before;
    let bestMovement = Infinity;
    let best: Placement | undefined;
    const preferredCells = preferred ? cellsFor(preferred, item.id) : [];
    for (const placement of placementsFor(item.shape, machine.tier)) {
        if ((placement.low & occupied.low) || (placement.high & occupied.high)) continue;
        if (occupied.pieces && !placementConnects(board, placement)) continue;
        placement.cells.forEach(cell => board[Math.floor(cell / 7)][cell % 7] = item);
        const score = machineScore(machine, calculateBoardStats(board, internal), requiredAlarms);
        placement.cells.forEach(cell => board[Math.floor(cell / 7)][cell % 7] = null);
        const movement = sameCells(placement.cells, preferredCells) ? 0 : 1;
        const comparison = compareScores(score, bestScore);
        if (comparison > 0 || (best && comparison === 0 && movement < bestMovement)) {
            bestScore = score;
            bestMovement = movement;
            best = placement;
        }
    }
    if (!best) return false;
    best.cells.forEach(cell => board[Math.floor(cell / 7)][cell % 7] = item);
    return true;
}

function repairMachine(machine: OptimizerMachine, items: InventoryItem[], allItems: InventoryItem[], internal: Map<string, Stats>, requiredByItem: Map<string, string>, seed?: Board, preferred?: Board) {
    const board = seed ? cloneBoard(seed) : emptyBoard(machine.tier);
    const requiredAlarms = machine.moduleType === 'MODULE_TYPE_ALARM' && machine.alarmModule ? allItems.filter(item => isAlarm(item) && isModuleAllowedForMachine(item, machine)).length : 0;
    const candidates = shuffled(items.filter(item => item.optimizable !== false && isModuleAllowedForMachine(item, machine) && (!requiredByItem.has(item.id) || requiredByItem.get(item.id) === machine.id)))
        .sort((a, b) => utility(b, machine, internal, undefined, requiredByItem) - utility(a, machine, internal, undefined, requiredByItem));
    for (let pass = 0; pass < 2; pass++) {
        for (const item of candidates) {
            if (board.flat().some(cell => cell && cell !== 'Locked' && cell.id === item.id)) continue;
            if ((isJunk(item) || isBlast(item)) && board.flat().some(cell => cell && cell !== 'Locked' && (isJunk(item) ? isJunk(cell) : isBlast(cell)))) continue;
            placeBest(board, item, machine, requiredAlarms, internal, preferred);
        }
    }
    return board;
}

function assignItems(items: InventoryItem[], machines: OptimizerMachine[], internal: Map<string, Stats>, requiredByItem: Map<string, string>) {
    const assigned = new Map<string, InventoryItem[]>(machines.map(machine => [machine.id, []]));
    const projected = new Map<string, Stats>(machines.map(machine => [machine.id, { Performance: 0, Quality: 0, Efficiency: 0 }]));
    shuffled(items).forEach(item => {
        let best = -Infinity;
        let choices: OptimizerMachine[] = [];
        machines.forEach(machine => {
            const score = utility(item, machine, internal, projected.get(machine.id), requiredByItem);
            if (score > best) { best = score; choices = [machine]; }
            else if (score === best) choices.push(machine);
        });
        if (best <= 0 || !choices.length) return;
        const machine = choices[Math.floor(Math.random() * choices.length)];
        assigned.get(machine.id)!.push(item);
        const totals = projected.get(machine.id)!;
        const stats = internal.get(item.id)!;
        (Object.keys(stats) as (keyof Stats)[]).forEach(key => { totals[key] += stats[key]; });
    });
    return assigned;
}

function seedBoards(machines: OptimizerMachine[], boards: Board[], inventory: InventoryItem[], requiredByItem: Map<string, string>) {
    const available = new Map(inventory.filter(item => item.optimizable !== false).map(item => [item.id, item]));
    const used = new Set<string>();
    return machines.map((machine, index) => {
        const seeded = emptyBoard(machine.tier);
        const pieces = new Map<string, number[]>();
        boards[index]?.forEach((row, y) => row.forEach((cell, x) => {
            if (!cell || cell === 'Locked') return;
            const cells = pieces.get(cell.id) || [];
            cells.push(y * 7 + x);
            pieces.set(cell.id, cells);
        }));
        let hasJunk = false, hasBlast = false;
        pieces.forEach((cells, id) => {
            const item = available.get(id);
            if (!item || used.has(id) || (requiredByItem.has(id) && requiredByItem.get(id) !== machine.id) || !isModuleAllowedForMachine(item, machine) || (isJunk(item) && hasJunk) || (isBlast(item) && hasBlast)) return;
            const placement = placementsFor(item.shape, machine.tier).find(candidate =>
                candidate.cells.length === cells.length && candidate.cells.every(cell => cells.includes(cell))
            );
            if (!placement) return;
            placement.cells.forEach(cell => seeded[Math.floor(cell / 7)][cell % 7] = item);
            used.add(id);
            if (isJunk(item)) hasJunk = true;
            if (isBlast(item)) hasBlast = true;
        });
        return seeded;
    });
}

export function scoreBoards(boards: Board[], machines: OptimizerMachine[], inventory: InventoryItem[], internal = new Map(inventory.map(item => [item.id, applyInternalEffects(item)]))): Score {
    const ranks = scoreRanks(machines);
    const score = [0, ...ranks.map(() => 0)];
    const stats = boards.map(board => calculateBoardStats(board, internal));
    stats.forEach((boardStats, index) => {
        const requiredAlarms = machines[index].moduleType === 'MODULE_TYPE_ALARM' && machines[index].alarmModule ? inventory.filter(item => isAlarm(item) && isModuleAllowedForMachine(item, machines[index])).length : 0;
        const machine = machineScore(machines[index], boardStats, requiredAlarms, ranks);
        machine.forEach((value, tier) => { score[tier] += value; });
    });
    (['Performance', 'Quality', 'Efficiency'] as (keyof Stats)[]).forEach(key => {
        const participants = machines.flatMap((machine, index) => machine.maximizeStats[key] && machine.targetStats[key] === null ? [index] : []);
        if (participants.length < 2) return;
        const values = participants.map(index => stats[index].totals[key]);
        const average = values.reduce((sum, value) => sum + value, 0) / values.length;
        const deviation = values.reduce((sum, value) => sum + Math.abs(value - average), 0) / values.length;
        const rank = Math.min(...participants.map(index => machines[index].statPriority?.[key] ?? 1));
        score[1 + ranks.indexOf(rank)] -= deviation * 5;
    });
    return score;
}

function movementCount(boards: Board[], reference: Board[]) {
    const placements = (source: Board[]) => {
        const result = new Map<string, string>();
        source.forEach((board, boardIndex) => {
            const ids = new Set(board.flat().filter((cell): cell is InventoryItem => Boolean(cell && cell !== 'Locked')).map(cell => cell.id));
            ids.forEach(id => result.set(id, `${boardIndex}:${cellsFor(board, id).join(',')}`));
        });
        return result;
    };
    const current = placements(boards);
    const original = placements(reference);
    return [...new Set([...current.keys(), ...original.keys()])].filter(id => current.get(id) !== original.get(id)).length;
}

function updatesFor(boards: Board[], machines: OptimizerMachine[], internal: Map<string, Stats>): OptimizerUpdate[] {
    return boards.map((board, index) => {
        const stats = calculateBoardStats(board, internal);
        return { id: machines[index].id, board: cloneBoard(board), totals: stats.totals, pieceStats: stats.pieceStats };
    });
}

export async function optimizeGlobal(
    machines: OptimizerMachine[],
    inventory: InventoryItem[],
    timeLimitMs: number,
    onUpdate: (updates: OptimizerUpdate[]) => void,
    startingBoards: Board[] = []
) {
    const started = performance.now();
    const usable = inventory.filter(item => item.optimizable !== false);
    const internal = new Map(usable.map(item => [item.id, applyInternalEffects(item)]));
    const usableById = new Map(usable.map(item => [item.id, item]));
    const requiredByItem = new Map<string, string>();
    machines.forEach(machine => (machine.requiredModuleIds || []).forEach(id => {
        const item = usableById.get(id);
        if (!item) throw new Error(`Required module ${id} is unavailable.`);
        if (requiredByItem.has(id)) throw new Error(`${item.displayName} is required by more than one machine.`);
        if (!isModuleAllowedForMachine(item, machine)) throw new Error(`${item.displayName} cannot be used in machine ${machine.id}.`);
        requiredByItem.set(id, machine.id);
    }));
    const initialAssignment = assignItems(usable.filter(item => !requiredByItem.has(item.id)), machines, internal, requiredByItem);
    requiredByItem.forEach((machineId, itemId) => initialAssignment.get(machineId)!.unshift(usableById.get(itemId)!));
    const referenceBoards = seedBoards(machines, startingBoards, usable, requiredByItem);
    let bestBoards = referenceBoards.map(cloneBoard);
    let bestScore = scoreBoards(bestBoards, machines, usable, internal);
    let bestMovement = 0;
    const repairedBoards = machines.map((machine, index) => repairMachine(machine, initialAssignment.get(machine.id) || [], usable, internal, requiredByItem, undefined, referenceBoards[index]));
    machines.forEach((machine, index) => {
        const placed = calculateBoardStats(repairedBoards[index], internal).placedIds;
        const missing = (machine.requiredModuleIds || []).filter(id => !placed.has(id));
        if (missing.length) throw new Error(`Required modules do not fit in machine ${machine.id}.`);
    });
    const repairedScore = scoreBoards(repairedBoards, machines, usable, internal);
    const repairedMovement = movementCount(repairedBoards, referenceBoards);
    let comparison = compareScores(repairedScore, bestScore);
    if (comparison > 0 || (comparison === 0 && repairedMovement < bestMovement)) {
        bestBoards = repairedBoards;
        bestScore = repairedScore;
        bestMovement = repairedMovement;
    }
    onUpdate(updatesFor(bestBoards, machines, internal));

    let iterations = 0;
    while (performance.now() - started < timeLimitMs) {
        iterations++;
        const largeRuin = iterations % 12 === 0;
        const count = machines.length < 3 || largeRuin ? machines.length : 2;
        const selected = shuffled(machines).slice(0, count);
        const selectedIds = new Set(selected.map(machine => machine.id));
        const candidateBoards = bestBoards.map(cloneBoard);
        candidateBoards.forEach((board, index) => {
            if (!selectedIds.has(machines[index].id)) return;
            const ids = shuffled([...new Set(board.flat().filter((cell): cell is InventoryItem => Boolean(cell && cell !== 'Locked')).map(cell => cell.id))]);
            const removeCount = largeRuin
                ? Math.max(1, Math.floor(ids.length * (0.5 + Math.random() * 0.4)))
                : Math.min(ids.length, 1 + Math.floor(Math.random() * 3));
            const removed = new Set(ids.filter(id => !requiredByItem.has(id)).slice(0, removeCount));
            board.forEach(row => row.forEach((cell, x) => {
                if (cell && cell !== 'Locked' && removed.has(cell.id)) row[x] = null;
            }));
        });
        const used = new Set(candidateBoards.flatMap(board => board.flat().filter((cell): cell is InventoryItem => Boolean(cell && cell !== 'Locked')).map(cell => cell.id)));
        let available = usable.filter(item => !used.has(item.id));
        shuffled(selected).forEach(machine => {
            const index = machines.findIndex(candidate => candidate.id === machine.id);
            candidateBoards[index] = repairMachine(machine, available, usable, internal, requiredByItem, candidateBoards[index], referenceBoards[index]);
            const placed = new Set(candidateBoards[index].flat().filter((cell): cell is InventoryItem => Boolean(cell && cell !== 'Locked')).map(cell => cell.id));
            available = available.filter(item => !placed.has(item.id));
        });
        if (selected.some(machine => !isConnected(candidateBoards[machines.findIndex(candidate => candidate.id === machine.id)]))) continue;
        const score = scoreBoards(candidateBoards, machines, usable, internal);
        const movement = movementCount(candidateBoards, referenceBoards);
        comparison = compareScores(score, bestScore);
        if (comparison > 0 || (comparison === 0 && movement < bestMovement)) {
            bestScore = score;
            bestMovement = movement;
            bestBoards = candidateBoards;
            onUpdate(updatesFor(bestBoards, machines, internal));
        }
    }
    return updatesFor(bestBoards, machines, internal);
}
