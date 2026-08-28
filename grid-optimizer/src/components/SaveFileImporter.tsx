import React, { useRef, useState } from 'react';
import { PRECOMPUTED_OFFSETS, getBaseStats } from '../utils';
import type {InventoryItem, ModuleShape, ItemEffect, ModuleColor, Point, GridTier} from '../types';

interface SaveFileImporterProps {
    onImport: (newItems: InventoryItem[], newMachines: { id: string, boardIds: (string | null)[][], machineType: string, tier: GridTier }[]) => void;
}

export default function SaveFileImporter({ onImport }: SaveFileImporterProps) {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);

    const getShapeFromData = (width: number, data: number[], isHighTier: boolean, blocks: number): ModuleShape | null => {
        if (blocks <= 2) return 'Node1x2';

        const points: Point[] = [];
        for (let i = 0; i < data.length; i++) {
            if (data[i] === 1) points.push({ x: i % width, y: Math.floor(i / width) });
        }

        const minX = Math.min(...points.map(p => p.x));
        const minY = Math.min(...points.map(p => p.y));
        const normalized = points.map(p => ({ x: p.x - minX, y: p.y - minY })).sort((a, b) => a.y === b.y ? a.x - b.x : a.y - b.y);
        const hash = JSON.stringify(normalized);

        for (const [shape, offsetsList] of PRECOMPUTED_OFFSETS.entries()) {
            for (const offsets of offsetsList) {
                const offMinX = Math.min(...offsets.map(p => p.x));
                const offMinY = Math.min(...offsets.map(p => p.y));
                const offNorm = offsets.map(p => ({ x: p.x - offMinX, y: p.y - offMinY })).sort((a, b) => a.y === b.y ? a.x - b.x : a.y - b.y);

                if (JSON.stringify(offNorm) === hash) {
                    if (shape.includes('Base') && isHighTier) continue;
                    if (shape.includes('High') && !isHighTier) continue;
                    return shape;
                }
            }
        }
        return null;
    };

    const getTransformedPoints = (w: number, h: number, data: number[], orientation: number, flipped: boolean) => {
        const pts: Point[] = [];
        for (let i = 0; i < data.length; i++) {
            if (data[i] === 1) {
                let cx = i % w;
                let cy = Math.floor(i / w);

                if (flipped) cx = (w - 1) - cx;

                let cw = w;
                let ch = h;

                for (let r = 0; r < orientation; r++) {
                    const nx = cy;
                    const ny = cw - 1 - cx;
                    cx = nx;
                    cy = ny;
                    const temp = cw; cw = ch; ch = temp;
                }
                pts.push({ x: cx, y: cy });
            }
        }

        if (pts.length === 0) return pts;

        const minX = Math.min(...pts.map(p => p.x));
        const minY = Math.min(...pts.map(p => p.y));

        return pts.map(p => ({ x: p.x - minX, y: p.y - minY }));
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setErrorMsg(null);

        const reader = new FileReader();
        reader.onload = (evt) => {
            try {
                const text = evt.target?.result as string;

                const keyIdx = text.indexOf('"mainInvJSON"');
                if (keyIdx === -1) throw new Error("Could not find mainInvJSON in save file.");

                const colonIdx = text.indexOf(':', keyIdx);
                const quoteStart = text.indexOf('"', colonIdx);

                let quoteEnd = -1;
                for (let i = quoteStart + 1; i < text.length; i++) {
                    if (text[i] === '\\') i++;
                    else if (text[i] === '"') { quoteEnd = i; break; }
                }

                if (quoteEnd === -1) throw new Error("Malformed mainInvJSON string.");

                const invStr = JSON.parse(text.substring(quoteStart, quoteEnd + 1));
                const invData = JSON.parse(invStr);
                const saveItems = invData.saveItems || [];

                const itemMap = new Map();
                saveItems.forEach((item: any) => itemMap.set(item.uuid, item));

                const parentMap = new Map();
                saveItems.forEach((item: any) => {
                    if (item.childItems) {
                        item.childItems.forEach((childId: number) => parentMap.set(childId, item.uuid));
                    }
                });

                const parsedInventory: InventoryItem[] = [];
                const newMachines: { id: string, boardIds: (string | null)[][], machineType: string, tier: GridTier }[] = [];
                const machineContents = new Map<number, { invId: string, modifiedShape: any }[]>();
                const machineDataMap = new Map<number, any>();

                const machineKeywords = ['purifier', 'furnace', 'farm', 'agewell', 'projector', 'desequencer', 'alarm'];

                // parse + import machines
                saveItems.forEach((item: any) => {
                    const nameLower = (item.name || '').toLowerCase();
                    const typesStr = item.itemTypes?.join(' ').toLowerCase() || '';

                    const isMachineType = typesStr.includes("machine")
                    const isActualMachine = machineKeywords.some(kw => nameLower.includes(kw));

                    if (isMachineType && isActualMachine) {
                        machineContents.set(item.uuid, []);
                        machineDataMap.set(item.uuid, item);
                    }
                });

                // parse + import modules
                saveItems.forEach((item: any) => {
                    const name = item.name || '';
                    const nameLower = name.toLowerCase();
                    const _keys = item._keys || [];
                    const typesStr = item.itemTypes?.join(' ').toUpperCase() || '';

                    const allKeysString = (_keys.join(' ') + ' ' + (item._values?.map((v:any) => v.internalValueString || '').join(' ') || '')).toUpperCase();

                    const isModule = (allKeysString.includes("MODULE") ||
                            allKeysString.includes("BONUS_PERCENTAGE_PERFORMANCE_INT") &&
                            typesStr.includes("MODULE")) &&
                        (nameLower.includes('module') || nameLower.includes('node') ||
                            nameLower.includes('core') || nameLower.includes('alarm transmitter module') ||
                            nameLower.includes('(junk processing)') || nameLower.includes('(blast)')) && (!nameLower.includes('ruined') && !nameLower.includes('corrupted'));

                    if (!isModule) return;

                    let color: ModuleColor = 'White';
                    let isHighTier = nameLower.includes('overclock') || nameLower.includes('refinement') || nameLower.includes('eco') || nameLower.includes('uncapped');

                    if (nameLower.includes('performance') || nameLower.includes('overclock')) {
                        color = 'Red';
                    } else if (nameLower.includes('quality') || nameLower.includes('refinement')) {
                        color = 'Yellow';
                    } else if (nameLower.includes('efficiency') || nameLower.includes('eco')) {
                        color = 'Green';
                    } else if (nameLower.includes('neural core')) {
                        color = 'Purple';
                    } else if (nameLower.includes('alarm transmitter')) {
                        color = 'DarkRed';
                    } else if (nameLower.includes('(junk processing)') || nameLower.includes('(blast)')) {
                        color = 'Grey';
                    }

                    const shapeData = item.itemShape?.data;
                    const w = item.itemShape?.['<width>k__BackingField'];

                    if (!shapeData || w === undefined) return;

                    const blocks = shapeData.filter((b: number) => b === 1).length;
                    let shape = getShapeFromData(w, shapeData, isHighTier, blocks);

                    if (!shape) {
                        if (blocks <= 2) shape = 'Node1x2';
                        else if (blocks === 3) shape = 'L3';
                        else if (blocks === 4) shape = isHighTier ? 'L4_High' : 'L4_Base';
                        else shape = 'P5';
                    }

                    const parseEffectStr = (t: string): ItemEffect | null => {
                        if (!t) return null;
                        if (t.includes("PREMIUM")) return "Premium";
                        if (t.includes("INFERIOR")) return "Inferior";
                        if (t.includes("OVERVOLTED")) return "Overcharged";
                        if (t.includes("DEGRADING")) return "Degrading";
                        if (t.includes("NEGATIVE_FEEDBACK")) return "Negative Feedback";
                        if (t.includes("RECEIVER")) return "Receiver";
                        if (t.includes("SIDE_MOUNT")) return "Side Mount";
                        if (t.includes("TOP_MOUNT")) return "Top Mount";
                        if (t.includes("LEARN")) return "Learning Algorithm";
                        return null;
                    };

                    const getTagStrObj = (key: string) => {
                        const idx = _keys.indexOf(key);
                        if (idx !== -1 && item._values && item._values[idx] !== undefined) {
                            return item._values[idx].internalValueString?.toUpperCase();
                        }
                        if (item._values && Array.isArray(item._values)) {
                            const valObj = item._values.find((v: any) => v?.['<identifier>k__BackingField'] === key);
                            if (valObj && valObj.internalValueString) {
                                return valObj.internalValueString.toUpperCase();
                            }
                        }
                        return '';
                    };

                    let eff1: ItemEffect = parseEffectStr(getTagStrObj('MODULE_EFFECT1_TAG')) || 'None';
                    let eff2: ItemEffect = parseEffectStr(getTagStrObj('MODULE_EFFECT2_TAG')) || 'None';

                    if (eff1 === 'None' && eff2 === 'None') {
                        const foundEffects: ItemEffect[] = [];
                        const tags = [
                            ...(_keys || []),
                            ...(item._values?.map((v: any) => v.internalValueString || '') || [])
                        ];
                        tags.forEach((tag: string) => {
                            const parsed = parseEffectStr(tag.toUpperCase());
                            if (parsed && !foundEffects.includes(parsed)) foundEffects.push(parsed);
                        });
                        eff1 = foundEffects.length > 0 ? foundEffects[0] : 'None';
                        eff2 = foundEffects.length > 1 ? foundEffects[1] : 'None';
                    }

                    const getIntValObj = (key: string) => {
                        const idx = _keys.indexOf(key);
                        if (idx !== -1 && item._values && item._values[idx] !== undefined) {
                            return item._values[idx].valueInt;
                        }
                        if (item._values && Array.isArray(item._values)) {
                            const valObj = item._values.find((v: any) => v?.['<identifier>k__BackingField'] === key);
                            if (valObj && valObj.valueInt !== undefined) {
                                return valObj.valueInt;
                            }
                        }
                        return null;
                    };

                    const pVal = getIntValObj("BONUS_PERCENTAGE_PERFORMANCE_INT");
                    const qVal = getIntValObj("BONUS_PERCENTAGE_QUALITY_INT");
                    const eVal = getIntValObj("BONUS_PERCENTAGE_EFFICIENCY_INT");

                    let primaryStat: number | null = null;
                    if (color === 'Red' || color === 'Purple') primaryStat = pVal;
                    if (color === 'Yellow') primaryStat = qVal;
                    if (color === 'Green') primaryStat = eVal;

                    const actualMaxVal = primaryStat !== null ? Math.abs(primaryStat) : null;

                    const base = getBaseStats({ shape, color, displayName: name });
                    const maxPositiveBase = Math.max(
                        base.Performance > 0 ? base.Performance : 0,
                        base.Quality > 0 ? base.Quality : 0,
                        base.Efficiency > 0 ? base.Efficiency : 0
                    );

                    const defaultDoubleBase = Math.floor(maxPositiveBase * 2);
                    const customVal = actualMaxVal !== null ? actualMaxVal : 0;

                    const eff1Val = (eff1 === 'Learning Algorithm' || eff1 === 'Degrading') ? customVal : defaultDoubleBase;
                    const eff2Val = (eff2 === 'Learning Algorithm' || eff2 === 'Degrading') ? customVal : defaultDoubleBase;

                    const invId = `${shape}_${color}_${Math.random().toString(36).substring(2, 8)}`;

                    parsedInventory.push({
                        id: invId,
                        shape: shape as any,
                        color: color as any,
                        displayName: name,
                        effects: [eff1, eff2],
                        effectValues: [eff1Val, eff2Val],
                        isInfinite: false,
                        isLocked: false
                    });

                    const parentId = parentMap.get(item.uuid);
                    if (parentId !== undefined && machineContents.has(parentId)) {
                        machineContents.get(parentId)!.push({
                            invId,
                            modifiedShape: item.itemModifiedShape
                        });
                    }
                });

                machineContents.forEach((contents, machineId) => {
                    const boardIds = Array.from({ length: 5 }, () => Array.from({ length: 7 }, () => null as string | null));
                    let dropdownName = "Select Machine...";
                    let machineTier: GridTier = 1;

                    const parentItem = machineDataMap.get(machineId);

                    if (parentItem) {
                        const pName = (parentItem.name || '').toLowerCase();
                        const pKeys = parentItem._keys || [];
                        const pValues = parentItem._values || [];

                        let stageVal: number | null = null;

                        const upgradeIdx = pKeys.indexOf('MODULE_UPGRADE_STAGE_INT');
                        if (upgradeIdx !== -1 && pValues[upgradeIdx] !== undefined) {
                            stageVal = pValues[upgradeIdx].valueInt;
                        }
                        else if (Array.isArray(pValues)) {
                            const valObj = pValues.find((v: any) => v?.['<identifier>k__BackingField'] === 'MODULE_UPGRADE_STAGE_INT');
                            if (valObj && valObj.valueInt !== undefined) {
                                stageVal = valObj.valueInt;
                            }
                        }

                        if (stageVal !== null && stageVal >= 0 && stageVal <= 2) {
                            machineTier = (stageVal + 1) as GridTier;
                        }

                        if (pName.includes("purifier")) dropdownName = "Water Purifier";
                        else if (pName.includes("furnace")) dropdownName = "Furnace";
                        else if (pName.includes("farm")) dropdownName = "Moisture Farm";
                        else if (pName.includes("agewell")) dropdownName = "AgeWell";
                        else if (pName.includes("projector")) dropdownName = "Mirage Projector";
                        else if (pName.includes("desequencer")) dropdownName = "Cryptographic Desequencer";
                        else if (pName.includes("alarm") || pName.includes("machine")) dropdownName = "Alarm System";
                    }

                    contents.forEach(({ invId, modifiedShape }) => {
                        const w = modifiedShape['<width>k__BackingField'];
                        const h = modifiedShape['<height>k__BackingField'];
                        const minX = modifiedShape['<minX>k__BackingField'];
                        const minY = modifiedShape['<minY>k__BackingField'];
                        const orientation = modifiedShape['<orientation>k__BackingField'] || 0;
                        const flipped = modifiedShape['<flipped>k__BackingField'] || false;
                        const data = modifiedShape.data;

                        const pts = getTransformedPoints(w, h, data, orientation, flipped);

                        for (const p of pts) {
                            const finalX = minX + p.x;
                            const finalY = minY + p.y;

                            if (finalY >= 0 && finalY < 5 && finalX >= 0 && finalX < 7) {
                                boardIds[finalY][finalX] = invId;
                            }
                        }
                    });

                    newMachines.push({
                        id: `m_${Math.random().toString(36).substring(2, 8)}`,
                        boardIds,
                        machineType: dropdownName,
                        tier: machineTier
                    });
                });

                onImport(parsedInventory, newMachines);
            } catch (err) {
                console.error("Failed to parse save:", err);
                setErrorMsg("Failed to parse save file. Please ensure it is a valid .es3 save string.");
            }

            if (fileInputRef.current) fileInputRef.current.value = '';
        };
        reader.readAsText(file);
    };

    return (
        <div style={{ display: 'inline-block', position: 'relative' }}>
            <input
                type="file"
                accept=".es3"
                ref={fileInputRef}
                onChange={handleFileChange}
                style={{ display: 'none' }}
                id="save-upload"
            />
            <label
                htmlFor="save-upload"
                style={{
                    padding: '10px 24px',
                    backgroundColor: '#333333',
                    color: '#eee',
                    border: '1px solid #555555',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontSize: '0.95em',
                    display: 'inline-block'
                }}
            >
                Import Save (.es3)
            </label>
            {errorMsg && (
                <div style={{ position: 'absolute', top: '100%', marginTop: '5px', left: 0, color: '#ff4d4d', fontSize: '0.8em', whiteSpace: 'nowrap' }}>
                    {errorMsg}
                </div>
            )}
        </div>
    );
}