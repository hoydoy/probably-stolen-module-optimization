import React, { useState, useEffect, useRef, forwardRef, useImperativeHandle, useCallback, useMemo } from 'react';
import type { Stats, GridTier, InventoryItem, FilterGroup, ItemEffect, ModuleTemplate, ModuleColor, Point } from './types';
import { COLOR_MAP, EFFECTS_LIST, MODULE_TEMPLATES, NODE_TEMPLATE } from './constants';
import { formatStatValue, getStatColor, getBaseStats, PRECOMPUTED_OFFSETS } from './utils';
import { useOptimizer } from './hooks/useOptimizer';
import MiniShape from './components/MiniShape';
import SaveFileImporter from './components/SaveFileImporter';

// offload mouse tracking to useRef; performance
const DragGhost = ({ dragState, cellSize }: { dragState: any, cellSize: number }) => {
    const ghostRef = useRef<HTMLDivElement>(null);
    const mousePos = useRef({ x: dragState?.initialMouseX || 0, y: dragState?.initialMouseY || 0 });

    useEffect(() => {
        if (!dragState) return;
        const onMove = (e: MouseEvent) => {
            mousePos.current = { x: e.clientX, y: e.clientY };
            if (ghostRef.current) {
                ghostRef.current.style.left = `${e.clientX - (dragState.dragOffsetX * cellSize) - (cellSize / 2)}px`;
                ghostRef.current.style.top = `${e.clientY - (dragState.dragOffsetY * cellSize) - (cellSize / 2)}px`;
            }
        };
        window.addEventListener('mousemove', onMove);
        return () => window.removeEventListener('mousemove', onMove);
    }, [dragState, cellSize]);

    if (!dragState) return null;

    return (
        <div ref={ghostRef} style={{
            position: 'fixed',
            pointerEvents: 'none',
            zIndex: 9999,
            left: `${mousePos.current.x - (dragState.dragOffsetX * cellSize) - (cellSize / 2)}px`,
            top: `${mousePos.current.y - (dragState.dragOffsetY * cellSize) - (cellSize / 2)}px`
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

const InventoryItemRow = React.memo(({ item, isAnySolving, updateItemEffect, updateItemEffectValue, handleBlurEffectValue, onRemove, onDragStart, onToggleInfinite, onToggleLock }: any) => {
    return (
        <div
            onMouseDown={(e) => onDragStart(e, item)}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', backgroundColor: '#252526', borderRadius: '4px', borderLeft: `4px solid ${COLOR_MAP[item.color as ModuleColor]}`, cursor: (isAnySolving || item.isLocked) ? 'default' : 'grab', opacity: item.isLocked ? 0.6 : 1 }}
        >
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', width: '100%' }}>
                <MiniShape shape={item.shape} colorHex={COLOR_MAP[item.color as ModuleColor]} size="10px" />

                <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: '4px', pointerEvents: 'none' }}>
                    <span style={{ fontSize: '0.9em', fontWeight: 'bold', color: '#eee' }}>{item.displayName}</span>

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
                                            disabled={isAnySolving}
                                            style={{ flex: 1, padding: '2px', fontSize: '0.7em', backgroundColor: '#111', color: '#eee', border: '1px solid #444', borderRadius: '3px', minWidth: '0', cursor: isAnySolving ? 'not-allowed' : 'pointer', opacity: isAnySolving ? 0.6 : 1 }}
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
                                                    disabled={isAnySolving}
                                                    style={{ width: '48px', padding: '1px', fontSize: '0.7em', backgroundColor: '#111', color: '#eee', border: '1px solid #444', borderRadius: '3px', textAlign: 'center', cursor: isAnySolving ? 'not-allowed' : 'auto', opacity: isAnySolving ? 0.6 : 1 }}
                                                />
                                                <span style={{ fontSize: '0.65em', color: '#aaa' }}>%</span>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
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

            <div style={{ display: 'flex', marginLeft: '8px', alignItems: 'center', gap: '4px' }}>
                <button
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => onToggleLock(item.id, !item.isLocked)}
                    disabled={isAnySolving}
                    style={{
                        background: item.isLocked ? 'rgba(255, 77, 77, 0.1)' : 'transparent',
                        border: `1px solid ${item.isLocked ? '#ff4d4d' : '#555'}`,
                        color: item.isLocked ? '#ff4d4d' : '#aaa',
                        borderRadius: '4px',
                        padding: '4px 8px',
                        cursor: isAnySolving ? 'not-allowed' : 'pointer',
                        fontSize: '0.75em',
                        fontWeight: 'bold',
                        minWidth: '60px'
                    }}
                >
                    {item.isLocked ? 'Unlock' : 'Lock'}
                </button>
                <button
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => onRemove(item.id)}
                    disabled={isAnySolving}
                    style={{
                        background: 'none',
                        border: 'none',
                        color: isAnySolving ? '#444' : '#666',
                        cursor: isAnySolving ? 'not-allowed' : 'pointer',
                        fontSize: '1.4em',
                        padding: '8px',
                        marginRight: '-5px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                    }}
                >
                    &times;
                </button>
            </div>
        </div>
    );
});

type StatRanks = { Performance: number, Quality: number, Efficiency: number };

const MachineInstance = React.memo(forwardRef(({
                                                   machineId,
                                                   inventory,
                                                   setInventory,
                                                   getUsedItems,
                                                   dragState,
                                                   setHoverInfo,
                                                   onDuplicate,
                                                   onDelete,
                                                   cellSize,
                                                   onSolvingChange,
                                                   onDragTargetRefChange,
                                                   isAnySolving,
                                                   isThisMachineSolving,
                                                   canDelete
                                               }: any, ref) => {
    // Machine state loading handles fallback defaults from localStorage automatically
    const optimizer = useOptimizer(inventory, setInventory, machineId, getUsedItems, 3, isAnySolving);
    const [localHover, setLocalHover] = useState<{x: number, y: number} | null>(null);
    const [showPaths, setShowPaths] = useState(false);
    const currentSolving = optimizer.isSolving || isThisMachineSolving;

    // Automatically load the machine name from save file
    const [machineType, setMachineType] = useState(() => {
        return localStorage.getItem(`optimizer_machine_type_${machineId}`) || 'Select Machine...';
    });

    useEffect(() => {
        if (machineType !== 'Select Machine...') {
            localStorage.setItem(`optimizer_machine_type_${machineId}`, machineType);
        }
    }, [machineType, machineId]);

    const uniqueModules = useMemo(() => {
        if (!showPaths) return [];
        const mods = new Map<string, InventoryItem>();
        optimizer.board.forEach(row => row.forEach(cell => {
            if (cell && cell !== 'Locked') {
                mods.set(cell.id, cell as InventoryItem);
            }
        }));
        return Array.from(mods.values());
    }, [showPaths, optimizer.board]);

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
            ignoreStats: optimizer.ignoreStats,
            statPriority: optimizer.statPriority
        }),
        isValidPlacement: optimizer.isValidPlacement,
        getBoard: () => optimizer.boardRef.current,
        applyUpdate: optimizer.applyUpdate
    }), [optimizer]);

    useEffect(() => {
        if (dragState && dragState.sourceMachineId === machineId && dragState.initialTarget && localHover === null) {
            setLocalHover({ x: dragState.initialTarget.x, y: dragState.initialTarget.y });
        } else if (!dragState) {
            setLocalHover(null);
        }
    }, [dragState, machineId]);

    useEffect(() => {
        onSolvingChange(machineId, optimizer.isSolving);
    }, [optimizer.isSolving, machineId, onSolvingChange]);

    const getCellStyles = (x: number, y: number, cell: any): React.CSSProperties => {
        if (cell === 'Locked') {
            return { backgroundColor: '#111', border: 'none', boxShadow: 'none' };
        }
        if (!cell) {
            return { backgroundColor: '#2a2a2a', border: 'none', boxShadow: 'inset 0 0 0 1px #333' };
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

    const isTargetingThis = dragState && localHover !== null;
    const previewRootX = isTargetingThis ? localHover!.x - dragState.dragOffsetX : null;
    const previewRootY = isTargetingThis ? localHover!.y - dragState.dragOffsetY : null;

    const currentPreviewValid = isTargetingThis && previewRootX !== null && previewRootY !== null
        ? optimizer.isValidPlacement(dragState.item, previewRootX, previewRootY, dragState.offsets)
        : false;

    return (
        <div style={{
            position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center',
            backgroundColor: '#111', border: '1px solid #333', borderRadius: '8px', padding: '40px 15px 15px 15px',
            width: 'max-content', boxSizing: 'border-box'
        }}>

            <div style={{ position: 'absolute', top: '6px', left: '15px', right: '10px', display: 'flex', justifyContent: 'space-between', zIndex: 10, alignItems: 'center' }}>
                <button
                    onClick={() => setShowPaths(!showPaths)}
                    style={{
                        background: showPaths ? '#333' : 'transparent', border: '1px solid #555',
                        borderRadius: '6px', color: '#aaa', cursor: 'pointer', fontSize: '0.75em',
                        padding: '4px 8px', fontWeight: 'bold'
                    }}
                >
                    {showPaths ? 'Hide Paths' : 'Show Paths'}
                </button>
                {canDelete && (
                    <button
                        onClick={() => onDelete(machineId)}
                        disabled={isAnySolving}
                        style={{
                            background: 'none', border: 'none', color: isAnySolving ? '#444' : '#666',
                            cursor: isAnySolving ? 'not-allowed' : 'pointer', fontSize: '1.2em', padding: '4px 4px'
                        }}
                        title="Delete Machine"
                    >
                        &times;
                    </button>
                )}
            </div>

            <div style={{ visibility: showPaths ? 'hidden' : 'visible', width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
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
                    {optimizer.board.map((row: any, y: number) =>
                        row.map((cell: any, x: number) => {
                            let isPreviewCell = false;

                            if (isTargetingThis && previewRootX !== null && previewRootY !== null) {
                                for (const pt of dragState.offsets) {
                                    if (previewRootX + pt.x === x && previewRootY + pt.y === y) {
                                        isPreviewCell = true;
                                        break;
                                    }
                                }
                            }

                            const isBeingDragged = dragState && dragState.sourceMachineId === machineId && cell && cell !== 'Locked' && dragState.item.id === cell.id;

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
                                        if (isAnySolving || !cell || cell === 'Locked') return;
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
                                            setLocalHover({ x, y });
                                            onDragTargetRefChange({ machineId, x, y });
                                        }
                                    }}
                                    style={{
                                        width: `${cellSize}px`,
                                        height: `${cellSize}px`,
                                        ...getCellStyles(x, y, cell),
                                        opacity: isBeingDragged ? 0.3 : 1,
                                        cursor: cell && cell !== 'Locked' ? (isAnySolving ? 'not-allowed' : 'grab') : 'default',
                                        boxSizing: 'border-box',
                                        position: 'relative'
                                    }}
                                >
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
                    <select
                        title={machineType !== "Select Machine..." ? machineType : undefined}
                        value={machineType}
                        onChange={(e) => {
                            const selected = e.target.value;
                            const allKeys = Object.keys(localStorage).filter(k => k.startsWith('optimizer_machine_type_'));
                            let max = 0;

                            const escapeRegex = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                            const regex = new RegExp(`(?:^|\\s|>\\s*)${escapeRegex(selected)}\\s+(\\d+)$`);

                            allKeys.forEach(k => {
                                if (k === `optimizer_machine_type_${machineId}`) return;
                                const val = localStorage.getItem(k);
                                if (val) {
                                    const match = val.match(regex);
                                    if (match) {
                                        const num = parseInt(match[1], 10);
                                        if (num > max) max = num;
                                    }
                                }
                            });
                            setMachineType(`${selected} ${max + 1}`);
                        }}
                        disabled={currentSolving}
                        style={{
                            width: '100%', padding: '6px 8px', backgroundColor: '#222', color: '#eee',
                            border: '1px solid #333', borderRadius: '6px', fontSize: '0.85em',
                            outline: 'none', cursor: currentSolving ? 'not-allowed' : 'pointer',
                            textOverflow: 'ellipsis', whiteSpace: 'nowrap', overflow: 'hidden'
                        }}
                    >
                        <option value="Select Machine..." disabled>Select Machine...</option>
                        {machineType !== "Select Machine..." && !["Moisture Farm", "Furnace", "Water Purifier", "Alarm System", "AgeWell", "Cryptographic Desequencer", "Mirage Projector"].includes(machineType) && (
                            <option value={machineType}>
                                {machineType.length > 45 ? '...' + machineType.substring(machineType.length - 42) : machineType}
                            </option>
                        )}
                        <option value="Moisture Farm">Moisture Farm</option>
                        <option value="Furnace">Furnace</option>
                        <option value="Water Purifier">Water Purifier</option>
                        <option value="Alarm System">Alarm System</option>
                        <option value="AgeWell">AgeWell</option>
                        <option value="Cryptographic Desequencer">Cryptographic Desequencer</option>
                        <option value="Mirage Projector">Mirage Projector</option>
                    </select>

                    <div style={{ display: 'flex', justifyContent: 'center' }}>
                        <div style={{ display: 'flex', gap: '5px', backgroundColor: '#222', padding: '5px', borderRadius: '6px' }}>
                            {[1, 2, 3].map((t) => (
                                <button key={t} onClick={() => optimizer.handleTierChange(t as GridTier)} disabled={currentSolving} style={{ padding: '6px 12px', fontSize: '0.85em', backgroundColor: optimizer.tier === t ? '#555' : 'transparent', color: 'white', border: 'none', borderRadius: '4px', cursor: currentSolving ? 'not-allowed' : 'pointer' }}>
                                    Tier {t}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div style={{ display: 'flex', gap: '5px', backgroundColor: '#222', padding: '6px 8px', borderRadius: '6px', border: '1px solid #333', justifyContent: 'space-between', width: '100%', boxSizing: 'border-box' }}>
                        {(['Performance', 'Quality', 'Efficiency'] as const).map((stat, idx) => (
                            <div key={stat} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', flex: 1, borderRight: idx < 2 ? '1px solid #444' : 'none' }}>
                                <span style={{ fontSize: '0.6em', color: '#aaa', textTransform: 'uppercase', fontWeight: 'bold', textAlign: 'center' }}>{stat}</span>
                                <div style={{ display: 'flex', gap: '8px' }}>
                                    <label style={{ fontSize: '0.7em', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', cursor: 'pointer', opacity: optimizer.ignoreStats[stat] ? 0.4 : 1 }}>
                                        <input
                                            type="checkbox"
                                            checked={optimizer.maximizeStats[stat]}
                                            onChange={() => optimizer.setMaximizeStats((prev: any) => ({ ...prev, [stat]: !prev[stat] }))}
                                            disabled={currentSolving || optimizer.ignoreStats[stat]}
                                            style={{ margin: 0, cursor: (currentSolving || optimizer.ignoreStats[stat]) ? 'not-allowed' : 'pointer' }}
                                        /> Max
                                    </label>
                                    <label
                                        title={`Ignore ${stat} entirely — it stops counting toward the score in either direction, so the optimizer is free to let it go as negative as it likes.`}
                                        style={{ fontSize: '0.7em', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', cursor: 'pointer' }}
                                    >
                                        <input
                                            type="checkbox"
                                            checked={optimizer.ignoreStats[stat]}
                                            onChange={() => optimizer.setIgnoreStats((prev: any) => {
                                                const next = { ...prev, [stat]: !prev[stat] };
                                                if (next[stat]) {
                                                    optimizer.setMaximizeStats((m: any) => ({ ...m, [stat]: false }));
                                                    optimizer.setTargetStats((t: any) => ({ ...t, [stat]: null }));
                                                }
                                                return next;
                                            })}
                                            disabled={currentSolving}
                                            style={{ margin: 0, cursor: currentSolving ? 'not-allowed' : 'pointer' }}
                                        /> Ign
                                    </label>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '2px', opacity: optimizer.ignoreStats[stat] ? 0.4 : 1 }}>
                                    <span style={{ fontSize: '0.65em', color: '#888' }}>Tar:</span>
                                    <input
                                        type="number"
                                        value={optimizer.targetStats[stat] ?? ''}
                                        onChange={(e) => optimizer.setTargetStats((prev: any) => ({ ...prev, [stat]: e.target.value === '' ? null : Number(e.target.value) }))}
                                        disabled={currentSolving || optimizer.ignoreStats[stat]}
                                        style={{ width: '35px', padding: '2px', fontSize: '0.7em', backgroundColor: '#111', color: '#eee', border: '1px solid #444', borderRadius: '3px', textAlign: 'center' }}
                                    />
                                    <span style={{ fontSize: '0.65em', color: '#888' }}>%</span>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '2px', opacity: optimizer.ignoreStats[stat] ? 0.4 : 1 }}>
                                    <span style={{ fontSize: '0.65em', color: '#888' }}>Pri:</span>
                                    <select
                                        title={`Priority for ${stat} — 1 matters most.`}
                                        value={optimizer.statPriority[stat]}
                                        onChange={(e) => optimizer.setStatPriority((prev: StatRanks) => ({ ...prev, [stat]: Number(e.target.value) }))}
                                        disabled={currentSolving || optimizer.ignoreStats[stat]}
                                        style={{ padding: '1px', fontSize: '0.7em', backgroundColor: '#111', color: '#eee', border: '1px solid #444', borderRadius: '3px', cursor: (currentSolving || optimizer.ignoreStats[stat]) ? 'not-allowed' : 'pointer' }}
                                    >
                                        <option value={1}>1</option>
                                        <option value={2}>2</option>
                                        <option value={3}>3</option>
                                    </select>
                                </div>
                            </div>
                        ))}
                    </div>

                    <div style={{ display: 'flex', gap: '5px', width: '100%' }}>
                        <button
                            onClick={() => {
                                if (currentSolving) {
                                    optimizer.stopOptimization();
                                    onSolvingChange(machineId, false);
                                } else {
                                    optimizer.runOptimization();
                                }
                            }}
                            disabled={inventory.length === 0 && !currentSolving}
                            style={{
                                flex: 2, padding: '8px', fontSize: '0.85em',
                                backgroundColor: currentSolving ? '#ff4d4d' : '#4caf50',
                                color: 'white', border: 'none', borderRadius: '6px', fontWeight: 'bold',
                                cursor: (inventory.length === 0 && !currentSolving) ? 'not-allowed' : 'pointer',
                                opacity: (inventory.length === 0 && !currentSolving) ? 0.5 : 1
                            }}
                        >
                            {currentSolving ? 'Stop Optimizer' : 'Run Optimizer'}
                        </button>
                        <button
                            onClick={optimizer.resetBoard}
                            disabled={isAnySolving}
                            style={{ flex: 1, padding: '8px', fontSize: '0.85em', backgroundColor: '#333', color: 'white', border: '1px solid #555', borderRadius: '6px', cursor: isAnySolving ? 'not-allowed' : 'pointer' }}
                        >
                            Clear
                        </button>
                        <button
                            onClick={() => onDuplicate(machineId)}
                            disabled={isAnySolving}
                            style={{ flex: 1, padding: '8px', fontSize: '0.85em', backgroundColor: '#333', color: 'white', border: '1px solid #555', borderRadius: '6px', cursor: isAnySolving ? 'not-allowed' : 'pointer' }}
                        >
                            Duplicate
                        </button>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '5px', width: '100%', boxSizing: 'border-box' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flex: '7' }}>
                            <span style={{ fontSize: '0.75em', color: '#888' }}>Code:</span>
                            <input
                                type="text"
                                value={optimizer.solutionCode}
                                onChange={(e) => optimizer.setSolutionCode(e.target.value)}
                                placeholder="Solution code..."
                                disabled={isAnySolving}
                                style={{ flex: 1, minWidth: 0, padding: '6px', fontSize: '0.75em', backgroundColor: '#111', color: '#eee', border: '1px solid #555', borderRadius: '6px' }}
                            />
                        </div>
                        <div style={{ display: 'flex', gap: '5px', flex: '3' }}>
                            <button
                                onClick={() => optimizer.importSolution(optimizer.solutionCode)}
                                disabled={!optimizer.solutionCode || isAnySolving}
                                style={{ flex: 1, padding: '6px', fontSize: '0.85em', backgroundColor: '#333', color: 'white', border: '1px solid #555', borderRadius: '6px', cursor: (!optimizer.solutionCode || isAnySolving) ? 'not-allowed' : 'pointer' }}
                            >
                                Import
                            </button>
                            <button
                                onClick={() => navigator.clipboard.writeText(optimizer.solutionCode)}
                                disabled={!optimizer.solutionCode}
                                style={{ flex: 1, padding: '6px', fontSize: '0.85em', backgroundColor: '#333', color: 'white', border: '1px solid #555', borderRadius: '6px', cursor: !optimizer.solutionCode ? 'not-allowed' : 'pointer' }}
                            >
                                Copy
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {showPaths && (
                <div style={{
                    position: 'absolute', top: '40px', left: '15px', right: '15px', bottom: '15px',
                    backgroundColor: '#1a1a1a', borderRadius: '6px', border: '1px solid #333',
                    overflowY: 'auto', padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px',
                    zIndex: 5
                }}>
                    <h4 style={{ margin: '0 0 10px 0', color: '#ccc', textAlign: 'center', fontSize: '0.9em', textTransform: 'uppercase' }}>Module Paths</h4>
                    {uniqueModules.length > 0 ? uniqueModules.map(mod => {
                        const effs = mod.effects.filter(e => e !== 'None');
                        const effStr = effs.length > 0
                            ? ` (${effs.map(e => `${e}${e === 'Learning Algorithm' || e === 'Degrading' ? ` ${mod.effectValues[mod.effects.indexOf(e)]}%` : ''}`).join(', ')})`
                            : '';
                        const actualPath = (mod as any).originalPath || 'Manual';

                        return (
                            <div key={mod.id} style={{ padding: '8px', backgroundColor: '#252526', borderRadius: '4px', borderLeft: `3px solid ${COLOR_MAP[mod.color as ModuleColor]}` }}>
                                <div style={{ fontWeight: 'bold', fontSize: '0.85em', color: '#eee', marginBottom: '4px' }}>
                                    {mod.displayName}<span style={{ color: '#aaa', fontWeight: 'normal' }}>{effStr}</span>
                                </div>
                                <div style={{ fontSize: '0.75em', color: '#888', wordBreak: 'break-word' }}>
                                    {actualPath}
                                </div>
                            </div>
                        );
                    }) : (
                        <div style={{ color: '#888', fontSize: '0.85em', textAlign: 'center', marginTop: '20px' }}>No modules placed.</div>
                    )}
                </div>
            )}
        </div>
    );
}))

// Rendering every row of a very large inventory costs a lot
const MAX_VISIBLE_INVENTORY_ROWS = 255;

const createInventoryItem = (template: ModuleTemplate): InventoryItem => {
    const base = getBaseStats(template);
    const maxPositiveBase = Math.max(
        base.Performance > 0 ? base.Performance : 0,
        base.Quality > 0 ? base.Quality : 0,
        base.Efficiency > 0 ? base.Efficiency : 0
    );
    const defaultDoubleBase = Math.floor(maxPositiveBase * 2);

    return {
        id: `${template.shape}_${template.color}_${Math.random().toString(36).substring(2, 8)}`,
        shape: template.shape,
        color: template.color,
        displayName: template.displayName,
        effects: ['None', 'None'],
        effectValues: [defaultDoubleBase, defaultDoubleBase],
        originalPath: 'Manual'
    } as any;
};

export default function ModuleInventoryUI() {
    const [inventory, setInventory] = useState<InventoryItem[]>(() => {
        const savedInventory = localStorage.getItem('optimizer_inventory');
        if (savedInventory) {
            try { return JSON.parse(savedInventory); } catch (e) { return []; }
        }
        return [];
    });

    useEffect(() => {
        localStorage.setItem('optimizer_inventory', JSON.stringify(inventory));
    }, [inventory]);

    const [machines, setMachines] = useState<{ id: string }[]>(() => {
        const saved = localStorage.getItem('optimizer_machine_list');
        if (saved) {
            try { return JSON.parse(saved); } catch (e) { }
        }
        return [{ id: `m_${Math.random().toString(36).substring(2,8)}` }];
    });

    useEffect(() => {
        localStorage.setItem('optimizer_machine_list', JSON.stringify(machines));
    }, [machines]);

    const machinesRef = useRef<Record<string, any>>({});
    const [solvingStates, setSolvingStates] = useState<Record<string, boolean>>({});

    const getUsedItems = useCallback((excludeId?: string | null) => {
        const used = new Set<string>();
        Object.entries(machinesRef.current).forEach(([id, m]: [string, any]) => {
            if (excludeId && id === excludeId) return;
            if (m) {
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

    const [filterGroup, setFilterGroup] = useState<FilterGroup>('All');
    const [filterSize, setFilterSize] = useState<'All' | 3 | 4 | 5>('All');

    const [invFilterGroup, setInvFilterGroup] = useState<FilterGroup | 'Placed' | 'NotPlaced'>('All');
    const [invFilterSize, setInvFilterSize] = useState<'All' | 3 | 4 | 5>('All');
    const [invFilterEffect, setInvFilterEffect] = useState<ItemEffect | 'All'>('All');

    const [hoverInfo, setHoverInfo] = useState<{ x: number, y: number, cell: InventoryItem, stats?: Stats } | null>(null);

    const [dragState, setDragState] = useState<{
        item: InventoryItem;
        sourceMachineId: string | null;
        offsets: Point[];
        dragOffsetX: number;
        dragOffsetY: number;
        initialMouseX: number;
        initialMouseY: number;
        initialTarget?: any;
    } | null>(null);

    const dragHoverTargetRef = useRef<{ machineId: string | null, x: number, y: number } | null>(null);
    const setDragTargetRefChange = useCallback((target: any) => {
        dragHoverTargetRef.current = target;
    }, []);

    const expandedInventory = useMemo(() => {
        const expanded: InventoryItem[] = [];
        for (const item of inventory) {
            expanded.push(item);
            if (item.shape === 'Node1x2' && item.isInfinite) {
                const cloneCount = 17 * Math.max(1, machines.length);
                for (let i = 0; i < cloneCount; i++) {
                    expanded.push({ ...item, id: `${item.id}_clone_${i}` });
                }
            }
        }
        return expanded;
    }, [inventory, machines.length]);

    const hoveredItem = hoverInfo ? (expandedInventory.find(i => i.id === hoverInfo.cell.id) || hoverInfo.cell) : null;
    const dragRef = useRef(dragState);

    const isAnySolving = Object.values(solvingStates).some(s => s);

    useEffect(() => { dragRef.current = dragState; }, [dragState]);

    useEffect(() => {
        const handleAppDragStart = (e: any) => {
            setDragState(e.detail);
            if (e.detail.initialTarget) {
                dragHoverTargetRef.current = e.detail.initialTarget;
            }
        };
        window.addEventListener('appDragStart', handleAppDragStart);
        return () => window.removeEventListener('appDragStart', handleAppDragStart);
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
                    }
                } else {
                    const machine = machinesRef.current[currentTarget.machineId];

                    if (currentDrag.item.isLocked && currentDrag.sourceMachineId !== currentTarget.machineId) {
                        // Prevent moving a locked module into a different machine
                    } else if (machine) {
                        const targetX = currentTarget.x - currentDrag.dragOffsetX;
                        const targetY = currentTarget.y - currentDrag.dragOffsetY;

                        if (machine.isValidPlacement(currentDrag.item, targetX, targetY, currentDrag.offsets)) {
                            Object.keys(machinesRef.current).forEach(mId => {
                                if (mId !== currentTarget.machineId) {
                                    machinesRef.current[mId]?.remove(currentDrag.item.id);
                                }
                            });
                            machine.place(currentDrag.item, targetX, targetY, currentDrag.offsets);
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

            let rawNewOffsets = currentDrag.offsets.map(transform);
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
    }, [!!dragState]);

    const addPieceToInventory = (template: ModuleTemplate) => {
        setInventory((prev) => [createInventoryItem(template), ...prev]);
    };

    const handleToggleInfiniteNodes = useCallback((isInfinite: boolean) => {
        setInventory(prev => prev.map(invItem =>
            invItem.shape === 'Node1x2' ? { ...invItem, isInfinite } : invItem
        ));
    }, []);

    const handleToggleLock = useCallback((itemId: string, isLocked: boolean) => {
        setInventory(prev => prev.map(i => i.id === itemId ? { ...i, isLocked } : i));
    }, []);

    const getMaxCustomValue = (item: InventoryItem, effectIndex: number, newEffect?: ItemEffect) => {
        const base = getBaseStats(item);
        let maxPositiveBase = Math.max(
            base.Performance > 0 ? base.Performance : 0,
            base.Quality > 0 ? base.Quality : 0,
            base.Efficiency > 0 ? base.Efficiency : 0
        );

        const effectToEval = newEffect || item.effects[effectIndex];

        if (effectToEval === 'Learning Algorithm') {
            if (effectIndex === 1) {
                const first = item.effects[0];
                if (first === 'Premium') maxPositiveBase *= 1.2;
                else if (first === 'Inferior') maxPositiveBase *= 0.8;
                else if (first === 'Overcharged') maxPositiveBase *= 2.0;
                else if (first === 'Negative Feedback') maxPositiveBase *= 1.25;
            }
            return Math.floor(maxPositiveBase * 2);
        } else if (effectToEval === 'Degrading') {
            const otherEffect = effectIndex === 0 ? item.effects[1] : item.effects[0];
            if (otherEffect === 'Premium') maxPositiveBase *= 1.2;
            else if (otherEffect === 'Inferior') maxPositiveBase *= 0.8;
            else if (otherEffect === 'Overcharged') maxPositiveBase *= 2.0;
            else if (otherEffect === 'Negative Feedback') maxPositiveBase *= 1.25;

            return Math.floor(maxPositiveBase * 2);
        }
        return Math.floor(maxPositiveBase * 2);
    };

    const handleUpdateItemEffect = useCallback((item: InventoryItem, effectIndex: 0 | 1, newEffect: ItemEffect) => {
        setInventory(prev => prev.map(invItem => {
            if (invItem.id === item.id) {
                const updatedEffects: [ItemEffect, ItemEffect] = [...invItem.effects] as [ItemEffect, ItemEffect];
                updatedEffects[effectIndex] = newEffect;

                const updatedValues: [number, number] = [...invItem.effectValues] as [number, number];

                if (newEffect === 'Learning Algorithm' || newEffect === 'Degrading') {
                    const tempItem = { ...invItem, effects: updatedEffects };
                    updatedValues[effectIndex] = getMaxCustomValue(tempItem, effectIndex);
                }

                const otherIndex = effectIndex === 0 ? 1 : 0;
                const otherEffect = updatedEffects[otherIndex];
                if (otherEffect === 'Learning Algorithm' || otherEffect === 'Degrading') {
                    const tempItem = { ...invItem, effects: updatedEffects };
                    const maxOther = getMaxCustomValue(tempItem, otherIndex);
                    if (updatedValues[otherIndex] > maxOther) {
                        updatedValues[otherIndex] = maxOther;
                    }
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
        const maxLimit = getMaxCustomValue(item, effectIndex);
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
        Object.values(machinesRef.current).forEach((m: any) => m?.remove(itemId));
    }, []);

    const handleInventoryDragStart = useCallback((e: React.MouseEvent, item: InventoryItem) => {
        if (isAnySolving || item.isLocked) { e.preventDefault(); return; }
        e.preventDefault();
        const offsets = PRECOMPUTED_OFFSETS.get(item.shape)?.[0] || [{x: 0, y: 0}];

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

    const allUsedItems = getUsedItems(null);
    const filteredInventory = inventory.filter(item => {
        if (invFilterGroup === 'Placed') {
            const isPlaced = allUsedItems.has(item.id) || (item.isInfinite && Array.from(allUsedItems).some(usedId => usedId.startsWith(item.id + '_clone_')));
            if (!isPlaced) return false;
        } else if (invFilterGroup === 'NotPlaced') {
            const isPlaced = allUsedItems.has(item.id) || (item.isInfinite && Array.from(allUsedItems).some(usedId => usedId.startsWith(item.id + '_clone_')));
            if (isPlaced) return false;
        } else if (invFilterGroup !== 'All') {
            const template = MODULE_TEMPLATES.find(m => m.shape === item.shape && m.color === item.color);
            const group = template ? template.group : 'All';
            if (group !== invFilterGroup) return false;
        }
        if (invFilterSize !== 'All') {
            const offsets = PRECOMPUTED_OFFSETS.get(item.shape)?.[0];
            const size = offsets ? offsets.length : 0;
            if (size !== invFilterSize) return false;
        }
        if (invFilterEffect !== 'All') {
            if (invFilterEffect === 'None') {
                if (item.effects[0] !== 'None' || item.effects[1] !== 'None') return false;
            } else {
                if (item.effects[0] !== invFilterEffect && item.effects[1] !== invFilterEffect) return false;
            }
        }
        return true;
    });

    const visibleInventory = filteredInventory.length > MAX_VISIBLE_INVENTORY_ROWS
        ? filteredInventory.slice(0, MAX_VISIBLE_INVENTORY_ROWS)
        : filteredInventory;
    const hiddenInventoryCount = filteredInventory.length - visibleInventory.length;

    const allDisplayedLocked = filteredInventory.length > 0 && filteredInventory.every(item => item.isLocked);

    const handleToggleDisplayLock = () => {
        const targetState = !allDisplayedLocked;
        const filteredIds = new Set(filteredInventory.map(i => i.id));

        setInventory(prev => prev.map(item =>
            filteredIds.has(item.id) ? { ...item, isLocked: targetState } : item
        ));
    };

    const handleImportSave = useCallback((newItems: InventoryItem[], newMachines: { id: string, boardIds: (string | null)[][], machineType: string, tier: GridTier }[]) => {
        setInventory(prev => [...prev, ...newItems]);

        newMachines.forEach(m => {
            localStorage.setItem(`optimizer_machine_${m.id}`, JSON.stringify({ boardIds: m.boardIds, tier: m.tier }));
            localStorage.setItem(`optimizer_machine_type_${m.id}`, m.machineType);
        });

        if (newMachines.length > 0) {
            setMachines(prev => {
                const emptyMachineIds = new Set<string>();

                prev.forEach(m => {
                    const machine = machinesRef.current[m.id];
                    let isEmpty = true;

                    if (machine) {
                        const board = machine.getBoard();
                        if (board) {
                            for (let y = 0; y < 5; y++) {
                                for (let x = 0; x < 7; x++) {
                                    const cell = board[y][x];
                                    if (cell && cell !== 'Locked') {
                                        isEmpty = false;
                                        break;
                                    }
                                }
                                if (!isEmpty) break;
                            }
                        }
                    } else {
                        const saved = localStorage.getItem(`optimizer_machine_${m.id}`);
                        if (saved) {
                            try {
                                const parsed = JSON.parse(saved);
                                if (parsed.boardIds) {
                                    for (let y = 0; y < 5; y++) {
                                        for (let x = 0; x < 7; x++) {
                                            const cell = parsed.boardIds[y]?.[x];
                                            if (cell && cell !== 'Locked') {
                                                isEmpty = false;
                                                break;
                                            }
                                        }
                                        if (!isEmpty) break;
                                    }
                                }
                            } catch (e) {}
                        }
                    }

                    if (isEmpty) {
                        emptyMachineIds.add(m.id);
                        localStorage.removeItem(`optimizer_machine_${m.id}`);
                        localStorage.removeItem(`optimizer_machine_type_${m.id}`);
                        delete machinesRef.current[m.id];
                    }
                });

                setTimeout(() => {
                    setSolvingStates(s => {
                        const ns = { ...s };
                        emptyMachineIds.forEach(id => delete ns[id]);
                        return ns;
                    });
                }, 0);

                const keptMachines = prev.filter(m => !emptyMachineIds.has(m.id));
                return [...keptMachines, ...newMachines.map(m => ({ id: m.id }))];
            });
        }
    }, []);

    const shouldPushNodeToEnd = filterGroup !== 'All';
    const catalogDisplayList = shouldPushNodeToEnd
        ? [...filteredModules, NODE_TEMPLATE]
        : [NODE_TEMPLATE, ...filteredModules];

    const handleRunAll = () => {
        if (isAnySolving) {
            Object.values(machinesRef.current).forEach((m: any) => m?.stop());
        } else {
            Object.values(machinesRef.current).forEach((m: any) => m?.run());
        }
    };

    const handleClearAll = () => {
        Object.values(machinesRef.current).forEach((m: any) => m?.clear());
    };

    const handleAddMachine = () => {
        setMachines(prev => [...prev, { id: `m_${Math.random().toString(36).substring(2,8)}` }]);
    };

    const handleClearAllMachines = () => {
        machines.forEach(m => {
            localStorage.removeItem(`optimizer_machine_${m.id}`);
            localStorage.removeItem(`optimizer_machine_type_${m.id}`);
        });
        setMachines([{ id: `m_${Math.random().toString(36).substring(2,8)}` }]);
        machinesRef.current = {};
        setSolvingStates({});
    };

    const handleDuplicateMachine = useCallback((machineId: string) => {
        const machine = machinesRef.current[machineId];
        if (machine) {
            setMachines(prev => [...prev, { id: `m_${Math.random().toString(36).substring(2,8)}` }]);
        }
    }, []);

    const handleDeleteMachine = useCallback((machineId: string) => {
        setMachines(prev => prev.filter(m => m.id !== machineId));
        delete machinesRef.current[machineId];
        setSolvingStates(prev => {
            const next = { ...prev };
            delete next[machineId];
            return next;
        });
        localStorage.removeItem(`optimizer_machine_${machineId}`);
        localStorage.removeItem(`optimizer_machine_type_${machineId}`);
    }, []);

    const handleSolvingChange = useCallback((id: string, solving: boolean) => {
        setSolvingStates(prev => {
            if (prev[id] === solving) return prev;
            return { ...prev, [id]: solving };
        });
    }, []);

    const cellSize = machines.length <= 2 ? 50 : (machines.length <= 4 ? 40 : 35);

    const [copiedPath, setCopiedPath] = useState(false);

    return (
        <div className="main-container">

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
                    border: `1px solid ${COLOR_MAP[hoveredItem.color]}`,
                    padding: '10px 15px',
                    borderRadius: '6px',
                    zIndex: 1000,
                    pointerEvents: 'none',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                    minWidth: '150px'
                }}>
                    <div style={{ fontWeight: 'bold', marginBottom: '4px', color: COLOR_MAP[hoveredItem.color] }}>
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

                    {hoveredItem.originalPath && (
                        <div style={{ marginTop: '8px', paddingTop: '6px', borderTop: '1px solid #333', fontSize: '0.75em', color: '#888', wordBreak: 'break-word', maxWidth: '250px' }}>
                            <span style={{ color: '#aaa' }}>Path: </span>{hoveredItem.originalPath}
                        </div>
                    )}
                </div>
            )}

            {/* Main Grid & Controls */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                <div style={{ width: '120px' }}></div>
                <div style={{ color: '#888', fontSize: '0.85em', textAlign: 'center', flex: 1 }}>
                    Tip: While dragging a module, press Q, E, or F to rotate or flip.
                </div>
                <div style={{ width: '120px', display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                        onClick={handleClearAllMachines}
                        disabled={isAnySolving}
                        style={{ padding: '6px 12px', backgroundColor: 'rgba(255, 77, 77, 0.1)', color: '#ff4d4d', border: '1px solid #ff4d4d', borderRadius: '6px', cursor: isAnySolving ? 'not-allowed' : 'pointer', fontSize: '0.8em' }}
                    >
                        Delete All
                    </button>
                </div>
            </div>

            <div className="machines-container">
                {machines.map(m => (
                    <MachineInstance
                        key={m.id}
                        machineId={m.id}
                        ref={(el: any) => { if (el) machinesRef.current[m.id] = el; }}
                        inventory={expandedInventory}
                        setInventory={setInventory}
                        getUsedItems={getUsedItems}
                        dragState={dragState}
                        setHoverInfo={setHoverInfo}
                        onDuplicate={handleDuplicateMachine}
                        onDelete={handleDeleteMachine}
                        cellSize={cellSize}
                        onSolvingChange={handleSolvingChange}
                        onDragTargetRefChange={setDragTargetRefChange}
                        isAnySolving={isAnySolving}
                        isThisMachineSolving={solvingStates[m.id] || false}
                        canDelete={machines.length > 1}
                    />
                ))}
            </div>

            <div style={{ display: 'flex', gap: '15px', justifyContent: 'center', marginTop: '30px', width: '100%', flexWrap: 'wrap' }}>
                <button
                    onClick={handleRunAll}
                    disabled={inventory.length === 0 && !isAnySolving}
                    style={{
                        padding: '10px 24px',
                        backgroundColor: isAnySolving ? '#ff4d4d' : '#4caf50',
                        color: 'white',
                        border: isAnySolving ? '1px solid #ff4d4d' : '1px solid #2e4a35',
                        borderRadius: '6px',
                        fontWeight: 'bold',
                        cursor: (inventory.length === 0 && !isAnySolving) ? 'not-allowed' : 'pointer',
                        opacity: (inventory.length === 0 && !isAnySolving) ? 0.5 : 1,
                        fontSize: '0.95em'
                    }}
                >
                    {isAnySolving ? 'Stop All Optimizers' : 'Run All Optimizers'}
                </button>
                <button
                    onClick={handleClearAll}
                    disabled={isAnySolving}
                    style={{ padding: '10px 24px', backgroundColor: '#333333', color: '#eee', border: '1px solid #555555', borderRadius: '6px', cursor: isAnySolving ? 'not-allowed' : 'pointer', fontSize: '0.95em' }}
                >
                    Clear All
                </button>
                <button
                    onClick={handleAddMachine}
                    disabled={isAnySolving}
                    style={{ padding: '10px 24px', backgroundColor: '#333333', color: '#eee', border: '1px solid #555555', borderRadius: '6px', cursor: isAnySolving ? 'not-allowed' : 'pointer', fontSize: '0.95em' }}
                >
                    + Add Machine
                </button>
                <SaveFileImporter onImport={handleImportSave} />
            </div>

            <div
                title="Click to copy path"
                onClick={() => {
                    navigator.clipboard.writeText('%USERPROFILE%\\AppData\\LocalLow\\Questing Goose Studio\\Probably Stolen');
                    setCopiedPath(true);
                    setTimeout(() => setCopiedPath(false), 2000);
                }}
                onMouseEnter={(e) => e.currentTarget.style.color = '#eee'} // hover
                onMouseLeave={(e) => e.currentTarget.style.color = '#888'} // default
                style={{
                    marginTop: '8px',
                    color: '#888',
                    fontSize: '0.85em',
                    textAlign: 'center',
                    cursor: 'pointer',
                    transition: 'color 0.15s ease-in-out'
                }}
            >
                {copiedPath
                    ? "Path copied to clipboard!"
                    : "Default save_#.es3 file path: %USERPROFILE%\\AppData\\LocalLow\\Questing Goose Studio\\Probably Stolen"
                }
            </div>

            {/* Catalog & Inventory */}
            <div className="bottom-layout">
                {/* Catalog */}
                <div style={{ flex: '2', backgroundColor: '#1c1c1e', padding: '20px', borderRadius: '8px', border: '1px solid #2c2c2e', display: 'flex', flexDirection: 'column' }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '15px', paddingBottom: '15px', borderBottom: '1px solid #333' }}>
                        <select value={filterGroup} onChange={(e) => setFilterGroup(e.target.value as FilterGroup)} style={{ flex: 1, minWidth: '150px', padding: '8px 12px', backgroundColor: '#333', color: 'white', border: '1px solid #555', borderRadius: '4px', outline: 'none' }}>
                            <option value="All">All Module Groups</option>
                            <option value="Performance">Performance (Red)</option>
                            <option value="Quality">Quality (Yellow)</option>
                            <option value="Efficiency">Efficiency (Green)</option>
                            <option value="Special">Special Modules</option>
                        </select>
                        <select value={filterSize} onChange={(e) => setFilterSize(e.target.value === 'All' ? 'All' : Number(e.target.value) as any)} style={{ flex: 1, minWidth: '150px', padding: '8px 12px', backgroundColor: '#333', color: 'white', border: '1px solid #555', borderRadius: '4px', outline: 'none' }}>
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
                                        padding: '16px 12px', width: '135px', backgroundColor: '#252526',
                                        border: `1px solid ${COLOR_MAP[template.color]}`, borderRadius: '6px',
                                        display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer'
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
                </div>

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
                        <span style={{ color: '#888', fontSize: '0.9em' }}>
                            {filteredInventory.length.toLocaleString()} Selected
                            {hiddenInventoryCount > 0 && <span style={{ color: '#666' }}> (showing {MAX_VISIBLE_INVENTORY_ROWS})</span>}
                        </span>
                        <button
                            onClick={() => { setInventory([]); handleClearAll(); }}
                            disabled={isAnySolving || inventory.length === 0}
                            style={{
                                background: 'none', border: 'none', color: (isAnySolving || inventory.length === 0) ? '#555' : '#ff4d4d',
                                cursor: (isAnySolving || inventory.length === 0) ? 'not-allowed' : 'pointer',
                                fontSize: '0.85em', textDecoration: 'underline'
                            }}
                        >
                            Clear List
                        </button>
                    </div>

                    {/* Inventory Filters */}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '10px' }}>
                        <select value={invFilterGroup} onChange={(e) => setInvFilterGroup(e.target.value as FilterGroup | 'Placed' | 'NotPlaced')} style={{ flex: 1, minWidth: '110px', padding: '6px', backgroundColor: '#333', color: 'white', border: '1px solid #555', borderRadius: '4px', outline: 'none', fontSize: '0.8em' }}>
                            <option value="All">All Groups</option>
                            <option value="Placed">Placed in Machine</option>
                            <option value="NotPlaced">Not Placed in Machine</option>
                            <option value="Performance">Performance</option>
                            <option value="Quality">Quality</option>
                            <option value="Efficiency">Efficiency</option>
                            <option value="Special">Special</option>
                        </select>
                        <select value={invFilterSize} onChange={(e) => setInvFilterSize(e.target.value === 'All' ? 'All' : Number(e.target.value) as any)} style={{ flex: 1, minWidth: '100px', padding: '6px', backgroundColor: '#333', color: 'white', border: '1px solid #555', borderRadius: '4px', outline: 'none', fontSize: '0.8em' }}>
                            <option value="All">All Sizes</option>
                            <option value={3}>Size 3</option>
                            <option value={4}>Size 4</option>
                            <option value={5}>Size 5</option>
                        </select>
                        <select value={invFilterEffect} onChange={(e) => setInvFilterEffect(e.target.value as ItemEffect | 'All')} style={{ flex: 1, minWidth: '120px', padding: '6px', backgroundColor: '#333', color: 'white', border: '1px solid #555', borderRadius: '4px', outline: 'none', fontSize: '0.8em' }}>
                            <option value="All">All Effects</option>
                            {EFFECTS_LIST.map(eff => <option key={eff} value={eff}>{eff === 'None' ? 'No Effect' : eff}</option>)}
                        </select>
                    </div>

                    <div style={{ display: 'flex', gap: '8px', marginBottom: '15px' }}>
                        <button onClick={handleToggleDisplayLock} disabled={isAnySolving || filteredInventory.length === 0} style={{ flex: 1, padding: '6px', backgroundColor: '#2d2d2d', color: '#eee', border: '1px solid #444', borderRadius: '4px', fontSize: '0.8em', cursor: (isAnySolving || filteredInventory.length === 0) ? 'not-allowed' : 'pointer' }}>
                            {allDisplayedLocked ? 'Unlock Displayed' : 'Lock Displayed'}
                        </button>
                    </div>

                    <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '8px', paddingRight: '5px' }}>
                        {visibleInventory.map((item) => (
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
                            />
                        ))}

                        {hiddenInventoryCount > 0 && (
                            <div style={{ padding: '10px 12px', backgroundColor: '#252526', borderRadius: '4px', color: '#888', fontSize: '0.8em', textAlign: 'center' }}>
                                + {hiddenInventoryCount.toLocaleString()} more not shown.
                                <br />
                                The optimizer still uses every module — only this list is capped.
                            </div>
                        )}
                    </div>
                </div>
            </div>

            <DragGhost dragState={dragState} cellSize={cellSize} />
        </div>
    );
}