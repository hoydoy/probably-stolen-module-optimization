import { useState, useRef, useEffect, useCallback } from 'react';
import type {GridTier, InventoryItem, Stats, TargetStats, Point, ModuleShape, ModuleColor, ItemEffect, FurnaceModules} from '../types';
import { getBaseStats } from '../utils';
import { calculateBoardStats as calculateCanonicalBoardStats, emptyBoard } from '../optimizerCore';
import type { Board } from '../optimizerCore';
import { runOptimizationWorker } from '../optimizerWorkerClient';
import { MODULE_TEMPLATES } from '../constants';

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

const inventoryForCode = (inventory: InventoryItem[], board: Board) => {
    const used = new Set(board.flat().flatMap(cell => cell && cell !== 'Locked' ? [cell.id] : []));
    return inventory.filter(item => !item.id.includes('_clone_') || used.has(item.id));
};

type StoredMachine = {
    tier: GridTier;
    targetStats: TargetStats;
    maximizeStats: Record<keyof Stats, boolean>;
    statPriority: Record<keyof Stats, number>;
    boardIds: (string | 'Locked' | null)[][];
};

const loadStoredMachine = (key?: string): StoredMachine | null => {
    if (!key) return null;
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
};

const restoreBoard = (saved: StoredMachine | null, inventory: InventoryItem[], fallback: Board, tier: GridTier): Board => {
    if (!Array.isArray(saved?.boardIds) || saved.boardIds.length !== 5 || saved.boardIds.some(row => !Array.isArray(row) || row.length !== 7)) return fallback;
    const byId = new Map(inventory.map(item => [item.id, item]));
    const board = emptyBoard(tier);
    saved.boardIds.forEach((row, y) => row.forEach((id, x) => { board[y][x] = id === 'Locked' ? 'Locked' : id ? byId.get(id) || null : null; }));
    return board;
};

export function useOptimizer(
    inventory: InventoryItem[],
    setInventory: React.Dispatch<React.SetStateAction<InventoryItem[]>>,
    machineId: string,
    getUsedItems: (excludeId: string) => Set<string>,
    initialTier: GridTier = 3,
    initialMax = { Performance: false, Quality: false, Efficiency: false },
    initialTarget: TargetStats = { Performance: null, Quality: null, Efficiency: null },
    initialPriority = { Performance: 1, Quality: 1, Efficiency: 1 },
    initialBoard?: (InventoryItem | 'Locked' | null)[][],
    moduleType?: string,
    furnaceModules: FurnaceModules = 'none',
    alarmModule = false,
    optimizationTimeMs = 1500,
    storageKey?: string
) {
    const [savedState] = useState(() => loadStoredMachine(storageKey));
    const [tier, setTier] = useState<GridTier>(savedState?.tier ?? initialTier);
    const [targetStats, setTargetStats] = useState<TargetStats>(savedState?.targetStats ?? initialTarget);
    const [maximizeStats, setMaximizeStats] = useState(savedState?.maximizeStats ?? initialMax);
    const [statPriority, setStatPriority] = useState(savedState?.statPriority ?? initialPriority);

    const [board, setBoard] = useState<Board>(() => restoreBoard(savedState, inventory, initialBoard?.map(row => [...row]) || emptyBoard(savedState?.tier ?? initialTier), savedState?.tier ?? initialTier));
    const boardRef = useRef(board);
    const setBoardSync = (newBoard: Board) => {
        boardRef.current = newBoard;
        setBoard(newBoard);
    };

    const [bestTotals, setBestTotals] = useState<Stats>({ Performance: 0, Quality: 0, Efficiency: 0 });
    const [bestPieceStats, setBestPieceStats] = useState<Map<string, Stats>>(new Map());

    const [isSolving, setIsSolving] = useState(false);
    const [warningMsg, setWarningMsg] = useState<string | null>(null);
    const [solutionCode, setSolutionCode] = useState<string>('');
    const isSolvingRef = useRef(false);

    useEffect(() => {
        if (!storageKey || isSolving) return;
        localStorage.setItem(storageKey, JSON.stringify({
            tier, targetStats, maximizeStats, statPriority,
            boardIds: board.map(row => row.map(cell => cell && cell !== 'Locked' ? cell.id : cell))
        }));
    }, [storageKey, tier, targetStats, maximizeStats, statPriority, board, isSolving]);

    const getAvailableInventory = useCallback(() => {
        const used = machineId ? getUsedItems(machineId) : new Set<string>();
        const onBoard = new Set(boardRef.current.flat().flatMap(cell => cell && cell !== 'Locked' ? [cell.id] : []));
        return inventory.filter(item => !used.has(item.id) && (!item.isLocked || onBoard.has(item.id)));
    }, [getUsedItems, machineId, inventory]);

    const handleTierChange = (newTier: GridTier) => {
        setTier(newTier);
        setBoardSync(emptyBoard(newTier));
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
        setBoardSync(emptyBoard(tier));
        setBestTotals({ Performance: 0, Quality: 0, Efficiency: 0 });
        setBestPieceStats(new Map());
        setWarningMsg(null);
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
            const newBoard = emptyBoard(decodedTier);
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
                const base = getBaseStats({ shape, color, displayName: template.displayName });
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

            const { totals, pieceStats } = calculateCanonicalBoardStats(newBoard);
            setBestTotals(totals);
            setBestPieceStats(new Map(pieceStats));
        } catch {
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
            const { totals, pieceStats } = calculateCanonicalBoardStats(boardToCalculate);

            setBestTotals(totals);
            setBestPieceStats(new Map(pieceStats));
            if (boardChanged) setBoardSync(newBoard);

            if (inventory.length > 0) {
                const availableForCode = inventoryForCode(getAvailableInventory(), boardToCalculate);
                const newCode = generateCodeFromState(tier, maximizeStats, targetStats, availableForCode, boardToCalculate);
                setSolutionCode(newCode);
            } else {
                setSolutionCode('');
            }
        }
    }, [inventory, tier, maximizeStats, targetStats, board, getAvailableInventory]);

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

        const requiredModuleIds = [...new Set(boardRef.current.flat().flatMap(cell => cell && cell !== 'Locked' && cell.isLocked ? [cell.id] : []))];
        const config = { id: machineId, tier, targetStats, maximizeStats, statPriority, moduleType, furnaceModules, alarmModule, requiredModuleIds };

        try {
            await runOptimizationWorker([config], [boardRef.current], availableInventory, isSolvingRef, (updates) => {
                const myUpdate = updates.get(machineId);
                if (myUpdate) {
                    setBoardSync(myUpdate.board);
                    setBestTotals(myUpdate.totals);
                    setBestPieceStats(myUpdate.pieceStats);
                    setSolutionCode(generateCodeFromState(tier, maximizeStats, targetStats, inventoryForCode(availableInventory, myUpdate.board), myUpdate.board));
                }
            }, optimizationTimeMs);
        } catch (error) {
            setWarningMsg(error instanceof Error ? error.message : 'Optimization failed.');
        } finally {
            isSolvingRef.current = false;
            setIsSolving(false);
        }
    };

    const applyUpdate = (updatedBoard: Board, updatedTotals: Stats, updatedPieceStats: Map<string, Stats>, updatedCode: string) => {
        setBoardSync(updatedBoard);
        setBestTotals(updatedTotals);
        setBestPieceStats(updatedPieceStats);
        if (updatedCode) setSolutionCode(updatedCode);
    };

    return {
        tier, setTier, handleTierChange, targetStats, setTargetStats,
        maximizeStats, setMaximizeStats, statPriority, setStatPriority, board, bestTotals, bestPieceStats,
        isSolving, stopOptimization, warningMsg, setWarningMsg,
        solutionCode, setSolutionCode, importSolution, runOptimization, resetBoard,
        manuallyPlaceItem, manuallyRemoveItem, isValidPlacement, boardRef, applyUpdate
    };
}
