import React, { useState, useEffect, useRef, forwardRef, useImperativeHandle, useCallback, useMemo } from 'react';
import type { Stats, GridTier, InventoryItem, FilterGroup, ItemEffect, ModuleTemplate, ModuleColor, Point, MachineMode, FurnaceModules, TargetStats } from './types';
import { COLOR_MAP, EFFECTS_LIST, MODULE_TEMPLATES, NODE_TEMPLATE } from './constants';
import { formatStatValue, getStatColor, getBaseStats, PRECOMPUTED_OFFSETS, applyInternalEffects } from './utils';
import { useOptimizer } from './hooks/useOptimizer';
import { runOptimizationWorker } from './optimizerWorkerClient';
import { calculateBoardStats } from './optimizerCore';
import type { Board } from './optimizerCore';
import { importEs3Save } from './saveImport';
import type { ImportedInventoryGrid } from './saveImport';
import MiniShape from './components/MiniShape';
import SaveInventoryGrid from './components/SaveInventoryGrid';
import { getMachineAbbreviation, getModuleLabel, getModuleLabelArea, hasStrongerSameShape } from './moduleRules';
import { buildMovePlan, reconcileMoveTargets } from './movePlan';
import type { MovePlacement, MoveStep } from './movePlan';

type UiMachine = {
    id: string;
    initialTier: GridTier;
    initialMax: MaximizeStats;
    initialTarget?: TargetStats;
    initialPriority?: StatRanks;
    initialBoard?: Board;
    name?: string;
    location?: string;
    moduleType?: string;
    furnaceModules?: FurnaceModules;
    alarmModule?: boolean;
    mode: MachineMode;
    imported?: boolean;
    revision?: number;
};

type MaximizeStats = Record<keyof Stats, boolean>;
type StatRanks = Record<keyof Stats, number>;
type MachinePreferences = {
    tier: GridTier;
    maximizeStats: MaximizeStats;
    targetStats: TargetStats;
    statPriority: StatRanks;
    mode: MachineMode;
    moduleType?: string;
    furnaceModules?: FurnaceModules;
    alarmModule?: boolean;
};
type DragTarget = { machineId: string | null; x: number; y: number };
type DragState = {
    item: InventoryItem;
    sourceMachineId: string | null;
    offsets: Point[];
    dragOffsetX: number;
    dragOffsetY: number;
    initialMouseX: number;
    initialMouseY: number;
    initialTarget?: DragTarget;
};
type HoverInfo = { x: number; y: number; cell: InventoryItem; stats?: Stats; showRecycleReason?: boolean };
type MachineHandle = {
    run: () => Promise<void>;
    stop: () => void;
    clear: () => void;
    place: (item: InventoryItem, x: number, y: number, offsets: Point[]) => void;
    remove: (itemId: string) => void;
    getState: () => MachinePreferences;
    isValidPlacement: (item: InventoryItem, x: number, y: number, offsets: Point[]) => boolean;
    getBoard: () => Board;
    applyUpdate: (board: Board, totals: Stats, pieceStats: Map<string, Stats>, code: string) => void;
};
type SaveFileHandle = { getFile: () => Promise<File> };
type InventoryItemRowProps = {
    item: InventoryItem;
    isAnySolving: boolean;
    updateItemEffect: (item: InventoryItem, index: 0 | 1, effect: ItemEffect) => void;
    updateItemEffectValue: (id: string, index: 0 | 1, value: number) => void;
    handleBlurEffectValue: (item: InventoryItem, index: 0 | 1, value: number) => void;
    onRemove: (id: string) => void;
    onDragStart: (event: React.MouseEvent, item: InventoryItem) => void;
    onToggleInfinite?: (isInfinite: boolean) => void;
    onToggleLock: (id: string) => void;
    readOnly?: boolean;
};
type MachineInstanceProps = {
    machineId: string;
    inventory: InventoryItem[];
    setInventory: React.Dispatch<React.SetStateAction<InventoryItem[]>>;
    getUsedItems: (excludeId: string) => Set<string>;
    initialTier: GridTier;
    initialMax: MaximizeStats;
    initialTarget?: TargetStats;
    initialPriority?: StatRanks;
    initialBoard?: Board;
    machineName?: string;
    machineLocation?: string;
    machineModuleType?: string;
    furnaceModules?: FurnaceModules;
    onFurnaceModulesChange: (id: string, value: FurnaceModules) => void;
    alarmModule?: boolean;
    onAlarmModuleChange: (id: string, value: boolean) => void;
    mode: MachineMode;
    onModeChange: (id: string, value: MachineMode) => void;
    onPreferencesChange: (id: string, value: MachinePreferences) => void;
    imported?: boolean;
    dragState: DragState | null;
    setHoverInfo: React.Dispatch<React.SetStateAction<HoverInfo | null>>;
    onDuplicate: (id: string) => void;
    onDelete: (id: string) => void;
    cellSize: number;
    onSolvingChange: (id: string, solving: boolean) => void;
    onDragTargetRefChange: (target: DragTarget | null) => void;
    onLocateModule: (id: string) => void;
    onOptimizeMachine: (id: string) => void;
    onClearMachine: (id: string) => void;
    moduleAssignments: Record<string, string>;
    assignmentMachines: { id: string; name: string; moduleType?: string; furnaceModules?: FurnaceModules; alarmModule?: boolean }[];
    isAnySolving: boolean;
    canDelete: boolean;
    optimizationSeconds: number;
};

const DEFAULT_SAVE_FOLDER = String.raw`%USERPROFILE%\AppData\LocalLow\Questing Goose Studio\Probably Stolen`;
const SAVE_PREFERENCES_KEY = 'optimizer_save_preferences:';
const SAVE_ASSIGNMENTS_KEY = 'optimizer_save_assignments:';
const RESERVED_ASSIGNMENT = '__reserved__';
const OPTIMIZATION_SECONDS_KEY = 'optimizer_optimization_seconds';
const MAX_VISIBLE_INVENTORY_ROWS = 255;
const maxCustomEffectValue = (item: InventoryItem, effectIndex: 0 | 1, effects = item.effects) => {
    const stats = { ...getBaseStats(item) };
    for (let index = 0; index < effectIndex; index++) {
        const effect = effects[index];
        const factor = effect === 'Premium' ? 1.2 : effect === 'Inferior' ? 0.8 : effect === 'Overcharged' ? 2 : effect === 'Negative Feedback' ? 1.25 : null;
        if (factor !== null) (Object.keys(stats) as (keyof Stats)[]).forEach(stat => { stats[stat] = Math.trunc(stats[stat] * factor); });
        else if (effect === 'Learning Algorithm' || effect === 'Degrading') {
            const value = Math.trunc(item.effectValues[index] || 0);
            (Object.keys(stats) as (keyof Stats)[]).forEach(stat => {
                if (stats[stat] > 0) stats[stat] = value;
                else if (effect === 'Learning Algorithm' && stats[stat] < 0) stats[stat] = Math.min(0, stats[stat] + value);
                else if (effect === 'Degrading' && stats[stat] < 0) stats[stat] *= 2;
            });
        }
    }
    return Math.max(0, ...Object.values(stats).filter(value => value > 0)) * 2;
};
const loadSavePreferences = (fileName: string): Record<string, MachinePreferences> => {
    try {
        const saved = JSON.parse(localStorage.getItem(`${SAVE_PREFERENCES_KEY}${fileName}`) || '{}');
        return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    } catch {
        return {};
    }
};
const isRecycleProtected = (item: InventoryItem) => item.color === 'White' || item.color === 'Purple'
    || item.effects.includes('Learning Algorithm')
    || item.displayName.includes('Alarm Module') || item.displayName.includes('Junk Processing') || item.displayName.includes('Blast Module');

const moveGroup = (item: InventoryItem) => JSON.stringify([
    item.shape, item.color, item.displayName, item.effects, item.effectValues, item.moduleType, item.optimizable
]);

const placementsFromBoard = (board: (InventoryItem | 'Locked' | null)[][], locationId: string, locationName: string, interchangeable = true): MovePlacement[] => {
    const cells = new Map<string, { occupied: number[]; item: InventoryItem }>();
    board.forEach((row, y) => row.forEach((cell, x) => {
        if (!cell || cell === 'Locked') return;
        const placed = cells.get(cell.id) || { occupied: [], item: cell };
        placed.occupied.push(y * 7 + x);
        cells.set(cell.id, placed);
    }));
    return [...cells].map(([moduleId, placed]) => ({
        moduleId, locationId, locationName, cells: placed.occupied, columns: 7,
        interchangeableGroup: interchangeable ? moveGroup(placed.item) : undefined
    }));
};

// offload mouse tracking to useRef; performance
const DragGhost = ({ dragState, cellSize }: { dragState: DragState, cellSize: number }) => {
    const ghostRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!dragState) return;
        const onMove = (e: MouseEvent) => {
            if (ghostRef.current) {
                ghostRef.current.style.left = `${e.clientX - (dragState.dragOffsetX * cellSize) - (cellSize / 2)}px`;
                ghostRef.current.style.top = `${e.clientY - (dragState.dragOffsetY * cellSize) - (cellSize / 2)}px`;
            }
        };
        window.addEventListener('mousemove', onMove);
        return () => window.removeEventListener('mousemove', onMove);
    }, [dragState, cellSize]);

    return (
        <div ref={ghostRef} style={{
            position: 'fixed',
            pointerEvents: 'none',
            zIndex: 9999,
            left: `${dragState.initialMouseX - (dragState.dragOffsetX * cellSize) - (cellSize / 2)}px`,
            top: `${dragState.initialMouseY - (dragState.dragOffsetY * cellSize) - (cellSize / 2)}px`
        }}>
            {dragState.offsets.map((pt: Point, idx: number) => (
                <div key={idx} style={{
                    position: 'absolute',
                    top: pt.y * cellSize,
                    left: pt.x * cellSize,
                    width: `${cellSize}px`,
                    height: `${cellSize}px`,
                    backgroundColor: COLOR_MAP[dragState.item.color as ModuleColor],
                    border: '2px solid rgba(0,0,0,0.5)',
                    boxSizing: 'border-box'
                }} />
            ))}
        </div>
    );
};

const InventoryItemRow = React.memo(({ item, isAnySolving, updateItemEffect, updateItemEffectValue, handleBlurEffectValue, onRemove, onDragStart, onToggleInfinite, onToggleLock, readOnly = false }: InventoryItemRowProps) => {
    return (
        <div
            onMouseDown={(e) => item.optimizable !== false && !item.isLocked && onDragStart(e, item)}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', backgroundColor: '#252526', borderRadius: '4px', borderLeft: `4px solid ${COLOR_MAP[item.color as ModuleColor]}`, cursor: isAnySolving ? 'default' : item.optimizable === false || item.isLocked ? 'not-allowed' : 'grab', opacity: item.isLocked ? 0.65 : 1 }}
        >
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', width: '100%' }}>
                <MiniShape shape={item.shape} colorHex={COLOR_MAP[item.color as ModuleColor]} size="10px" />

                <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: '4px', pointerEvents: 'none' }}>
                    <span style={{ fontSize: '0.9em', fontWeight: 'bold', color: '#eee' }}>{item.displayName}</span>
                    {item.optimizable === false && <span style={{ fontSize: '0.7em', color: '#999' }}>Unavailable to optimizer</span>}

                    {item.shape !== 'Node1x2' ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', width: '100%', pointerEvents: 'auto' }}>
                            {[0, 1].map((effectIdx) => {
                                const currentEffect = item.effects[effectIdx];
                                const showCustomInput = currentEffect === 'Learning Algorithm' || currentEffect === 'Degrading';

                                return (
                                    <div key={effectIdx} style={{ display: 'flex', gap: '6px', alignItems: 'center', width: '100%' }} onMouseDown={(e) => e.stopPropagation()}>
                                        <select
                                            value={currentEffect}
                                            onChange={(e) => updateItemEffect(item, effectIdx as 0 | 1, e.target.value as ItemEffect)}
                                            disabled={readOnly}
                                            style={{ flex: 1, padding: '2px', fontSize: '0.7em', backgroundColor: '#111', color: '#eee', border: '1px solid #444', borderRadius: '3px', minWidth: '0' }}
                                        >
                                            {EFFECTS_LIST.filter(eff => eff === 'None' || eff !== item.effects[effectIdx === 0 ? 1 : 0]).map(eff => (
                                                <option key={eff} value={eff}>{eff === 'None' ? 'No Effect' : eff}</option>
                                            ))}
                                        </select>

                                        {showCustomInput && (
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }} title="Custom Percentage Value">
                                                <input
                                                    type="number"
                                                    value={item.effectValues[effectIdx]}
                                                    onChange={(e) => updateItemEffectValue(item.id, effectIdx as 0 | 1, Number(e.target.value))}
                                                    onBlur={(e) => handleBlurEffectValue(item, effectIdx as 0 | 1, Number(e.target.value))}
                                                    disabled={readOnly}
                                                    style={{ width: '48px', padding: '1px', fontSize: '0.7em', backgroundColor: '#111', color: '#eee', border: '1px solid #444', borderRadius: '3px', textAlign: 'center' }}
                                                />
                                                <span style={{ fontSize: '0.65em', color: '#aaa' }}>%</span>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    ) : !readOnly && (
                        <div style={{ display: 'flex', alignItems: 'center', width: '100%', pointerEvents: 'auto' }} onMouseDown={(e) => e.stopPropagation()}>
                            <label style={{ fontSize: '0.75em', color: '#ccc', display: 'flex', alignItems: 'center', gap: '6px', cursor: isAnySolving ? 'not-allowed' : 'pointer' }}>
                                <input
                                    type="checkbox"
                                    checked={!!item.isInfinite}
                                    onChange={(e) => onToggleInfinite && onToggleInfinite(e.target.checked)}
                                    disabled={isAnySolving}
                                    style={{ margin: 0, cursor: isAnySolving ? 'not-allowed' : 'pointer' }}
                                />
                                Infinite Nodes
                            </label>
                        </div>
                    )}
                </div>
            </div>
            {!readOnly && (
                <div onMouseDown={(e) => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', gap: '6px', marginLeft: '10px' }}>
                    <button onClick={() => onToggleLock(item.id)} disabled={isAnySolving} style={{ padding: '4px 7px', border: `1px solid ${item.isLocked ? '#ff6b6b' : '#555'}`, borderRadius: '4px', background: item.isLocked ? '#4a2020' : '#292929', color: item.isLocked ? '#ff8a8a' : '#bbb', cursor: isAnySolving ? 'not-allowed' : 'pointer' }}>{item.isLocked ? 'Unlock' : 'Lock'}</button>
                    <button onClick={() => onRemove(item.id)} disabled={isAnySolving} style={{ background: 'none', border: 'none', color: isAnySolving ? '#444' : '#666', cursor: isAnySolving ? 'not-allowed' : 'pointer', fontSize: '1.2em' }}>&times;</button>
                </div>
            )}
        </div>
    );
});

const MachineInstance = React.memo(forwardRef<MachineHandle, MachineInstanceProps>(({
                                                   machineId,
                                                   inventory,
                                                   setInventory,
                                                   getUsedItems,
                                                   initialTier,
                                                   initialMax,
                                                   initialBoard,
                                                   machineName,
                                                   machineLocation,
                                                   machineModuleType,
                                                   furnaceModules,
                                                   onFurnaceModulesChange,
                                                   alarmModule,
                                                   onAlarmModuleChange,
                                                   mode,
                                                   onModeChange,
                                                   onPreferencesChange,
                                                   imported,
                                                   initialTarget,
                                                   initialPriority,
                                                   dragState,
                                                   setHoverInfo,
                                                   onDuplicate,
                                                   onDelete,
                                                   cellSize,
                                                   onSolvingChange,
                                                   onDragTargetRefChange,
                                                   onLocateModule,
                                                   onOptimizeMachine,
                                                   onClearMachine,
                                                   moduleAssignments,
                                                   assignmentMachines,
                                                   isAnySolving,
                                                   canDelete,
                                                   optimizationSeconds
                                               }, ref) => {
    const [machineType, setMachineType] = useState('Select Machine...');
    const effectiveModuleType = machineModuleType || (machineType === 'Furnace' ? 'MODULE_TYPE_FURNACE' : machineType === 'Alarm System' ? 'MODULE_TYPE_ALARM' : undefined);
    const displayedMachineLocation = machineLocation?.replace(/^Shop Inventory\s*→\s*/, '');
    const optimizer = useOptimizer(inventory, setInventory, machineId, getUsedItems, initialTier, initialMax, initialTarget || { Performance: null, Quality: null, Efficiency: null }, initialPriority, initialBoard, effectiveModuleType, furnaceModules, alarmModule, optimizationSeconds === 0 ? Number.POSITIVE_INFINITY : optimizationSeconds * 1000, imported ? undefined : `optimizer_machine_${machineId}`);
    const [localHover, setLocalHover] = useState<(Point & { dragStartX: number; dragStartY: number }) | null>(null);
    const canOptimize = mode === 'optimize';

    useImperativeHandle(ref, () => ({
        run: optimizer.runOptimization,
        stop: optimizer.stopOptimization,
        clear: optimizer.resetBoard,
        place: optimizer.manuallyPlaceItem,
        remove: optimizer.manuallyRemoveItem,
        getState: () => ({
            tier: optimizer.tier,
            maximizeStats: optimizer.maximizeStats,
            targetStats: optimizer.targetStats,
            statPriority: optimizer.statPriority,
            mode,
            moduleType: effectiveModuleType,
            furnaceModules,
            alarmModule
        }),
        isValidPlacement: optimizer.isValidPlacement,
        getBoard: () => optimizer.boardRef.current,
        applyUpdate: optimizer.applyUpdate
    }), [optimizer, mode, effectiveModuleType, furnaceModules, alarmModule]);

    useEffect(() => {
        if (!imported) return;
        onPreferencesChange(machineId, {
            tier: optimizer.tier,
            maximizeStats: optimizer.maximizeStats,
            targetStats: optimizer.targetStats,
            statPriority: optimizer.statPriority,
            furnaceModules,
            alarmModule,
            mode
        });
    }, [imported, machineId, optimizer.tier, optimizer.maximizeStats, optimizer.targetStats, optimizer.statPriority, furnaceModules, alarmModule, mode, onPreferencesChange]);

    useEffect(() => {
        onSolvingChange(machineId, optimizer.isSolving);
    }, [optimizer.isSolving, machineId, onSolvingChange]);

    const getCellStyles = (x: number, y: number, cell: Board[number][number]) : React.CSSProperties => {
        const outerShadows = [];
        if (y === 0) outerShadows.push('inset 0 4px 0 #000');
        if (y === 4) outerShadows.push('inset 0 -4px 0 #000');
        if (x === 0) outerShadows.push('inset 4px 0 0 #000');
        if (x === 6) outerShadows.push('inset -4px 0 0 #000');
        if (cell === 'Locked') {
            return { backgroundColor: '#111', border: 'none', boxShadow: outerShadows.join(', ') || 'none' };
        }
        if (!cell) {
            return { backgroundColor: '#2a2a2a', border: 'none', boxShadow: ['inset 0 0 0 2px #000', ...outerShadows].join(', ') };
        }

        const isSame = (nx: number, ny: number) => {
            if (nx < 0 || nx >= 7 || ny < 0 || ny >= 5) return false;
            const adj = optimizer.board[ny][nx];
            return adj && adj !== 'Locked' && (adj as InventoryItem).id === cell.id;
        };

        const bgColor = COLOR_MAP[cell.color as ModuleColor];
        const shadows: string[] = [];

        if (!isSame(x, y - 1)) shadows.push('inset 0 2px 0 #000');
        if (!isSame(x, y + 1)) shadows.push('inset 0 -2px 0 #000');
        if (!isSame(x - 1, y)) shadows.push('inset 2px 0 0 #000');
        if (!isSame(x + 1, y)) shadows.push('inset -2px 0 0 #000');
        shadows.push(...outerShadows);

        const bgImages: string[] = [];
        const bgPositions: string[] = [];
        const bgSizes: string[] = [];

        if (isSame(x + 1, y) && isSame(x, y + 1) && !isSame(x + 1, y + 1)) {
            bgImages.push('linear-gradient(90deg, #000, #000)');
            bgPositions.push('bottom right');
            bgSizes.push('2px 2px');
        }
        if (isSame(x - 1, y) && isSame(x, y + 1) && !isSame(x - 1, y + 1)) {
            bgImages.push('linear-gradient(90deg, #000, #000)');
            bgPositions.push('bottom left');
            bgSizes.push('2px 2px');
        }
        if (isSame(x + 1, y) && isSame(x, y - 1) && !isSame(x + 1, y - 1)) {
            bgImages.push('linear-gradient(90deg, #000, #000)');
            bgPositions.push('top right');
            bgSizes.push('2px 2px');
        }
        if (isSame(x - 1, y) && isSame(x, y - 1) && !isSame(x - 1, y - 1)) {
            bgImages.push('linear-gradient(90deg, #000, #000)');
            bgPositions.push('top left');
            bgSizes.push('2px 2px');
        }

        return {
            backgroundColor: bgColor,
            border: 'none',
            boxShadow: shadows.join(', ') || 'none',
            backgroundImage: bgImages.length ? bgImages.join(', ') : 'none',
            backgroundPosition: bgPositions.length ? bgPositions.join(', ') : '0 0',
            backgroundSize: bgSizes.length ? bgSizes.join(', ') : 'auto',
            backgroundRepeat: bgImages.length ? 'no-repeat' : 'repeat'
        };
    };

    const getBoardFootprint = (itemId: string) => {
        const cells: Point[] = [];
        for (let y = 0; y < 5; y++) {
            for (let x = 0; x < 7; x++) {
                const cell = optimizer.board[y][x];
                if (cell && cell !== 'Locked' && cell.id === itemId) cells.push({ x, y });
            }
        }
        if (cells.length === 0) return null;
        const minX = Math.min(...cells.map(p => p.x));
        const minY = Math.min(...cells.map(p => p.y));
        return { minX, minY, offsets: cells.map(p => ({ x: p.x - minX, y: p.y - minY })) };
    };

    const activeHover = dragState && localHover?.dragStartX === dragState.initialMouseX && localHover.dragStartY === dragState.initialMouseY
        ? localHover
        : dragState?.sourceMachineId === machineId ? dragState.initialTarget : null;
    const isTargetingThis = Boolean(dragState && activeHover);
    const previewRootX = dragState && activeHover ? activeHover.x - dragState.dragOffsetX : null;
    const previewRootY = dragState && activeHover ? activeHover.y - dragState.dragOffsetY : null;

    const currentPreviewValid = dragState && isTargetingThis && previewRootX !== null && previewRootY !== null
        ? optimizer.isValidPlacement(dragState.item, previewRootX, previewRootY, dragState.offsets)
        : false;

    return (
        <div style={{
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            backgroundColor: '#111',
            border: `1px solid ${mode === 'optimize' ? '#4caf50' : mode === 'donate' ? '#d9a441' : '#333'}`,
            borderRadius: '8px',
            padding: '15px',
            width: `${cellSize * 7 + 50}px`,
            boxSizing: 'border-box'
        }}>

            {canDelete && (
                <button
                    onClick={() => onDelete(machineId)}
                    disabled={optimizer.isSolving || isAnySolving}
                    style={{
                        position: 'absolute',
                        top: '8px',
                        right: '10px',
                        background: 'none',
                        border: 'none',
                        color: (optimizer.isSolving || isAnySolving) ? '#444' : '#666',
                        cursor: (optimizer.isSolving || isAnySolving) ? 'not-allowed' : 'pointer',
                        fontSize: '1.2em',
                        padding: '0',
                        zIndex: 10
                    }}
                    title="Delete Machine"
                >
                    &times;
                </button>
            )}

            <div style={{ width: '100%', marginBottom: '10px' }}>
                {imported ? (
                    <div style={{ fontWeight: 'bold', color: '#eee' }}>{machineName}</div>
                ) : (
                    <select
                        value={machineType}
                        onChange={(event) => setMachineType(event.target.value)}
                        disabled={optimizer.isSolving || isAnySolving}
                        style={{ width: '100%', padding: '6px 8px', backgroundColor: '#222', color: '#eee', border: '1px solid #333', borderRadius: '6px', fontSize: '0.85em' }}
                    >
                        <option value="Select Machine..." disabled>Select Machine...</option>
                        <option value="Moisture Farm">Moisture Farm</option>
                        <option value="Furnace">Furnace</option>
                        <option value="Water Purifier">Water Purifier</option>
                        <option value="Alarm System">Alarm System</option>
                        <option value="AgeWell">AgeWell</option>
                        <option value="Cryptographic Desequencer">Cryptographic Desequencer</option>
                        <option value="Mirage Projector">Mirage Projector</option>
                    </select>
                )}
                {displayedMachineLocation && <div style={{ color: '#888', fontSize: '0.72em', margin: '3px 0 7px' }}>{displayedMachineLocation}</div>}
                <div style={{ display: 'flex', gap: '4px', width: '100%' }}>
                    {([
                        ['optimize', '⚙️ Optimize', 'Optimize'],
                        ['donate', '📤 Donate', 'Donate modules'],
                        ['ignore', '🔒 Ignore', 'Ignore']
                    ] as const).map(([value, icon, label]) => (
                        <button
                            key={value}
                            type="button"
                            aria-label={label}
                            aria-pressed={mode === value}
                            title={label}
                            onClick={() => onModeChange(machineId, value as MachineMode)}
                            disabled={isAnySolving}
                            style={{
                                flex: 1,
                                minWidth: 0,
                                height: '30px',
                                padding: '0 4px',
                                backgroundColor: mode === value ? '#505050' : '#222',
                                color: '#eee',
                                border: `1px solid ${mode === value ? '#aaa' : '#444'}`,
                                borderRadius: '5px',
                                cursor: isAnySolving ? 'not-allowed' : 'pointer',
                                fontSize: '0.72em',
                                whiteSpace: 'nowrap'
                            }}
                        >
                            {icon}
                        </button>
                    ))}
                </div>
                <div style={{ color: '#777', fontSize: '0.68em', marginTop: '4px' }}>
                    {mode === 'optimize' && 'Optimized; can receive modules.'}
                    {mode === 'donate' && 'Not optimized; its modules may be used elsewhere.'}
                    {mode === 'ignore' && 'Ignored; board and modules stay untouched.'}
                </div>
                <div style={{ height: '29px', marginTop: '5px' }}>
                    {effectiveModuleType === 'MODULE_TYPE_FURNACE' && (
                        <select
                            aria-label="Furnace special module"
                            value={furnaceModules || 'none'}
                            onChange={(event) => onFurnaceModulesChange(machineId, event.target.value as FurnaceModules)}
                            disabled={isAnySolving}
                            style={{ width: '100%', height: '29px', padding: '5px', backgroundColor: '#222', color: '#eee', border: '1px solid #444', borderRadius: '5px' }}
                        >
                            <option value="none">No Junk or Blast module</option>
                            <option value="junk">Junk Processing</option>
                            <option value="blast">Blast Module</option>
                            <option value="both">Junk Processing + Blast</option>
                        </select>
                    )}
                    {effectiveModuleType === 'MODULE_TYPE_ALARM' && (
                        <select
                            aria-label="Alarm module"
                            value={alarmModule ? 'yes' : 'no'}
                            onChange={(event) => onAlarmModuleChange(machineId, event.target.value === 'yes')}
                            disabled={isAnySolving}
                            style={{ width: '100%', height: '29px', padding: '5px', backgroundColor: '#222', color: '#eee', border: '1px solid #444', borderRadius: '5px' }}
                        >
                            <option value="no">No Alarm Module</option>
                            <option value="yes">Use Alarm Module</option>
                        </select>
                    )}
                </div>
            </div>

            <div className="stats-header" style={{ width: '100%', boxSizing: 'border-box', marginBottom: '10px', padding: '10px 15px', gap: '10px', justifyContent: 'space-around' }}>
                <div style={{ textAlign: 'center' }}>
                    <span style={{ color: '#aaa', fontSize: '0.7em', textTransform: 'uppercase' }}>Performance</span>
                    <div style={{ fontSize: '1.4em', fontWeight: 'bold', color: getStatColor(optimizer.bestTotals.Performance) }}>
                        {formatStatValue(optimizer.bestTotals.Performance)}
                    </div>
                </div>
                <div style={{ textAlign: 'center' }}>
                    <span style={{ color: '#aaa', fontSize: '0.7em', textTransform: 'uppercase' }}>Quality</span>
                    <div style={{ fontSize: '1.4em', fontWeight: 'bold', color: getStatColor(optimizer.bestTotals.Quality) }}>
                        {formatStatValue(optimizer.bestTotals.Quality)}
                    </div>
                </div>
                <div style={{ textAlign: 'center' }}>
                    <span style={{ color: '#aaa', fontSize: '0.7em', textTransform: 'uppercase' }}>Efficiency</span>
                    <div style={{ fontSize: '1.4em', fontWeight: 'bold', color: getStatColor(optimizer.bestTotals.Efficiency) }}>
                        {formatStatValue(optimizer.bestTotals.Efficiency)}
                    </div>
                </div>
            </div>

            <div
                className="grid-wrapper"
                onMouseLeave={() => {
                    if (dragState) {
                        setLocalHover(null);
                        onDragTargetRefChange(null);
                    }
                }}
                style={{
                    gridTemplateColumns: `repeat(7, ${cellSize}px)`,
                    gridTemplateRows: `repeat(5, ${cellSize}px)`
                }}
            >
                {optimizer.board.map((row, y) =>
                    row.map((cell, x) => {
                        let isPreviewCell = false;

                        if (isTargetingThis && previewRootX !== null && previewRootY !== null) {
                            for (const pt of dragState?.offsets || []) {
                                if (previewRootX + pt.x === x && previewRootY + pt.y === y) {
                                    isPreviewCell = true;
                                    break;
                                }
                            }
                        }

                        const isBeingDragged = dragState && dragState.sourceMachineId === machineId && cell && cell !== 'Locked' && dragState.item.id === cell.id;
                        const showModuleLabel = cell && cell !== 'Locked' && !optimizer.board.some((boardRow, boardY) =>
                            boardY < y && boardRow.some(boardCell => boardCell && boardCell !== 'Locked' && boardCell.id === cell.id)
                        ) && !row.slice(0, x).some(boardCell => boardCell && boardCell !== 'Locked' && boardCell.id === cell.id);
                        const labelFootprint = showModuleLabel ? getBoardFootprint(cell.id) : null;
                        const labelArea = labelFootprint ? getModuleLabelArea(labelFootprint.offsets) : null;
                        const verticalLabel = Boolean(labelArea && labelArea.height > labelArea.width);
                        const assignmentTarget = showModuleLabel ? moduleAssignments[cell.id] : undefined;
                        const assignmentName = assignmentTarget === RESERVED_ASSIGNMENT ? 'OUT' : assignmentMachines.find(machine => machine.id === assignmentTarget)?.name;
                        const assignmentBadge = assignmentName && cell && cell !== 'Locked' && getModuleLabel(cell.displayName) !== 'Node' ? (assignmentName === 'OUT' ? assignmentName : getMachineAbbreviation(assignmentName)) : undefined;

                        return (
                            <div
                                key={`${x}-${y}`}
                                onMouseMove={(e) => {
                                    if (cell && cell !== 'Locked' && !dragState) {
                                        setHoverInfo({ x: e.clientX, y: e.clientY, cell, stats: optimizer.bestPieceStats.get(cell.id) });
                                    }
                                }}
                                onMouseLeave={() => setHoverInfo(null)}
                                onMouseDown={(e) => {
                                    if (!cell || cell === 'Locked') return;
                                    onLocateModule(cell.id);
                                    if (optimizer.isSolving || isAnySolving) return;
                                    e.preventDefault();
                                    const footprint = getBoardFootprint(cell.id);
                                    if (!footprint) return;

                                    setHoverInfo(null);

                                    // prevent cursor being outside the grid when placing module by having the cursor drag modules from the center-most square (center of mass)
                                    const avgX = footprint.offsets.reduce((sum: number, p: Point) => sum + p.x, 0) / footprint.offsets.length;
                                    const avgY = footprint.offsets.reduce((sum: number, p: Point) => sum + p.y, 0) / footprint.offsets.length;

                                    let pivot = footprint.offsets[0];
                                    let minDist = Infinity;
                                    for (const p of footprint.offsets) {
                                        const dist = (p.x - avgX) ** 2 + (p.y - avgY) ** 2;
                                        if (dist < minDist) {
                                            minDist = dist;
                                            pivot = p;
                                        }
                                    }

                                    const dragOffsetX = pivot.x;
                                    const dragOffsetY = pivot.y;

                                    const initialTarget = {
                                        machineId,
                                        x: footprint.minX + dragOffsetX,
                                        y: footprint.minY + dragOffsetY
                                    };

                                    const evt = new CustomEvent('appDragStart', {
                                        detail: {
                                            item: cell,
                                            sourceMachineId: machineId,
                                            offsets: footprint.offsets,
                                            dragOffsetX,
                                            dragOffsetY,
                                            initialMouseX: e.clientX,
                                            initialMouseY: e.clientY,
                                            initialTarget
                                        }
                                    });
                                    window.dispatchEvent(evt);
                                }}
                                onMouseEnter={() => {
                                    if (dragState) {
                                        setLocalHover({ x, y, dragStartX: dragState.initialMouseX, dragStartY: dragState.initialMouseY });
                                        onDragTargetRefChange({ machineId, x, y });
                                    }
                                }}
                                style={{
                                    width: `${cellSize}px`,
                                    height: `${cellSize}px`,
                                    ...getCellStyles(x, y, cell),
                                    opacity: isBeingDragged ? 0.3 : 1,
                                    cursor: cell && cell !== 'Locked' ? ((optimizer.isSolving || isAnySolving) ? 'not-allowed' : 'grab') : 'default',
                                    boxSizing: 'border-box',
                                    position: 'relative'
                                }}
                            >
                                {showModuleLabel && (
                                    <span style={{
                                        position: 'absolute',
                                        left: `${(labelFootprint!.minX + labelArea!.x - x) * cellSize + 2}px`,
                                        top: `${(labelFootprint!.minY + labelArea!.y - y) * cellSize + 2}px`,
                                        width: `${labelArea!.width * cellSize - 4}px`,
                                        height: `${labelArea!.height * cellSize - 4 - (assignmentBadge ? 15 : 0)}px`,
                                        zIndex: 2,
                                        display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
                                        color: '#fff', fontSize: `${Math.max(12, cellSize * 0.48)}px`, fontWeight: 'bold', lineHeight: 1,
                                        textAlign: 'center', writingMode: verticalLabel ? 'vertical-rl' : 'horizontal-tb', textOrientation: 'mixed',
                                        textShadow: '0 1px 3px #000, 0 1px 3px #000', pointerEvents: 'none'
                                    }}>
                                        {getModuleLabel(cell.displayName)}
                                    </span>
                                )}
                                {showModuleLabel && assignmentBadge && <span style={{
                                    position: 'absolute',
                                    left: `${(labelFootprint!.minX + labelArea!.x - x + labelArea!.width / 2) * cellSize}px`,
                                    top: `${(labelFootprint!.minY + labelArea!.y - y + labelArea!.height) * cellSize - 18}px`,
                                    transform: 'translateX(-50%)',
                                    zIndex: 3,
                                    width: 'max-content',
                                    maxWidth: `${labelArea!.width * cellSize - 4}px`,
                                    height: '14px',
                                    overflow: 'hidden',
                                    padding: '0 3px',
                                    border: '1px solid #ff8ae8',
                                    borderRadius: '3px',
                                    backgroundColor: '#a00078',
                                    color: '#fff',
                                    fontSize: '10px',
                                    fontWeight: 800,
                                    lineHeight: '12px',
                                    whiteSpace: 'nowrap',
                                    pointerEvents: 'none'
                                }}>{assignmentBadge}</span>}
                                {isPreviewCell && (
                                    <div style={{
                                        position: 'absolute', inset: 0,
                                        backgroundColor: currentPreviewValid ? 'rgba(20, 80, 20, 0.85)' : 'rgba(80, 20, 20, 0.85)',
                                        border: currentPreviewValid ? '2px solid rgba(100, 255, 100, 0.5)' : '2px solid rgba(255, 100, 100, 0.5)',
                                        zIndex: 10, pointerEvents: 'none'
                                    }} />
                                )}
                            </div>
                        );
                    })
                )}
            </div>

            <div style={{ minHeight: '18px', marginTop: '5px', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%' }}>
                {optimizer.warningMsg && (
                    <span style={{ color: '#ff4d4d', fontSize: '0.75em', textAlign: 'center', width: '100%' }}>
                        ⚠ {optimizer.warningMsg}
                    </span>
                )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%', boxSizing: 'border-box' }}>
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                    <div style={{ display: 'flex', gap: '5px', backgroundColor: '#222', padding: '5px', borderRadius: '6px' }}>
                        {[1, 2, 3].map((t) => (
                            <button key={t} onClick={() => optimizer.handleTierChange(t as GridTier)} disabled={imported || !canOptimize || optimizer.isSolving || isAnySolving} style={{ padding: '6px 12px', fontSize: '0.85em', backgroundColor: optimizer.tier === t ? '#555' : 'transparent', color: 'white', border: 'none', borderRadius: '4px', cursor: (imported || !canOptimize || optimizer.isSolving || isAnySolving) ? 'not-allowed' : 'pointer' }}>
                                Tier {t}
                            </button>
                        ))}
                    </div>
                </div>

                <div style={{ display: 'flex', gap: '5px', backgroundColor: '#222', padding: '6px 8px', borderRadius: '6px', border: '1px solid #333', justifyContent: 'space-between', width: '100%', boxSizing: 'border-box' }}>
                    {(['Performance', 'Quality', 'Efficiency'] as const).map((stat, idx) => (
                        <div key={stat} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', flex: 1, borderRight: idx < 2 ? '1px solid #444' : 'none' }}>
                            <span style={{ fontSize: '0.6em', color: '#aaa', textTransform: 'uppercase', fontWeight: 'bold', textAlign: 'center' }}>{stat}</span>
                            <label style={{ fontSize: '0.7em', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                <input type="checkbox" checked={optimizer.maximizeStats[stat]}
                                    onChange={() => optimizer.setMaximizeStats(prev => ({ ...prev, [stat]: !prev[stat] }))}
                                    disabled={!canOptimize || optimizer.isSolving || isAnySolving} /> Max
                            </label>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '2px' }}>
                                <span style={{ fontSize: '0.65em', color: '#888' }}>Tar:</span>
                                <input
                                    type="number"
                                    value={optimizer.targetStats[stat] ?? ''}
                                    onChange={(e) => optimizer.setTargetStats(prev => ({ ...prev, [stat]: e.target.value === '' ? null : Number(e.target.value) }))}
                                    disabled={!canOptimize || optimizer.isSolving || isAnySolving}
                                    style={{ width: '35px', padding: '2px', fontSize: '0.7em', backgroundColor: '#111', color: '#eee', border: '1px solid #444', borderRadius: '3px', textAlign: 'center' }}
                                />
                                <span style={{ fontSize: '0.65em', color: '#888' }}>%</span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                                <span style={{ fontSize: '0.65em', color: '#888' }}>Pri:</span>
                                <select title={`Priority for ${stat}. Priority 1 matters most. Stats sharing a priority are traded against each other. A lower priority is considered only after every higher priority is as good as possible, so a satisfied target is not sacrificed for a less important stat.`} value={optimizer.statPriority[stat]}
                                    onChange={event => optimizer.setStatPriority(prev => ({ ...prev, [stat]: Number(event.target.value) }))}
                                    disabled={!canOptimize || optimizer.isSolving || isAnySolving}
                                    style={{ padding: '1px', fontSize: '0.7em', backgroundColor: '#111', color: '#eee', border: '1px solid #444', borderRadius: '3px' }}>
                                    <option value={1}>1</option><option value={2}>2</option><option value={3}>3</option>
                                </select>
                            </div>
                        </div>
                    ))}
                </div>

                {!imported && <div style={{ display: 'flex', gap: '5px', width: '100%' }}>
                    <button
                        onClick={optimizer.isSolving ? optimizer.stopOptimization : optimizer.runOptimization}
                        disabled={!canOptimize || (inventory.length === 0 && !optimizer.isSolving) || (!optimizer.isSolving && isAnySolving)}
                        style={{
                            flex: 2,
                            padding: '8px',
                            fontSize: '0.85em',
                            backgroundColor: optimizer.isSolving ? '#ff4d4d' : '#4caf50',
                            color: 'white',
                            border: 'none',
                            borderRadius: '6px',
                            fontWeight: 'bold',
                            cursor: ((inventory.length === 0 && !optimizer.isSolving) || (!optimizer.isSolving && isAnySolving)) ? 'not-allowed' : 'pointer',
                            opacity: ((inventory.length === 0 && !optimizer.isSolving) || (!optimizer.isSolving && isAnySolving)) ? 0.5 : 1
                        }}
                    >
                        {optimizer.isSolving ? 'Stop Optimizer' : 'Run Optimizer'}
                    </button>
                    <button
                        onClick={optimizer.resetBoard}
                        disabled={!canOptimize || optimizer.isSolving || isAnySolving}
                        style={{ flex: 1, padding: '8px', fontSize: '0.85em', backgroundColor: '#333', color: 'white', border: '1px solid #555', borderRadius: '6px', cursor: (optimizer.isSolving || isAnySolving) ? 'not-allowed' : 'pointer' }}
                    >
                        Clear
                    </button>
                    <button
                        onClick={() => onDuplicate(machineId)}
                        disabled={optimizer.isSolving || isAnySolving}
                        style={{ flex: 1, padding: '8px', fontSize: '0.85em', backgroundColor: '#333', color: 'white', border: '1px solid #555', borderRadius: '6px', cursor: (optimizer.isSolving || isAnySolving) ? 'not-allowed' : 'pointer' }}
                    >
                        Duplicate
                    </button>
                </div>}

                {imported && <div style={{ display: 'flex', gap: '5px', width: '100%' }}>
                    <button
                        onClick={() => onOptimizeMachine(machineId)}
                        disabled={optimizer.isSolving || isAnySolving || inventory.length === 0}
                        style={{ flex: 2, padding: '8px', fontSize: '0.85em', backgroundColor: '#4caf50', color: 'white', border: 'none', borderRadius: '6px', fontWeight: 'bold', cursor: (optimizer.isSolving || isAnySolving || inventory.length === 0) ? 'not-allowed' : 'pointer', opacity: (optimizer.isSolving || isAnySolving || inventory.length === 0) ? 0.5 : 1 }}
                    >
                        Optimize Machine
                    </button>
                    <button
                        onClick={() => onClearMachine(machineId)}
                        disabled={optimizer.isSolving || isAnySolving}
                        style={{ flex: 1, padding: '8px', fontSize: '0.85em', backgroundColor: '#333', color: 'white', border: '1px solid #555', borderRadius: '6px', cursor: (optimizer.isSolving || isAnySolving) ? 'not-allowed' : 'pointer' }}
                    >
                        Clear
                    </button>
                </div>}

                <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', width: '100%' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                        <span style={{ fontSize: '0.75em', color: '#888' }}>Code:</span>
                        <input
                            type="text"
                            value={optimizer.solutionCode}
                            onChange={(e) => optimizer.setSolutionCode(e.target.value)}
                            readOnly={imported}
                            placeholder="Solution code..."
                            disabled={optimizer.isSolving || isAnySolving}
                            style={{ flex: 1, minWidth: 0, padding: '6px', fontSize: '0.75em', backgroundColor: '#111', color: '#eee', border: '1px solid #444', borderRadius: '4px' }}
                        />
                    </div>
                    <div style={{ display: 'flex', gap: '5px', width: '100%' }}>
                        {!imported && <button
                            onClick={() => optimizer.importSolution(optimizer.solutionCode)}
                            disabled={!optimizer.solutionCode || optimizer.isSolving || isAnySolving}
                            style={{ flex: 1, padding: '6px', fontSize: '0.8em', backgroundColor: '#333', color: 'white', border: '1px solid #555', borderRadius: '4px', cursor: (!optimizer.solutionCode || optimizer.isSolving || isAnySolving) ? 'not-allowed' : 'pointer' }}
                        >
                            Import
                        </button>}
                        <button
                            onClick={() => navigator.clipboard.writeText(optimizer.solutionCode)}
                            disabled={!optimizer.solutionCode}
                            style={{ flex: 1, padding: '6px', fontSize: '0.8em', backgroundColor: '#333', color: 'white', border: '1px solid #555', borderRadius: '4px', cursor: !optimizer.solutionCode ? 'not-allowed' : 'pointer' }}
                        >
                            Copy
                        </button>
                    </div>
                </div>

            </div>
        </div>
    );
}))

export default function ModuleInventoryUI() {
    const [inventory, setInventory] = useState<InventoryItem[]>(() => {
        const savedInventory = localStorage.getItem('optimizer_inventory');
        if (savedInventory) {
            try { return JSON.parse(savedInventory).filter((item: InventoryItem) => !item.source); } catch { return []; }
        }
        return [];
    });

    useEffect(() => {
        if (inventory.every(item => !item.source)) localStorage.setItem('optimizer_inventory', JSON.stringify(inventory));
    }, [inventory]);

    const [machines, setMachines] = useState<UiMachine[]>(() => {
        const fallback = [{ id: `m_${Math.random().toString(36).substring(2,8)}`, initialTier: 3 as GridTier, initialMax: { Performance: false, Quality: false, Efficiency: false }, mode: 'optimize' as MachineMode }];
        try {
            const saved = JSON.parse(localStorage.getItem('optimizer_machine_list') || 'null');
            const restored = Array.isArray(saved) ? saved.flatMap(entry => entry && typeof entry.id === 'string' ? [{ ...fallback[0], id: entry.id }] : []) : [];
            return restored.length ? restored : fallback;
        } catch { return fallback; }
    });
    const machinesRef = useRef<Record<string, MachineHandle>>({});
    const [solvingStates, setSolvingStates] = useState<Record<string, boolean>>({});
    const [importedFile, setImportedFile] = useState<string | null>(null);
    const [saveInventoryGrid, setSaveInventoryGrid] = useState<ImportedInventoryGrid | null>(null);
    const [importError, setImportError] = useState<string | null>(null);
    const [optimizationSeconds, setOptimizationSeconds] = useState(() => {
        const saved = localStorage.getItem(OPTIMIZATION_SECONDS_KEY);
        const seconds = saved === null ? 5 : Number(saved);
        return Number.isFinite(seconds) && seconds >= 0 ? seconds : 5;
    });
    const [unusedAfterOptimization, setUnusedAfterOptimization] = useState<Set<string> | null>(null);
    const [moduleDestinations, setModuleDestinations] = useState<Map<string, string>>(new Map());
    const [moduleAssignments, setModuleAssignments] = useState<Record<string, string>>({});
    const [movePlan, setMovePlan] = useState<MoveStep[] | null>(null);
    const [moveStepIndex, setMoveStepIndex] = useState(0);
    const [committedMoves, setCommittedMoves] = useState<MoveStep[]>([]);
    const saveHandleRef = useRef<SaveFileHandle | null>(null);
    const saveInputRef = useRef<HTMLInputElement>(null);
    const refreshSelectionRef = useRef(false);
    const importRevisionRef = useRef(0);

    useEffect(() => {
        if (!importedFile && machines.every(machine => !machine.imported)) localStorage.setItem('optimizer_machine_list', JSON.stringify(machines.map(({ id }) => ({ id }))));
    }, [importedFile, machines]);

    useEffect(() => {
        localStorage.setItem(OPTIMIZATION_SECONDS_KEY, String(optimizationSeconds));
    }, [optimizationSeconds]);

    useEffect(() => {
        if (importedFile) localStorage.setItem(`${SAVE_ASSIGNMENTS_KEY}${importedFile}`, JSON.stringify(moduleAssignments));
    }, [importedFile, moduleAssignments]);

    // shared pool
    const getUsedItems = useCallback((excludeId: string) => {
        const used = new Set<string>();
        Object.entries(machinesRef.current).forEach(([id, m]) => {
            if (id !== excludeId && m && m.getState().mode !== 'donate') {
                const board = m.getBoard();
                if (board) {
                    for (let y = 0; y < 5; y++) {
                        for (let x = 0; x < 7; x++) {
                            const cell = board[y][x];
                            if (cell && cell !== 'Locked') used.add(cell.id);
                        }
                    }
                }
            }
        });
        return used;
    }, []);

    const handleSaveImport = async (file?: File, preserveSettings = false) => {
        if (!file) return;
        try {
            const imported = importEs3Save(await file.text());
            setUnusedAfterOptimization(null);
            setModuleDestinations(new Map());
            setMovePlan(null);
            setMoveStepIndex(0);
            setCommittedMoves([]);
            const settings = new Map<string, MachinePreferences>(Object.entries(loadSavePreferences(file.name)));
            if (preserveSettings) {
                Object.entries(machinesRef.current).forEach(([id, machine]) => {
                    if (machine) settings.set(id, machine.getState());
                });
            }
            Object.values(machinesRef.current).forEach(machine => machine.stop());
            globalIsSolvingRef.current = false;
            machinesRef.current = {};
            setSolvingStates({});
            const revision = ++importRevisionRef.current;
            setInventory(imported.modules);
            setSaveInventoryGrid(imported.inventoryGrid);
            const validModules = new Set(imported.modules.map(module => module.id));
            const validMachines = new Set(imported.machines.map(machine => machine.id));
            let savedAssignments: Record<string, string> = {};
            try { savedAssignments = JSON.parse(localStorage.getItem(`${SAVE_ASSIGNMENTS_KEY}${file.name}`) || '{}'); } catch { /* ignore invalid saved preferences */ }
            setModuleAssignments(Object.fromEntries(Object.entries(savedAssignments).filter(([moduleId, target]) => validModules.has(moduleId) && (target === RESERVED_ASSIGNMENT || validMachines.has(target)))));
            setMachines(imported.machines.map(machine => {
                const previous = settings.get(machine.id);
                const savedNames = machine.board.flat().flatMap(cell => cell && cell !== 'Locked' ? [cell.displayName] : []);
                const hasJunk = savedNames.some(name => name.includes('Junk Processing'));
                const hasBlast = savedNames.some(name => name.includes('Blast Module'));
                const savedFurnaceModules: FurnaceModules = hasJunk && hasBlast ? 'both' : hasJunk ? 'junk' : hasBlast ? 'blast' : 'none';
                return {
                    id: machine.id,
                    initialTier: previous?.tier ?? machine.tier,
                    initialMax: previous?.maximizeStats ?? { Performance: false, Quality: false, Efficiency: false },
                    initialTarget: previous?.targetStats,
                    initialPriority: previous?.statPriority,
                    initialBoard: machine.board,
                    name: machine.name,
                    location: machine.location,
                    moduleType: machine.moduleType,
                    furnaceModules: previous?.furnaceModules ?? savedFurnaceModules,
                    alarmModule: previous?.alarmModule ?? savedNames.some(name => name.includes('Alarm Module')),
                    mode: previous?.mode ?? 'optimize',
                    imported: true,
                    revision
                };
            }));
            setImportedFile(file.name);
            setImportError(null);
        } catch (error) {
            setImportError(error instanceof Error ? error.message : 'Could not import this save.');
        }
    };

    const handleOpenSave = async () => {
        const picker = (window as Window & { showOpenFilePicker?: (options: object) => Promise<SaveFileHandle[]> }).showOpenFilePicker;
        if (!picker) {
            refreshSelectionRef.current = false;
            saveInputRef.current?.click();
            return;
        }
        try {
            const [handle] = await picker({
                multiple: false,
                types: [{ description: 'Probably Stolen save', accept: { 'application/octet-stream': ['.es3'] } }]
            });
            saveHandleRef.current = handle;
            const file = await handle.getFile();
            await handleSaveImport(file, file.name === importedFile);
        } catch (error) {
            if (!(error instanceof Error) || error.name !== 'AbortError') setImportError('Could not open this save.');
        }
    };

    const handleRefreshSave = async () => {
        const handle = saveHandleRef.current;
        if (!handle) {
            refreshSelectionRef.current = true;
            saveInputRef.current?.click();
            return;
        }
        try {
            await handleSaveImport(await handle.getFile(), true);
        } catch {
            setImportError('The save could not be refreshed. Import it again if the game replaced the file.');
        }
    };

    const handleModeChange = useCallback((machineId: string, mode: MachineMode) => {
        setMachines(current => current.map(machine => machine.id === machineId ? { ...machine, mode } : machine));
    }, []);

    const handleFurnaceModulesChange = useCallback((machineId: string, furnaceModules: FurnaceModules) => {
        setMachines(current => current.map(machine => machine.id === machineId ? { ...machine, furnaceModules } : machine));
    }, []);

    const handleAlarmModuleChange = useCallback((machineId: string, alarmModule: boolean) => {
        setMachines(current => current.map(machine => machine.id === machineId ? { ...machine, alarmModule } : machine));
    }, []);

    const handleModuleAssignmentChange = useCallback((moduleId: string, target: string) => {
        setModuleAssignments(current => {
            const next = { ...current };
            if (target) next[moduleId] = target;
            else delete next[moduleId];
            return next;
        });
        setUnusedAfterOptimization(null);
        setModuleDestinations(new Map());
    }, []);

    const handlePreferencesChange = useCallback((machineId: string, preferences: MachinePreferences) => {
        if (!importedFile) return;
        const saved = loadSavePreferences(importedFile);
        saved[machineId] = preferences;
        localStorage.setItem(`${SAVE_PREFERENCES_KEY}${importedFile}`, JSON.stringify(saved));
    }, [importedFile]);

    const [filterGroup, setFilterGroup] = useState<FilterGroup>('All');
    const [filterSize, setFilterSize] = useState<'All' | 3 | 4 | 5>('All');
    const [inventoryFilterGroup, setInventoryFilterGroup] = useState<FilterGroup | 'Placed'>('All');
    const [inventoryFilterSize, setInventoryFilterSize] = useState<'All' | 3 | 4 | 5>('All');
    const [inventoryFilterEffect, setInventoryFilterEffect] = useState<ItemEffect | 'All'>('All');
    const [placedModuleIds, setPlacedModuleIds] = useState<Set<string>>(new Set());
    const [hoverInfo, setHoverInfo] = useState<HoverInfo | null>(null);
    const [locatedModuleId, setLocatedModuleId] = useState<string | null>(null);

    const [dragState, setDragState] = useState<DragState | null>(null);

    const dragHoverTargetRef = useRef<DragTarget | null>(null);
    const setDragTargetRefChange = useCallback((target: DragTarget | null) => {
        dragHoverTargetRef.current = target;
    }, []);

    const expandedInventory = useMemo(() => inventory.flatMap(item => item.shape === 'Node1x2' && item.isInfinite
        ? [item, ...Array.from({ length: 17 * Math.max(1, machines.length) }, (_, index) => ({ ...item, id: `${item.id}_clone_${index}` }))]
        : [item]), [inventory, machines.length]);

    const hoveredItem = hoverInfo ? (expandedInventory.find(i => i.id === hoverInfo.cell.id) || hoverInfo.cell) : null;
    const locatedModule = locatedModuleId ? inventory.find(item => item.id === locatedModuleId) || null : null;
    const recycleReasons = new Map<string, string>();
    inventory.forEach(item => {
        if (isRecycleProtected(item)) return;
        if (!unusedAfterOptimization?.has(item.id)) return;
        if (item.displayName.includes('Ruined')) {
            recycleReasons.set(item.id, 'Ruined module: sell it or dismantle it with a screwdriver. It cannot be exchanged for another module.');
        } else if (hasStrongerSameShape(item, inventory, unusedAfterOptimization || undefined)) {
            recycleReasons.set(item.id, 'A stronger module with the same shape is available.');
        }
    });
    const hoveredRecycleReason = hoveredItem && hoverInfo?.showRecycleReason ? recycleReasons.get(hoveredItem.id) : undefined;
    const hoveredDestination = hoveredItem && hoverInfo?.showRecycleReason ? moduleDestinations.get(hoveredItem.id) : undefined;
    const hoveredAssignment = hoveredItem ? moduleAssignments[hoveredItem.id] : undefined;

    const dragRef = useRef(dragState);

    const isAnySolving = Object.values(solvingStates).some(s => s);
    const globalIsSolvingRef = useRef(false);

    useEffect(() => { dragRef.current = dragState; }, [dragState]);

    useEffect(() => {
        const handleAppDragStart = (e: CustomEvent<DragState>) => {
            setDragState(e.detail);
            if (e.detail.initialTarget) {
                dragHoverTargetRef.current = e.detail.initialTarget;
            }
        };
        window.addEventListener('appDragStart', handleAppDragStart as EventListener);
        return () => window.removeEventListener('appDragStart', handleAppDragStart as EventListener);
    }, []);

    useEffect(() => {
        if (!dragState) return;

        const handleMouseUp = () => {
            const currentDrag = dragRef.current;
            const currentTarget = dragHoverTargetRef.current;

            if (currentDrag) {
                if (!currentTarget || currentTarget.machineId === null) {
                    if (currentDrag.sourceMachineId !== null && !currentDrag.item.isLocked) {
                        machinesRef.current[currentDrag.sourceMachineId]?.remove(currentDrag.item.id);
                        if (importedFile && inventory.some(item => item.id === currentDrag.item.id)) handleModuleAssignmentChange(currentDrag.item.id, '');
                    }
                } else {
                    const machine = machinesRef.current[currentTarget.machineId];
                    const state = machine?.getState();
                    const compatible = !state?.moduleType || currentDrag.item.moduleType === 'MODULE_TYPE_UNIVERSAL' || currentDrag.item.moduleType === state.moduleType;
                    if (machine && compatible && (!currentDrag.item.isLocked || currentDrag.sourceMachineId === currentTarget.machineId)) {
                        const targetX = currentTarget.x - currentDrag.dragOffsetX;
                        const targetY = currentTarget.y - currentDrag.dragOffsetY;

                        if (machine.isValidPlacement(currentDrag.item, targetX, targetY, currentDrag.offsets)) {
                            Object.keys(machinesRef.current).forEach(mId => {
                                if (mId !== currentTarget.machineId) {
                                    machinesRef.current[mId]?.remove(currentDrag.item.id);
                                }
                            });
                            machine.place(currentDrag.item, targetX, targetY, currentDrag.offsets);
                            if (importedFile && currentDrag.sourceMachineId !== currentTarget.machineId && inventory.some(item => item.id === currentDrag.item.id)) {
                                handleModuleAssignmentChange(currentDrag.item.id, currentTarget.machineId);
                            }
                        }
                    }
                }
            }
            setDragState(null);
            dragHoverTargetRef.current = null;
        };

        const handleKeyDown = (e: KeyboardEvent) => {
            const currentDrag = dragRef.current;
            if (!currentDrag) return;

            const key = e.key.toLowerCase();
            if (!['q', 'e', 'f'].includes(key)) return;

            // Q/E rotating and F flipping
            let transform = (p: Point) => p;
            let isFlipping = false;

            if (key === 'e') {
                transform = (p) => ({ x: -p.y, y: p.x });
            } else if (key === 'q') {
                transform = (p) => ({ x: p.y, y: -p.x });
            } else if (key === 'f') {
                transform = (p) => ({ x: -p.x, y: p.y });
                isFlipping = true;
            }

            const rawNewOffsets = currentDrag.offsets.map(transform);
            let minX = Math.min(...rawNewOffsets.map(p => p.x));
            let minY = Math.min(...rawNewOffsets.map(p => p.y));
            let newOffsets = rawNewOffsets.map(p => ({ x: p.x - minX, y: p.y - minY }));

            const areOffsetsEqual = (o1: Point[], o2: Point[]) => {
                if (o1.length !== o2.length) return false;
                const set1 = new Set(o1.map(p => `${p.x},${p.y}`));
                return o2.every(p => set1.has(`${p.x},${p.y}`));
            };

            if (areOffsetsEqual(currentDrag.offsets, newOffsets)) {
                if (isFlipping) {
                    const altTransform = (p: Point) => ({ x: p.x, y: -p.y });
                    const altRawNewOffsets = currentDrag.offsets.map(altTransform);
                    const altMinX = Math.min(...altRawNewOffsets.map(p => p.x));
                    const altMinY = Math.min(...altRawNewOffsets.map(p => p.y));
                    const altNewOffsets = altRawNewOffsets.map(p => ({ x: p.x - altMinX, y: p.y - altMinY }));

                    if (areOffsetsEqual(currentDrag.offsets, altNewOffsets)) {
                        return;
                    } else {
                        transform = altTransform;
                        minX = altMinX;
                        minY = altMinY;
                        newOffsets = altNewOffsets;
                    }
                } else {
                    return;
                }
            }

            const avgX = currentDrag.offsets.reduce((sum, p) => sum + p.x, 0) / currentDrag.offsets.length;
            const avgY = currentDrag.offsets.reduce((sum, p) => sum + p.y, 0) / currentDrag.offsets.length;
            let pivotOld = currentDrag.offsets[0];
            let minDist = Infinity;
            for (const p of currentDrag.offsets) {
                const dist = (p.x - avgX) ** 2 + (p.y - avgY) ** 2;
                if (dist < minDist) {
                    minDist = dist;
                    pivotOld = p;
                }
            }

            const offsetFromCenterX = currentDrag.dragOffsetX - pivotOld.x;
            const offsetFromCenterY = currentDrag.dragOffsetY - pivotOld.y;

            const pivotRawNew = transform(pivotOld);
            const pivotNew = { x: pivotRawNew.x - minX, y: pivotRawNew.y - minY };

            const newDX = pivotNew.x + offsetFromCenterX;
            const newDY = pivotNew.y + offsetFromCenterY;

            setDragState(prev => prev ? {
                ...prev,
                offsets: newOffsets,
                dragOffsetX: newDX,
                dragOffsetY: newDY
            } : null);
        };

        window.addEventListener('mouseup', handleMouseUp);
        window.addEventListener('keydown', handleKeyDown);

        return () => {
            window.removeEventListener('mouseup', handleMouseUp);
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [dragState, handleModuleAssignmentChange, importedFile, inventory]);

    const addPieceToInventory = (template: ModuleTemplate) => {
        const base = getBaseStats(template);
        const maxPositiveBase = Math.max(
            base.Performance > 0 ? base.Performance : 0,
            base.Quality > 0 ? base.Quality : 0,
            base.Efficiency > 0 ? base.Efficiency : 0
        );
        const defaultDoubleBase = maxPositiveBase * 2;

        setInventory((prev) => [{
            id: `${template.shape}_${template.color}_${Math.random().toString(36).substring(2, 8)}`,
            shape: template.shape,
            color: template.color,
            displayName: template.displayName,
            effects: ['None', 'None'],
            effectValues: [defaultDoubleBase, defaultDoubleBase]
        }, ...prev]);
    };

    const handleToggleInfiniteNodes = useCallback((isInfinite: boolean) => {
        setInventory(prev => prev.map(invItem =>
            invItem.shape === 'Node1x2' ? { ...invItem, isInfinite } : invItem
        ));
    }, []);

    const handleToggleLock = useCallback((itemId: string) => {
        setInventory(current => current.map(item => item.id === itemId ? { ...item, isLocked: !item.isLocked } : item));
    }, []);

    const handleUpdateItemEffect = useCallback((item: InventoryItem, effectIndex: 0 | 1, newEffect: ItemEffect) => {
        setInventory(prev => prev.map(invItem => {
            if (invItem.id === item.id) {
                const updatedEffects: [ItemEffect, ItemEffect] = [...invItem.effects] as [ItemEffect, ItemEffect];
                updatedEffects[effectIndex] = newEffect;

                const updatedValues: [number, number] = [...invItem.effectValues] as [number, number];
                if (newEffect === 'Learning Algorithm' || newEffect === 'Degrading') {
                    updatedValues[effectIndex] = maxCustomEffectValue(invItem, effectIndex, updatedEffects);
                }

                const otherIndex = effectIndex === 0 ? 1 : 0;
                if (updatedEffects[otherIndex] === 'Learning Algorithm' || updatedEffects[otherIndex] === 'Degrading') {
                    updatedValues[otherIndex] = Math.min(updatedValues[otherIndex], maxCustomEffectValue({ ...invItem, effects: updatedEffects, effectValues: updatedValues }, otherIndex, updatedEffects));
                }

                return { ...invItem, effects: updatedEffects, effectValues: updatedValues };
            }
            return invItem;
        }));
    }, []);

    const handleUpdateItemEffectValue = useCallback((itemId: string, effectIndex: 0 | 1, newValue: number) => {
        setInventory(prev => prev.map(item => {
            if (item.id === itemId) {
                const updatedValues: [number, number] = [...item.effectValues] as [number, number];
                updatedValues[effectIndex] = Math.floor(newValue);
                return { ...item, effectValues: updatedValues };
            }
            return item;
        }));
    }, []);

    const handleBlurEffectValue = useCallback((item: InventoryItem, effectIndex: 0 | 1, rawValue: number) => {
        const maxLimit = maxCustomEffectValue(item, effectIndex);
        const minLimit = 0;

        const val = isNaN(rawValue) ? minLimit : Math.floor(rawValue);
        const clampedValue = Math.max(minLimit, Math.min(maxLimit, val));

        setInventory(prev => prev.map(invItem => {
            if (invItem.id === item.id) {
                const updatedValues: [number, number] = [...invItem.effectValues] as [number, number];
                updatedValues[effectIndex] = clampedValue;
                return { ...invItem, effectValues: updatedValues };
            }
            return invItem;
        }));
    }, []);

    const handleRemoveItem = useCallback((itemId: string) => {
        setInventory(prev => prev.filter(i => i.id !== itemId));
        Object.values(machinesRef.current).forEach(machine => machine.remove(itemId));
    }, []);

    const handleInventoryDragStart = useCallback((e: React.MouseEvent, item: InventoryItem, savedOffsets?: Point[]) => {
        if (isAnySolving || item.isLocked) { e.preventDefault(); return; }
        e.preventDefault();
        const offsets = savedOffsets || PRECOMPUTED_OFFSETS.get(item.shape)?.[0] || [{x: 0, y: 0}];

        const avgX = offsets.reduce((sum: number, p: Point) => sum + p.x, 0) / offsets.length;
        const avgY = offsets.reduce((sum: number, p: Point) => sum + p.y, 0) / offsets.length;

        let pivot = offsets[0];
        let minDist = Infinity;
        for (const p of offsets) {
            const dist = (p.x - avgX) ** 2 + (p.y - avgY) ** 2;
            if (dist < minDist) {
                minDist = dist;
                pivot = p;
            }
        }

        const dragOffsetX = pivot.x;
        const dragOffsetY = pivot.y;

        const evt = new CustomEvent('appDragStart', {
            detail: {
                item,
                sourceMachineId: null,
                offsets,
                dragOffsetX,
                dragOffsetY,
                initialMouseX: e.clientX,
                initialMouseY: e.clientY
            }
        });
        window.dispatchEvent(evt);
    }, [isAnySolving]);

    const filteredModules = MODULE_TEMPLATES.filter(m => {
        if (m.shapeType === 'Node') return false;
        if (filterGroup !== 'All' && m.group !== filterGroup) return false;
        return !(filterSize !== 'All' && m.size !== filterSize);
    });

    const shouldPushNodeToEnd = filterGroup !== 'All';

    const catalogDisplayList = shouldPushNodeToEnd
        ? [...filteredModules, NODE_TEMPLATE]
        : [NODE_TEMPLATE, ...filteredModules];

    const currentMovePlacements = (includeCommitted = true) => {
        const current = new Map<string, MovePlacement>();
        machines.forEach(machine => {
            if (!machine.initialBoard) return;
            placementsFromBoard(machine.initialBoard, machine.id, machine.name || 'Machine', machine.mode !== 'ignore').forEach(placement => current.set(placement.moduleId, placement));
        });
        inventory.forEach(module => {
            if (current.has(module.id)) return;
            const item = saveInventoryGrid?.items.find(candidate => candidate.moduleId === module.id);
            const container = item?.parentId ? saveInventoryGrid?.items.find(candidate => candidate.id === item.parentId) : undefined;
            const columns = container?.inventoryWidth || 1;
            current.set(module.id, {
                moduleId: module.id,
                locationId: module.source?.parentId || saveInventoryGrid?.rootId || 'inventory',
                locationName: module.source?.location || 'Shop Inventory',
                cells: item ? item.cells.map(cell => (item.y + cell.y) * columns + item.x + cell.x) : [],
                columns,
                interchangeableGroup: moveGroup(module)
            });
        });
        if (includeCommitted) committedMoves.forEach(move => {
            const placement = current.get(move.moduleId);
            if (placement) current.set(move.moduleId, {
                ...placement,
                locationId: move.toId,
                locationName: move.toName,
                cells: [...move.targetCells],
                columns: move.targetColumns
            });
        });
        return [...current.values()];
    };

    const handleRunAll = (onlyMachineId?: string) => {
        if (isAnySolving || globalIsSolvingRef.current) {
            globalIsSolvingRef.current = false;
            Object.values(machinesRef.current).forEach(machine => machine.stop());
        } else {
            setUnusedAfterOptimization(null);
            setModuleDestinations(new Map());
            setMovePlan(null);
            setMoveStepIndex(0);
            globalIsSolvingRef.current = true;
            if (onlyMachineId) setMachines(current => current.map(machine => machine.id === onlyMachineId ? { ...machine, mode: 'optimize' } : machine.mode === 'optimize' ? { ...machine, mode: 'ignore' } : machine));
            const effectiveMode = (id: string, machine: MachineHandle) => onlyMachineId ? id === onlyMachineId ? 'optimize' : machine.getState().mode === 'optimize' ? 'ignore' : machine.getState().mode : machine.getState().mode;
            const activeMachines = Object.entries(machinesRef.current).filter(([id, machine]) => effectiveMode(id, machine) === 'optimize');
            if (activeMachines.length === 0) { globalIsSolvingRef.current = false; return; }
            const activeIds = new Set(activeMachines.map(([id]) => id));
            const lockedTargets = new Map<string, string>();
            Object.entries(machinesRef.current).forEach(([id, machine]) => machine.getBoard().flat().forEach(cell => {
                if (cell && cell !== 'Locked' && cell.isLocked) lockedTargets.set(cell.id, id);
            }));
            const activeLocked = new Set([...lockedTargets].flatMap(([moduleId, target]) => activeIds.has(target) ? [moduleId] : []));
            const fixedAssignments = new Set([...Object.entries(moduleAssignments).flatMap(([moduleId, target]) => activeIds.has(target) ? [moduleId] : []), ...activeLocked]);
            activeMachines.forEach(([id]) => handleSolvingChange(id, true));

            const machinesConfig = activeMachines.map(([id, m]) => {
                const state = m.getState();
                return {
                    id, tier: state.tier, targetStats: state.targetStats, maximizeStats: state.maximizeStats, statPriority: state.statPriority,
                    moduleType: state.moduleType, furnaceModules: state.furnaceModules, alarmModule: state.alarmModule,
                    requiredModuleIds: [...new Set([
                        ...Object.entries(moduleAssignments).flatMap(([moduleId, target]) => target === id ? [moduleId] : []),
                        ...[...lockedTargets].flatMap(([moduleId, target]) => target === id ? [moduleId] : [])
                    ])]
                };
            });

            const initialBoards = activeMachines.map(([, machine]) => machine.getBoard());
            const reserved = new Set<string>();
            Object.entries(machinesRef.current).forEach(([id, machine]) => {
                if (effectiveMode(id, machine) !== 'ignore') return;
                machine.getBoard().flat().forEach(cell => {
                    if (cell && cell !== 'Locked') reserved.add(cell.id);
                });
            });
            const keptOut = new Set(Object.entries(moduleAssignments).flatMap(([moduleId, target]) => target === RESERVED_ASSIGNMENT || !activeIds.has(target) ? [moduleId] : []));

            let optimizationSucceeded = false;
            runOptimizationWorker(
                machinesConfig,
                initialBoards,
                expandedInventory.filter(item => (!item.isLocked || activeLocked.has(item.id)) && (!reserved.has(item.id) || fixedAssignments.has(item.id)) && !keptOut.has(item.id)),
                globalIsSolvingRef,
                (updates) => {
                    const used = new Set<string>();
                    updates.forEach((update, mId) => {
                        machinesRef.current[mId]?.applyUpdate(update.board, update.totals, update.pieceStats, update.code);
                        update.board.flat().forEach(cell => { if (cell && cell !== 'Locked') used.add(cell.id); });
                    });
                    Object.entries(machinesRef.current).forEach(([id, machine]) => {
                        if (activeIds.has(id)) return;
                        used.forEach(moduleId => {
                            if (effectiveMode(id, machine) === 'donate' || fixedAssignments.has(moduleId)) machine.remove(moduleId);
                        });
                    });
                },
                optimizationSeconds === 0 ? Number.POSITIVE_INFINITY : optimizationSeconds * 1000
            ).then(() => {
                optimizationSucceeded = true;
            }).catch(error => {
                console.error('Optimization failed:', error);
                setImportError(error instanceof Error ? error.message : 'Optimization failed.');
            }).finally(() => {
                if (optimizationSucceeded) {
                    const rawTargets = activeMachines.flatMap(([id, machine]) =>
                        placementsFromBoard(machine.getBoard(), id, machines.find(candidate => candidate.id === id)?.name || 'Machine')
                    );
                    const reconciled = reconcileMoveTargets(currentMovePlacements(), rawTargets, fixedAssignments);
                    const physicalIds = new Map(rawTargets.map((target, index) => [target.moduleId, reconciled[index].moduleId]));
                    activeMachines.forEach(([, machine]) => {
                        const board = machine.getBoard().map((row: Array<InventoryItem | 'Locked' | null>) => row.map(cell => {
                            if (!cell || cell === 'Locked') return cell;
                            return inventory.find(item => item.id === physicalIds.get(cell.id)) || cell;
                        }));
                        const stats = calculateBoardStats(board);
                        machine.applyUpdate(board, stats.totals, stats.pieceStats, '');
                    });
                    const used = new Set<string>();
                    const destinations = new Map<string, string>();
                    const machineNames = new Map(machines.map(machine => [machine.id, machine.name || 'Machine']));
                    activeMachines.forEach(([id, machine]) => {
                        machine.getBoard().flat().forEach(cell => {
                            if (cell && cell !== 'Locked') destinations.set(cell.id, machineNames.get(id) || 'Machine');
                        });
                    });
                    Object.entries(machinesRef.current).forEach(([id, machine]) => {
                        if (effectiveMode(id, machine) === 'donate') return;
                        machine.getBoard().flat().forEach(cell => {
                            if (cell && cell !== 'Locked') used.add(cell.id);
                        });
                    });
                    setUnusedAfterOptimization(new Set(inventory.filter(item => !used.has(item.id) && !keptOut.has(item.id) && !isRecycleProtected(item)).map(item => item.id)));
                    setModuleDestinations(destinations);
                }
                globalIsSolvingRef.current = false;
                activeMachines.forEach(([id]) => handleSolvingChange(id, false));
            });
        }
    };

    const handleCreateMovePlan = () => {
        if (!saveInventoryGrid) return;
        try {
            const managed = new Set(machines.filter(machine => machine.mode === 'optimize').map(machine => machine.id));
            const target = machines.filter(machine => managed.has(machine.id)).flatMap(machine =>
                placementsFromBoard(machinesRef.current[machine.id]?.getBoard() || [], machine.id, machine.name || 'Machine')
            );
            const containers = saveInventoryGrid.items.filter(item => item.id === saveInventoryGrid.rootId || item.identifier === 'storage_bay_large');
            const stagingAreas = containers.map(container => {
                const width = container.inventoryWidth!;
                const height = container.inventoryHeight!;
                const children = saveInventoryGrid.items.filter(item => item.parentId === container.id);
                const occupied = children.filter(item => !item.moduleId).flatMap(item => item.cells.map(cell => (item.y + cell.y) * width + item.x + cell.x));
                const used = children.flatMap(item => item.cells.map(cell => (item.y + cell.y) * width + item.x + cell.x)).length;
                return {
                    id: container.id,
                    name: container.id === saveInventoryGrid.rootId ? 'Shop Inventory' : `${container.name} @ (${container.x}, ${container.y})`,
                    width,
                    height,
                    occupied,
                    free: width * height - used
                };
            });
            const shop = stagingAreas.find(area => area.id === saveInventoryGrid.rootId)!;
            const storage = stagingAreas.filter(area => area !== shop).sort((a, b) => b.free - a.free);
            const fixedAssignments = new Set(Object.entries(moduleAssignments).flatMap(([moduleId, machineId]) => managed.has(machineId) ? [moduleId] : []));
            const plan = buildMovePlan(currentMovePlacements(), target, managed, [shop, ...storage], fixedAssignments);
            setMovePlan(plan);
            setMoveStepIndex(0);
            setLocatedModuleId(plan[0]?.moduleId || null);
            setImportError(null);
        } catch (error) {
            setImportError(error instanceof Error ? error.message : 'Could not create a move plan.');
        }
    };

    const showMoveStep = (index: number) => {
        setMoveStepIndex(index);
        setLocatedModuleId(movePlan?.[index]?.moduleId || null);
    };

    const advanceMoveStep = () => {
        if (!movePlan) return;
        if (moveStepIndex < movePlan.length - 1) {
            showMoveStep(moveStepIndex + 1);
            return;
        }
        setCommittedMoves(current => [...current, ...movePlan]);
        setMovePlan(null);
        setLocatedModuleId(null);
    };

    const handleClearMachine = useCallback((machineId: string) => {
        machinesRef.current[machineId]?.clear();
        setUnusedAfterOptimization(null);
        setModuleDestinations(new Map());
        setMovePlan(null);
    }, []);

    const handleClearAll = (includeIgnored = false) => {
        Object.values(machinesRef.current).forEach(machine => {
            if (includeIgnored || machine.getState().mode !== 'ignore') machine.clear();
        });
        setUnusedAfterOptimization(null);
        setModuleDestinations(new Map());
        setMovePlan(null);
    };

    const handleAddMachine = () => {
        setMachines(prev => [...prev, { id: `m_${Math.random().toString(36).substring(2,8)}`, initialTier: 3, initialMax: { Performance: false, Quality: false, Efficiency: false }, mode: 'optimize' }]);
    };

    const handleDuplicateMachine = useCallback((machineId: string) => {
        const machine = machinesRef.current[machineId];
        if (machine) {
            const state = machine.getState();
            setMachines(prev => [...prev, {
                id: `m_${Math.random().toString(36).substring(2,8)}`,
                initialTier: state.tier,
                initialMax: state.maximizeStats,
                initialTarget: state.targetStats,
                initialPriority: state.statPriority,
                moduleType: state.moduleType,
                furnaceModules: state.furnaceModules,
                alarmModule: state.alarmModule,
                mode: 'optimize'
            }]);
        }
    }, []);

    const handleDeleteMachine = useCallback((machineId: string) => {
        setMachines(prev => prev.filter(m => m.id !== machineId));
        localStorage.removeItem(`optimizer_machine_${machineId}`);
        delete machinesRef.current[machineId];
        setSolvingStates(prev => {
            const next = { ...prev };
            delete next[machineId];
            return next;
        });
    }, []);

    const handleSolvingChange = useCallback((id: string, solving: boolean) => {
        if (!solving && globalIsSolvingRef.current) return;
        setSolvingStates(prev => {
            if (prev[id] === solving) return prev;
            return { ...prev, [id]: solving };
        });
    }, []);

    const cellSize = machines.length <= 2 ? 50 : (machines.length <= 4 ? 40 : 35);
    const currentMove = movePlan?.[moveStepIndex];
    const currentMoveModule = currentMove ? inventory.find(module => module.id === currentMove.moduleId) : undefined;
    const assignmentMachines = useMemo(() => machines.map(machine => ({
        id: machine.id,
        name: machine.name || 'Machine',
        moduleType: machine.moduleType,
        furnaceModules: machine.furnaceModules,
        alarmModule: machine.alarmModule
    })), [machines]);
    useEffect(() => {
        setPlacedModuleIds(new Set(Object.values(machinesRef.current).flatMap(machine => machine.getBoard().flat().flatMap(cell => cell && cell !== 'Locked' ? [cell.id] : []))));
    }, [machines, solvingStates, dragState]);
    const visibleInventory = importedFile ? inventory : inventory.filter(item => {
        const template = MODULE_TEMPLATES.find(module => module.shape === item.shape && module.color === item.color);
        if (inventoryFilterGroup === 'Placed' ? !placedModuleIds.has(item.id) : inventoryFilterGroup !== 'All' && template?.group !== inventoryFilterGroup) return false;
        if (inventoryFilterSize !== 'All' && (PRECOMPUTED_OFFSETS.get(item.shape)?.[0]?.length || 0) !== inventoryFilterSize) return false;
        return inventoryFilterEffect === 'All' || item.effects.includes(inventoryFilterEffect);
    }).slice(0, MAX_VISIBLE_INVENTORY_ROWS);
    const visibleInventoryGroups = visibleInventory.reduce<Record<string, InventoryItem[]>>((groups, item) => {
        const location = item.source?.location || 'Manual inventory';
        (groups[location] ||= []).push(item);
        return groups;
    }, {});
    const allVisibleLocked = visibleInventory.length > 0 && visibleInventory.every(item => item.isLocked);
    const visibleLocatedModule = locatedModule && (!currentMove || currentMove.fromId === locatedModule.source?.machineId || currentMove.fromId === locatedModule.source?.parentId)
        ? locatedModule
        : null;
    const displayedTargetCells = currentMove?.targetCells;
    const displayedTargetId = currentMove?.toId;
    const displayedTargetColumns = currentMove?.targetColumns || 7;
    const movePosition = displayedTargetCells?.length
        ? `row ${Math.floor(Math.min(...displayedTargetCells) / displayedTargetColumns) + 1}, column ${Math.min(...displayedTargetCells) % displayedTargetColumns + 1}`
        : '';

    return (
        <div className="main-container">

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', flexWrap: 'wrap', marginBottom: '18px' }}>
                <button
                    onClick={() => void handleOpenSave()}
                    style={{ padding: '9px 16px', backgroundColor: '#2d2d2d', color: '#eee', border: '1px solid #555', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
                >
                    Import .es3 save
                </button>
                <input
                    ref={saveInputRef}
                    type="file"
                    accept=".es3"
                    hidden
                    onChange={(event) => {
                        const file = event.target.files?.[0];
                        void handleSaveImport(file, refreshSelectionRef.current || file?.name === importedFile);
                        refreshSelectionRef.current = false;
                        event.target.value = '';
                    }}
                />
                <span style={{ color: '#888', fontSize: '0.75em', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    <span>Default save folder: {DEFAULT_SAVE_FOLDER}</span>
                    <span>Save files: save_&lt;number&gt;.es3</span>
                </span>
                <button
                    onClick={() => void navigator.clipboard.writeText(DEFAULT_SAVE_FOLDER)}
                    title="Copy the default save folder path"
                    style={{ padding: '6px 10px', backgroundColor: '#252525', color: '#ccc', border: '1px solid #444', borderRadius: '5px', cursor: 'pointer', fontSize: '0.75em' }}
                >
                    Copy path
                </button>
                {'showOpenFilePicker' in window && (
                    <button
                        onClick={() => void handleRefreshSave()}
                        disabled={!importedFile}
                        title="Reload the current save from disk"
                        style={{ padding: '9px 16px', backgroundColor: '#2d2d2d', color: importedFile ? '#eee' : '#666', border: '1px solid #555', borderRadius: '6px', cursor: importedFile ? 'pointer' : 'not-allowed', fontWeight: 'bold' }}
                    >
                        Refresh save
                    </button>
                )}
                {importedFile && <span style={{ color: '#aaa' }}>{importedFile}: {inventory.length} modules, {machines.length} machines</span>}
                <span style={{ color: '#8ab4f8', fontSize: '0.75em' }}>The game saves whenever the player sleeps.</span>
                {importError && <span style={{ color: '#ff4d4d' }}>{importError}</span>}
            </div>

            <style>
                {`
                .catalog-card {
                    transition: transform 0.1s ease-in-out, box-shadow 0.1s ease-in-out, background-color 0.1s ease-in-out;
                }
                .catalog-card:hover {
                    transform: translateY(-2px);
                    background-color: #2a2a2a !important;
                    box-shadow: 0 4px 12px rgba(255, 255, 255, 0.05);
                }
                .catalog-card:active {
                    transform: translateY(0);
                }
                input[type=number]::-webkit-inner-spin-button, 
                input[type=number]::-webkit-outer-spin-button { 
                    -webkit-appearance: none; 
                    margin: 0; 
                }
                input[type=number] { 
                    -moz-appearance: textfield; 
                }
                
                .main-container {
                    display: flex;
                    flex-direction: column;
                    min-height: 100vh;
                    background-color: #111;
                    color: #eee;
                    font-family: sans-serif;
                    padding: 20px;
                    user-select: none;
                }
                .stats-header {
                    display: flex;
                    gap: 40px;
                    margin-bottom: 15px;
                    background-color: #1a1a1a;
                    padding: 15px 30px;
                    border-radius: 8px;
                    border: 1px solid #333;
                }
                .grid-wrapper {
                    display: grid;
                    gap: 0px;
                    background-color: #222;
                    padding: 10px;
                    border-radius: 8px;
                    border: 1px solid #333;
                    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
                }
                .controls-wrapper {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 15px;
                    margin-top: 10px;
                    align-items: center;
                    justify-content: center;
                    width: 100%;
                }
                .solution-ui {
                    display: flex;
                    width: 100%;
                    margin-top: 15px;
                    gap: 10px;
                    justify-content: center;
                    align-items: center;
                }
                .solution-ui input {
                    flex: 1;
                    max-width: 500px;
                    padding: 8px;
                    font-size: 0.8em;
                    background-color: #111;
                    color: #eee;
                    border: 1px solid #444;
                    border-radius: 4px;
                }
                .bottom-layout {
                    display: flex;
                    flex: 1;
                    gap: 30px;
                    min-height: 0;
                    margin-top: 20px;
                }
                .machines-container {
                    display: flex;
                    flex-wrap: wrap;
                    justify-content: center;
                    align-items: flex-start;
                    gap: 30px;
                    width: 100%;
                }
                
                @media (max-width: 768px) {
                    .main-container {
                        padding: 10px;
                        height: auto;
                    }
                    .bottom-layout {
                        flex-direction: column;
                        gap: 15px;
                        min-height: auto;
                    }
                    .stats-header {
                        gap: 15px;
                        padding: 10px;
                        width: 100%;
                        justify-content: space-around;
                    }
                    .grid-wrapper {
                        transform: scale(0.85);
                        transform-origin: top center;
                        margin-bottom: -25px;
                    }
                    .controls-wrapper {
                        flex-direction: column;
                        width: 100%;
                        align-items: stretch;
                    }
                    .solution-ui {
                        flex-wrap: wrap;
                    }
                    .solution-ui input {
                        max-width: 100%;
                        width: 100%;
                    }
                }
                @media (max-width: 400px) {
                    .grid-wrapper {
                        transform: scale(0.75);
                        margin-bottom: -50px;
                    }
                }
                `}
            </style>

            {/* Tooltip */}
            {hoveredItem && hoverInfo && !dragState && (
                <div style={{
                    position: 'fixed',
                    top: hoverInfo.y + 15,
                    left: hoverInfo.x + 15,
                    backgroundColor: 'rgba(0, 0, 0, 0.95)',
                    border: `1px solid ${hoveredRecycleReason ? '#795548' : COLOR_MAP[hoveredItem.color]}`,
                    padding: '10px 15px',
                    borderRadius: '6px',
                    zIndex: 1000,
                    pointerEvents: 'none',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                    minWidth: '150px'
                }}>
                    <div style={{ fontWeight: 'bold', marginBottom: '4px', color: hoveredRecycleReason ? '#a97852' : COLOR_MAP[hoveredItem.color] }}>
                        {hoveredItem.displayName}
                    </div>
                    {(hoveredItem.effects[0] !== 'None' || hoveredItem.effects[1] !== 'None') && (
                        <div style={{ fontSize: '0.75em', color: '#aaa', fontStyle: 'italic', marginBottom: '8px', borderBottom: '1px solid #333', paddingBottom: '5px' }}>
                            {hoveredItem.effects.filter(e => e !== 'None').map((e) => {
                                const actualIdx = hoveredItem.effects.indexOf(e as ItemEffect);
                                const val = hoveredItem.effectValues[actualIdx];
                                return `${e}${e === 'Learning Algorithm' || e === 'Degrading' ? ` (${val}%)` : ''}`;
                            }).join(', ')}
                        </div>
                    )}
                    {hoveredRecycleReason && (
                        <div style={{ color: '#c79a75', fontSize: '0.78em', marginBottom: '7px', maxWidth: '240px' }}>
                            {hoveredItem.displayName.includes('Ruined') ? 'Salvage candidate: ' : 'Sell/exchange candidate: '}{hoveredRecycleReason}
                        </div>
                    )}
                    {hoveredDestination && (
                        <div style={{ color: '#8ab4f8', fontSize: '0.8em', marginBottom: '7px' }}>
                            Should be placed in {hoveredDestination}.
                        </div>
                    )}
                    {hoveredAssignment && (
                        <div style={{ color: '#d6b4ff', fontSize: '0.8em', marginBottom: '7px' }}>
                            {hoveredAssignment === RESERVED_ASSIGNMENT
                                ? 'Kept out of optimization.'
                                : `Required in ${machines.find(machine => machine.id === hoveredAssignment)?.name || 'selected machine'}.`}
                        </div>
                    )}
                    {hoverInfo.stats ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '0.9em', marginTop: '5px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                <span style={{ color: '#aaa' }}>Perf:</span>
                                <span style={{ color: getStatColor(hoverInfo.stats.Performance) }}>{formatStatValue(hoverInfo.stats.Performance)}</span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                <span style={{ color: '#aaa' }}>Qual:</span>
                                <span style={{ color: getStatColor(hoverInfo.stats.Quality) }}>{formatStatValue(hoverInfo.stats.Quality)}</span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                <span style={{ color: '#aaa' }}>Effic:</span>
                                <span style={{ color: getStatColor(hoverInfo.stats.Efficiency) }}>{formatStatValue(hoverInfo.stats.Efficiency)}</span>
                            </div>
                        </div>
                    ) : (
                        <div style={{ color: '#888', fontSize: '0.9em' }}>Calculating...</div>
                    )}
                </div>
            )}

            {/* Main Grid & Controls */}
            <div style={{ marginBottom: '15px', color: '#888', fontSize: '0.85em', textAlign: 'center' }}>
                Tip: While dragging a module, press Q, E, or F to rotate or flip.
            </div>

            <div className="machines-container">
                {machines.map(m => (
                    <MachineInstance
                        key={`${m.id}_${m.revision || 0}`}
                        machineId={m.id}
                        ref={(el) => { if (el) machinesRef.current[m.id] = el; else delete machinesRef.current[m.id]; }}
                        inventory={expandedInventory}
                        setInventory={setInventory}
                        getUsedItems={getUsedItems}
                        initialTier={m.initialTier}
                        initialMax={m.initialMax}
                        initialTarget={m.initialTarget}
                        initialPriority={m.initialPriority}
                        initialBoard={m.initialBoard}
                        machineName={m.name}
                        machineLocation={m.location}
                        machineModuleType={m.moduleType}
                        furnaceModules={m.furnaceModules}
                        onFurnaceModulesChange={handleFurnaceModulesChange}
                        alarmModule={m.alarmModule}
                        onAlarmModuleChange={handleAlarmModuleChange}
                        mode={m.mode}
                        onModeChange={handleModeChange}
                        onPreferencesChange={handlePreferencesChange}
                        imported={m.imported}
                        dragState={dragState}
                        setHoverInfo={setHoverInfo}
                        onDuplicate={handleDuplicateMachine}
                        onDelete={handleDeleteMachine}
                        cellSize={cellSize}
                        onSolvingChange={handleSolvingChange}
                        onDragTargetRefChange={setDragTargetRefChange}
                        onLocateModule={setLocatedModuleId}
                        onOptimizeMachine={handleRunAll}
                        onClearMachine={handleClearMachine}
                        moduleAssignments={moduleAssignments}
                        assignmentMachines={assignmentMachines}
                        isAnySolving={isAnySolving || Boolean(movePlan)}
                        canDelete={!m.imported && machines.length > 1}
                        optimizationSeconds={optimizationSeconds}
                    />
                ))}
            </div>

            <div style={{ position: 'relative', display: 'flow-root' }}>
            <div style={{ display: 'flex', gap: '15px', justifyContent: 'center', marginTop: '30px', width: '100%', flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#bbb', fontSize: '0.85em' }}>
                    Optimization time limit in seconds (0 = endless)
                    <input
                        aria-label="Optimization time in seconds"
                        type="number"
                        min="0"
                        step="0.5"
                        value={optimizationSeconds}
                        onChange={event => setOptimizationSeconds(Math.max(0, Number(event.target.value) || 0))}
                        disabled={isAnySolving || Boolean(movePlan)}
                        style={{ width: '70px', padding: '10px', backgroundColor: '#222', color: '#eee', border: '1px solid #444', borderRadius: '6px' }}
                    />
                </label>
                <button
                    onClick={() => handleRunAll()}
                    disabled={Boolean(movePlan) || ((inventory.length === 0 || !machines.some(machine => machine.mode === 'optimize')) && !isAnySolving)}
                    style={{
                        padding: '10px 24px',
                        backgroundColor: isAnySolving ? '#ff4d4d' : '#4caf57',
                        color: 'white',
                        border: isAnySolving ? '1px solid #ff4d4d' : '1px solid #2e4a35',
                        borderRadius: '6px',
                        fontWeight: 'bold',
                        cursor: (movePlan || (inventory.length === 0 && !isAnySolving)) ? 'not-allowed' : 'pointer',
                        opacity: (movePlan || (inventory.length === 0 && !isAnySolving)) ? 0.5 : 1,
                        fontSize: '0.95em'
                    }}
                >
                    {isAnySolving ? 'Stop Selected Optimizers' : 'Optimize Selected Machines'}
                </button>
                <button
                        onClick={() => handleClearAll(!importedFile)}
                        disabled={isAnySolving || Boolean(movePlan)}
                        title={importedFile ? 'Clear displayed Optimize and Donate boards without changing the game save or machine settings' : 'Clear every machine board'}
                        style={{ padding: '10px 18px', backgroundColor: '#444', color: '#eee', border: '1px solid #666', borderRadius: '6px', cursor: isAnySolving || movePlan ? 'not-allowed' : 'pointer', opacity: isAnySolving || movePlan ? 0.5 : 1, fontWeight: 'bold' }}
                    >
                        {importedFile ? 'Clean Optimize + Donate' : 'Clear All'}
                    </button>
                {importedFile && (
                    <button
                        onClick={movePlan ? () => { setMovePlan(null); setLocatedModuleId(null); } : handleCreateMovePlan}
                        disabled={isAnySolving || (!movePlan && moduleDestinations.size === 0)}
                        title={!movePlan && moduleDestinations.size === 0 ? 'Run optimization first' : undefined}
                        style={{ padding: '10px 18px', backgroundColor: movePlan ? '#553333' : moduleDestinations.size > 0 ? '#075b9b' : '#333', color: moduleDestinations.size > 0 ? '#fff' : '#777', border: `1px solid ${moduleDestinations.size > 0 ? '#7ec8ff' : '#555'}`, borderRadius: '6px', cursor: isAnySolving || (!movePlan && moduleDestinations.size === 0) ? 'not-allowed' : 'pointer', fontWeight: 'bold' }}
                    >
                        {movePlan ? 'Close Move Guide' : 'Create Move Plan'}
                    </button>
                )}
                {!importedFile && (
                    <button
                        onClick={handleAddMachine}
                        disabled={isAnySolving}
                        style={{ padding: '10px 24px', backgroundColor: '#2d2d2d', color: '#eee', border: '1px solid #3d3d3d', borderRadius: '6px', cursor: isAnySolving ? 'not-allowed' : 'pointer', fontSize: '0.95em' }}
                    >
                        + Add Machine
                    </button>
                )}
            </div>

            {movePlan && <div style={{
                position: 'absolute', top: 'calc(50% + 15px)', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 1000,
                width: 'min(620px, calc(100vw - 32px))', height: '220px', boxSizing: 'border-box',
                display: 'flex', flexDirection: 'column', padding: '14px 18px',
                border: '1px solid #376f91', borderRadius: '8px', backgroundColor: '#17242c', color: '#eee',
                boxShadow: '0 8px 28px rgba(0, 0, 0, 0.75)'
            }}>
                <button
                    onClick={() => { setMovePlan(null); setLocatedModuleId(null); }}
                    aria-label="Close move guide"
                    style={{ position: 'absolute', top: '8px', right: '8px', padding: '2px 8px', border: 0, background: 'transparent', color: '#bbb', fontSize: '20px', cursor: 'pointer' }}
                >×</button>
                {currentMove ? <>
                    <div style={{ overflowY: 'auto', paddingRight: '28px' }}>
                        <div style={{ color: '#8ab4f8', fontWeight: 'bold', marginBottom: '7px' }}>Move {moveStepIndex + 1} of {movePlan.length}</div>
                        <div style={{ marginBottom: '6px' }}><strong>Keep open:</strong> {[...new Set([currentMove.fromName, currentMove.toName])].join(' + ')}</div>
                        <div style={{ fontSize: '1.05em' }}>
                            {currentMove.temporary
                                ? <>Move <strong>{currentMoveModule?.displayName || 'module'}</strong> from <strong>{currentMove.fromName}</strong> to <strong>{currentMove.toName}</strong> at {movePosition}.{currentMove.finalToName && <> It will go to <strong>{currentMove.finalToName}</strong> later.</>}</>
                                : currentMove.fromId === currentMove.toId
                                    ? <>Reposition <strong>{currentMoveModule?.displayName || 'module'}</strong> inside <strong>{currentMove.toName}</strong> at {movePosition}.</>
                                    : <>Move <strong>{currentMoveModule?.displayName || 'module'}</strong> from <strong>{currentMove.fromName}</strong> to <strong>{currentMove.toName}</strong> at {movePosition}.</>}
                        </div>
                        <div style={{ color: '#9bcde8', fontSize: '0.8em', marginTop: '6px' }}>Cyan shows its current location. Green shows where to place it now. Done updates this inventory view.</div>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', marginTop: 'auto', paddingTop: '12px' }}>
                        <button onClick={() => showMoveStep(Math.max(0, moveStepIndex - 1))} disabled={moveStepIndex === 0} style={{ padding: '7px 14px' }}>Back</button>
                        <button onClick={advanceMoveStep} style={{ padding: '7px 18px', backgroundColor: '#4caf57', color: '#fff', border: 0, borderRadius: '4px', fontWeight: 'bold' }}>{moveStepIndex === movePlan.length - 1 ? 'Done' : 'Next'}</button>
                    </div>
                </> : <>
                    <div style={{ color: '#7bd889', fontWeight: 'bold', paddingRight: '28px' }}>Move plan complete. Your machine boards should now match the optimized layouts.</div>
                    {movePlan.length > 0 && <button onClick={() => showMoveStep(movePlan.length - 1)} style={{ alignSelf: 'flex-start', marginTop: 'auto', padding: '7px 14px' }}>Back</button>}
                </>}
            </div>}
            </div>

            {importedFile && <div style={{ margin: '8px auto 0', maxWidth: '900px', color: '#999', fontSize: '0.75em', lineHeight: 1.35, textAlign: 'center' }}>
                Move Guide gives step-by-step instructions from the saved positions to the optimized layouts. For an easier rearrangement, empty machine modules into one large storage before sleeping, then import the new save, optimize, and refill the machines.
            </div>}

            {saveInventoryGrid && <SaveInventoryGrid
                grid={saveInventoryGrid}
                modules={inventory}
                recycleReasons={recycleReasons}
                moduleDestinations={moduleDestinations}
                moduleAssignments={moduleAssignments}
                assignmentMachines={assignmentMachines}
                onModuleDragStart={(event, module, offsets) => handleInventoryDragStart(event, module, offsets)}
                locatedModule={visibleLocatedModule}
                guideModuleId={currentMove?.moduleId}
                guideLocationId={currentMove?.fromId}
                guideTargetLocationId={displayedTargetId}
                guideTargetCells={displayedTargetCells}
                guideTargetColumns={displayedTargetColumns}
                completedMoves={movePlan ? [...committedMoves, ...movePlan.slice(0, moveStepIndex)] : committedMoves}
                navigationLocked={Boolean(movePlan) || isAnySolving}
                onModuleHover={(module, x, y, showRecycleReason) => setHoverInfo({ x, y, cell: module, stats: applyInternalEffects(module), showRecycleReason })}
                onModuleLeave={() => setHoverInfo(null)}
                onModuleAssignmentChange={handleModuleAssignmentChange}
            />}

            {/* Catalog & Inventory */}
            <div className="bottom-layout">

                {/* Catalog */}
                {!importedFile && <div style={{ flex: '2', backgroundColor: '#1c1c1e', padding: '20px', borderRadius: '8px', border: '1px solid #2c2c2e', display: 'flex', flexDirection: 'column' }}>

                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '15px', paddingBottom: '15px', borderBottom: '1px solid #333' }}>
                        <select value={filterGroup} onChange={(e) => setFilterGroup(e.target.value as FilterGroup)} style={{ flex: 1, minWidth: '150px', padding: '8px 12px', backgroundColor: '#333', color: 'white', border: '1px solid #555', borderRadius: '4px', outline: 'none' }}>
                            <option value="All">All Module Groups</option>
                            <option value="Performance">Performance (Red)</option>
                            <option value="Quality">Quality (Yellow)</option>
                            <option value="Efficiency">Efficiency (Green)</option>
                            <option value="Special">Special Modules</option>
                        </select>
                        <select value={filterSize} onChange={(e) => setFilterSize(e.target.value === 'All' ? 'All' : Number(e.target.value) as 3 | 4 | 5)} style={{ flex: 1, minWidth: '150px', padding: '8px 12px', backgroundColor: '#333', color: 'white', border: '1px solid #555', borderRadius: '4px', outline: 'none' }}>
                            <option value="All">All Sizes</option>
                            <option value={3}>Size 3</option>
                            <option value={4}>Size 4</option>
                            <option value={5}>Size 5</option>
                        </select>
                    </div>

                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', overflowY: 'auto', alignContent: 'flex-start', padding: '5px 5px 20px 5px', justifyContent: 'center' }}>
                        {catalogDisplayList.map((template, idx) => {
                            const uniqueKey = `${template.shape}_${template.color}_${idx}`;

                            return (
                                <div
                                    key={uniqueKey}
                                    className="catalog-card"
                                    onClick={() => addPieceToInventory(template)}
                                    style={{
                                        padding: '16px 12px',
                                        width: '135px',
                                        backgroundColor: '#252526',
                                        border: `1px solid ${COLOR_MAP[template.color]}`,
                                        borderRadius: '6px',
                                        display: 'flex',
                                        flexDirection: 'column',
                                        alignItems: 'center',
                                        cursor: 'pointer'
                                    }}
                                >
                                    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                                        <div style={{ height: '50px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                                            <MiniShape shape={template.shape} colorHex={COLOR_MAP[template.color]} />
                                        </div>
                                        <span style={{ fontSize: '0.7em', color: '#ccc', marginTop: '15px', textAlign: 'center', fontWeight: 'bold' }}>
                                            {template.displayName}
                                        </span>
                                        <span style={{ fontSize: '0.65em', color: '#777', marginTop: '6px', textAlign: 'center' }}>
                                            {template.shape === 'Node1x2' ? 'Node' : `${template.shapeType} - Size ${template.size}`}
                                        </span>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>}

                {/* Inventory */}
                <div
                    style={{ flex: '1', backgroundColor: '#1c1c1e', padding: '20px', borderRadius: '8px', border: '1px solid #2c2c2e', display: 'flex', flexDirection: 'column' }}
                    onMouseMove={() => {
                        if (dragState && dragState.sourceMachineId !== null) {
                            setDragTargetRefChange({ machineId: null, x: -1, y: -1 });
                        }
                    }}
                >
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '15px', alignItems: 'center' }}>
                        <span style={{ color: '#888', fontSize: '0.9em' }}>{importedFile ? `${inventory.length} Imported modules` : `${visibleInventory.length} of ${inventory.length} Selected`}</span>
                        {!importedFile && (
                            <button
                                onClick={() => {
                                    setInventory([]);
                                    handleClearAll(true);
                                }}
                                disabled={isAnySolving || inventory.length === 0}
                                style={{
                                    background: 'none',
                                    border: 'none',
                                    color: (isAnySolving || inventory.length === 0) ? '#555' : '#ff4d4d',
                                    cursor: (isAnySolving || inventory.length === 0) ? 'not-allowed' : 'pointer',
                                    fontSize: '0.85em',
                                    textDecoration: 'underline'
                                }}
                            >
                                Clear List
                            </button>
                        )}
                    </div>

                    {!importedFile && <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' }}>
                        <select aria-label="Filter inventory by group" value={inventoryFilterGroup} onChange={event => setInventoryFilterGroup(event.target.value as FilterGroup | 'Placed')} style={{ padding: '5px', background: '#292929', color: '#eee', border: '1px solid #555' }}>
                            {['All', 'Placed', 'Performance', 'Quality', 'Efficiency', 'Special'].map(value => <option key={value}>{value}</option>)}
                        </select>
                        <select aria-label="Filter inventory by size" value={inventoryFilterSize} onChange={event => setInventoryFilterSize(event.target.value === 'All' ? 'All' : Number(event.target.value) as 3 | 4 | 5)} style={{ padding: '5px', background: '#292929', color: '#eee', border: '1px solid #555' }}>
                            <option>All</option><option value="3">Size 3</option><option value="4">Size 4</option><option value="5">Size 5</option>
                        </select>
                        <select aria-label="Filter inventory by effect" value={inventoryFilterEffect} onChange={event => setInventoryFilterEffect(event.target.value as ItemEffect | 'All')} style={{ padding: '5px', background: '#292929', color: '#eee', border: '1px solid #555' }}>
                            <option>All</option>{EFFECTS_LIST.filter(effect => effect !== 'None').map(effect => <option key={effect}>{effect}</option>)}
                        </select>
                        <button disabled={isAnySolving || visibleInventory.length === 0} onClick={() => setInventory(current => current.map(item => visibleInventory.some(visible => visible.id === item.id) ? { ...item, isLocked: !allVisibleLocked } : item))} style={{ padding: '5px 8px', background: '#292929', color: '#eee', border: '1px solid #555', cursor: isAnySolving ? 'not-allowed' : 'pointer' }}>
                            {allVisibleLocked ? 'Unlock shown' : 'Lock shown'}
                        </button>
                    </div>}

                    <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '8px', paddingRight: '5px' }}>
                        {Object.entries(visibleInventoryGroups).map(([location, items]) => (
                            <div key={location} style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
                                {importedFile && <div style={{ color: '#bbb', fontSize: '0.8em', fontWeight: 'bold', borderBottom: '1px solid #333', padding: '8px 0 4px' }}>{location} · {items.length}</div>}
                                {items.map(item => (
                                    <InventoryItemRow
                                        key={item.id}
                                        item={item}
                                        isAnySolving={isAnySolving}
                                        updateItemEffect={handleUpdateItemEffect}
                                        updateItemEffectValue={handleUpdateItemEffectValue}
                                        handleBlurEffectValue={handleBlurEffectValue}
                                        onRemove={handleRemoveItem}
                                        onDragStart={handleInventoryDragStart}
                                        onToggleInfinite={handleToggleInfiniteNodes}
                                        onToggleLock={handleToggleLock}
                                        readOnly={Boolean(importedFile)}
                                    />
                                ))}
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            {dragState && <DragGhost dragState={dragState} cellSize={cellSize} />}
        </div>
    );
}
