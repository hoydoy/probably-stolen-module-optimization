import type { GridTier, InventoryItem, ItemEffect, ModuleColor, ModuleShape } from './types';
import { emptyBoard } from './optimizerCore.ts';
import type { Board } from './optimizerCore.ts';
import { PRECOMPUTED_OFFSETS } from './utils.ts';

type RawAttribute = { valueInt?: number; internalValueString?: string };
type RawShape = {
    data?: number[];
    '<width>k__BackingField'?: number;
    '<flipped>k__BackingField'?: boolean;
    '<orientation>k__BackingField'?: number;
    '<minX>k__BackingField'?: number;
    '<minY>k__BackingField'?: number;
};
type Raw = {
    uuid: number;
    name: string;
    identifier: string;
    childItems?: number[];
    childItemInventoryNode?: number[];
    itemShape?: RawShape;
    itemModifiedShape?: RawShape;
    _keys?: string[];
    _values?: RawAttribute[];
};
type RawRoot = { playerStore?: { value?: { mainInvJSON?: string; backInvJSON?: string } } };

export interface ImportedMachine {
    id: string;
    name: string;
    location: string;
    tier: GridTier;
    moduleType?: string;
    board: Board;
}

export interface ImportedSave {
    modules: InventoryItem[];
    machines: ImportedMachine[];
    inventoryGrid: ImportedInventoryGrid;
}

export interface ImportedGridItem {
    id: string;
    parentId: string | null;
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
    container: boolean;
    identifier: string;
    machine: boolean;
    tier?: GridTier;
    inventoryNode?: number;
    moduleId?: string;
    cells: { x: number; y: number }[];
    inventoryWidth?: number;
    inventoryHeight?: number;
}

export interface ImportedInventoryGrid {
    rootId: string;
    counterRootId?: string;
    items: ImportedGridItem[];
}

export interface ImportedInventoryPane {
    node: number;
    label: string;
    width: number;
    height: number;
}

export function inferMachinePanes(children: ImportedGridItem[]): ImportedInventoryPane[] {
    const nodes = [...new Set([2, 3, ...children.map(item => item.inventoryNode).filter((node): node is number => typeof node === 'number')])].sort((a, b) => a - b);
    let genericIndex = 0;
    return nodes.flatMap(node => {
        const items = children.filter(item => item.inventoryNode === node);
        if (items.length && items.every(item => item.identifier === 'postit')) return [];
        if (node === 2) return [{ node, label: 'Power Source', width: Math.max(1, ...items.map(item => item.x + item.width)), height: Math.max(2, ...items.map(item => item.y + item.height)) }];
        if (node === 3) return [{ node, label: 'Modules', width: Math.max(7, ...items.map(item => item.x + item.width)), height: Math.max(5, ...items.map(item => item.y + item.height)) }];
        genericIndex++;
        return [{ node, label: `Inventory ${genericIndex}`, width: Math.max(1, ...items.map(item => item.x + item.width)), height: Math.max(1, ...items.map(item => item.y + item.height)) }];
    });
}

const EFFECTS: Record<string, ItemEffect> = {
    MODULE_EFFECT_PREMIUM: 'Premium',
    MODULE_EFFECT_INFERIOR: 'Inferior',
    MODULE_EFFECT_OVERVOLTED: 'Overcharged',
    MODULE_EFFECT_OVERCHARGED: 'Overcharged',
    MODULE_EFFECT_DEGRADING: 'Degrading',
    MODULE_EFFECT_NEGATIVE_FEEDBACK: 'Negative Feedback',
    MODULE_EFFECT_RECEIVER: 'Receiver',
    MODULE_EFFECT_SIDE_MOUNT: 'Side Mount',
    MODULE_EFFECT_TOP_MOUNT: 'Top Mount',
    MODULE_EFFECT_LEARNING_ALGORITHM: 'Learning Algorithm'
};

const INVENTORY_SIZES: Record<string, [number, number]> = {
    save_bag: [24, 10],
    back_inv_save_bag: [17, 10],
    storage_bay: [10, 10],
    storage_bay_large: [17, 10]
};

const attrs = (item: Raw): Record<string, RawAttribute | undefined> => Object.fromEntries((item._keys || []).map((key, index) => [key, item._values?.[index]]));
const intAttr = (item: Raw, key: string) => attrs(item)[key]?.valueInt as number | undefined;
const stringAttr = (item: Raw, key: string) => attrs(item)[key]?.internalValueString as string | undefined;

function pointsFromShape(shape: RawShape) {
    const width = shape['<width>k__BackingField'] || 1;
    return (shape.data || []).flatMap((cell, index) => cell ? [{ x: index % width, y: Math.floor(index / width) }] : []);
}

function placedPoints(shape: RawShape) {
    let points = pointsFromShape(shape);
    if (shape['<flipped>k__BackingField']) points = points.map(point => ({ x: -point.x, y: point.y }));
    for (let turn = 0; turn < (shape['<orientation>k__BackingField'] || 0); turn++) {
        points = points.map(point => ({ x: point.y, y: -point.x }));
    }
    const minX = Math.min(...points.map(point => point.x));
    const minY = Math.min(...points.map(point => point.y));
    return points.map(point => ({ x: point.x - minX, y: point.y - minY }));
}

function shapeKey(points: { x: number, y: number }[]) {
    const minX = Math.min(...points.map(point => point.x));
    const minY = Math.min(...points.map(point => point.y));
    return points.map(point => `${point.x - minX},${point.y - minY}`).sort().join(';');
}

const GEOMETRY_KEYS = [...PRECOMPUTED_OFFSETS].map(([shape, variants]) => [shape, new Set(variants.map(shapeKey))] as const);

function moduleShape(item: Raw): ModuleShape {
    const name = item.name as string;
    if (name.includes('Neural Core')) return name.includes('Uncapped') ? 'Square4_High' : 'Square4_Base';
    if (name.includes('Alarm') || name.includes('Junk Processing') || name.includes('Blast')) return 'Line4';

    const key = shapeKey(pointsFromShape(item.itemShape || {}));
    const base = GEOMETRY_KEYS.find(([, keys]) => keys.has(key))?.[0];
    if (!base) throw new Error(`Unsupported module shape: ${name}`);
    if (['Overclock Module', 'Refinement Module', 'Eco Module'].includes(name)) {
        if (base === 'L4_Base') return 'L4_High';
        if (base === 'T4_Base') return 'T4_High';
        if (base === 'Square4_Base') return 'Square4_High';
    }
    return base;
}

function moduleColor(name: string): ModuleColor {
    if (name.includes('Node')) return 'White';
    if (name.includes('Performance') || name.includes('Overclock')) return 'Red';
    if (name.includes('Quality') || name.includes('Refinement')) return 'Yellow';
    if (name.includes('Efficiency') || name.includes('Eco')) return 'Green';
    if (name.includes('Neural Core')) return 'Purple';
    if (name.includes('Alarm')) return 'DarkRed';
    return 'Grey';
}

function displayName(name: string) {
    if (name.includes('Neural Core')) return name.includes('Uncapped') ? 'Neural Core (Uncapped)' : 'Neural Core (Capped)';
    if (name.includes('Alarm')) return 'Alarm Module';
    if (name.includes('Junk Processing')) return 'Junk Processing';
    if (name.includes('Blast')) return 'Blast Module';
    if (name.includes('Node')) return 'Node';
    return name.replace(' Module', '');
}

function machineType(identifier: string) {
    if (identifier === 'furnace') return 'MODULE_TYPE_FURNACE';
    if (identifier === 'security_alarm') return 'MODULE_TYPE_ALARM';
    return undefined;
}

function repairEs3Json(text: string) {
    return text.replace(/([,{]\s*)(-?\d+)(\s*:)/g, '$1"$2"$3');
}

export function importEs3Save(text: string): ImportedSave {
    let root: RawRoot;
    try {
        root = JSON.parse(repairEs3Json(text));
    } catch {
        throw new Error('This is not a readable Probably Stolen .es3 save.');
    }

    const inventoryJson = root.playerStore?.value?.mainInvJSON;
    if (typeof inventoryJson !== 'string') throw new Error('The save does not contain a player inventory.');

    const mainItems = (JSON.parse(inventoryJson).saveItems || []) as Raw[];
    const counterOffset = Math.max(0, ...mainItems.map(item => item.uuid)) + 1;
    const counterItems = typeof root.playerStore?.value?.backInvJSON === 'string'
        ? ((JSON.parse(root.playerStore.value.backInvJSON).saveItems || []) as Raw[]).map(item => ({
            ...item,
            uuid: counterOffset + item.uuid,
            childItems: item.childItems?.map(uuid => counterOffset + uuid)
        }))
        : [];
    const items = [...mainItems, ...counterItems];
    const counterUuids = new Set(counterItems.map(item => item.uuid));
    const externalId = (uuid: number) => counterUuids.has(uuid) ? `counter_${uuid - counterOffset}` : String(uuid);
    const byId = new Map<number, Raw>(items.map(item => [item.uuid, item]));
    const parentByChild = new Map<number, Raw>();
    items.forEach(parent => (parent.childItems || []).forEach((child: number) => parentByChild.set(child, parent)));

    const pathTo = (uuid: number) => {
        const names: string[] = [];
        let current = byId.get(uuid);
        const seen = new Set<number>();
        while (current && !seen.has(current.uuid)) {
            seen.add(current.uuid);
            names.unshift(current.identifier === 'save_bag' ? 'Shop Inventory' : current.identifier === 'back_inv_save_bag' ? 'Counter' : current.name || current.identifier || `Item ${current.uuid}`);
            current = parentByChild.get(current.uuid);
        }
        return names.join(' → ');
    };

    const rawModules = items.filter(item => Object.hasOwn(attrs(item), 'MODULE_TAG'));
    const rawMachines = items.filter(item => {
        const tags = attrs(item);
        return Object.hasOwn(tags, 'MODULE_UPGRADE_STAGE_INT') || Object.hasOwn(tags, 'IS_RECEIVING_BONUS_FROM_MODULE_BOOL');
    });
    const machineIds = new Set(rawMachines.map(machine => machine.uuid));

    const modules = rawModules.map(raw => {
        const parent = parentByChild.get(raw.uuid);
        const effects = ['MODULE_EFFECT1_TAG', 'MODULE_EFFECT2_TAG']
            .map(key => EFFECTS[stringAttr(raw, key) || ''])
            .filter((effect): effect is ItemEffect => Boolean(effect));
        const currentPositiveStat = Math.max(
            intAttr(raw, 'BONUS_PERCENTAGE_PERFORMANCE_INT') || 0,
            intAttr(raw, 'BONUS_PERCENTAGE_QUALITY_INT') || 0,
            intAttr(raw, 'BONUS_PERCENTAGE_EFFICIENCY_INT') || 0,
            0
        );
        const shape = raw.itemModifiedShape || {};
        return {
            id: `save_module_${externalId(raw.uuid)}`,
            shape: moduleShape(raw),
            color: moduleColor(raw.name),
            displayName: displayName(raw.name),
            effects: [effects[0] || 'None', effects[1] || 'None'],
            effectValues: [currentPositiveStat, currentPositiveStat],
            moduleType: stringAttr(raw, 'MODULE_TYPE') || 'MODULE_TYPE_UNIVERSAL',
            optimizable: raw.name !== 'Ruined Module',
            source: {
                uuid: raw.uuid,
                location: parent ? pathTo(parent.uuid) : 'Unparented',
                parentId: parent ? externalId(parent.uuid) : null,
                machineId: parent && machineIds.has(parent.uuid) ? `save_machine_${externalId(parent.uuid)}` : undefined,
                x: shape['<minX>k__BackingField'] || 0,
                y: shape['<minY>k__BackingField'] || 0
            }
        } satisfies InventoryItem;
    });
    const moduleByUuid = new Map(modules.map(module => [module.source!.uuid, module]));

    const machines = rawMachines.map(raw => {
        const stage = intAttr(raw, 'MODULE_UPGRADE_STAGE_INT');
        const tier = Math.max(1, Math.min(3, stage === undefined ? 1 : stage + 1)) as GridTier;
        const board = emptyBoard(tier);
        (raw.childItems || []).forEach((uuid: number, index: number) => {
            if (raw.childItemInventoryNode && raw.childItemInventoryNode[index] !== 3) return;
            const module = moduleByUuid.get(uuid);
            const source = byId.get(uuid);
            if (!module || !source) return;
            const shape = source.itemModifiedShape || {};
            const rootX = shape['<minX>k__BackingField'] || 0;
            const rootY = shape['<minY>k__BackingField'] || 0;
            placedPoints(shape).forEach(point => {
                const x = rootX + point.x;
                const y = rootY + point.y;
                if (x >= 0 && x < 7 && y >= 0 && y < 5) board[y][x] = module;
            });
        });
        const parent = parentByChild.get(raw.uuid);
        const shape = raw.itemModifiedShape || {};
        return {
            id: `save_machine_${externalId(raw.uuid)}`,
            name: raw.name || raw.identifier,
            location: `${parent ? pathTo(parent.uuid) : 'Unparented'} @ (${shape['<minX>k__BackingField']}, ${shape['<minY>k__BackingField']})`,
            tier,
            moduleType: machineType(raw.identifier),
            board
        };
    });

    const totals = new Map<string, number>();
    machines.forEach(machine => totals.set(machine.name, (totals.get(machine.name) || 0) + 1));
    const seen = new Map<string, number>();
    machines.forEach(machine => {
        const index = (seen.get(machine.name) || 0) + 1;
        seen.set(machine.name, index);
        if ((totals.get(machine.name) || 0) > 1) machine.name += ` #${index}`;
    });
    const machineNameByUuid = new Map(rawMachines.map((raw, index) => [raw.uuid, machines[index].name]));

    const rootItem = items.find(item => item.identifier === 'save_bag') || items.find(item => !parentByChild.has(item.uuid));
    if (!rootItem) throw new Error('The save does not contain a Save Bag.');
    const counterRoot = counterItems.find(item => item.identifier === 'back_inv_save_bag' && item.childItems?.length);
    const inventoryNodeByChild = new Map<number, number>();
    items.forEach(parent => (parent.childItems || []).forEach((child: number, index: number) => {
        const node = parent.childItemInventoryNode?.[index];
        if (typeof node === 'number') inventoryNodeByChild.set(child, node);
    }));
    const inventoryGrid = {
        rootId: externalId(rootItem.uuid),
        counterRootId: counterRoot ? externalId(counterRoot.uuid) : undefined,
        items: items.map(item => {
            const shape = item.itemModifiedShape || item.itemShape || {};
            const cells = Array.isArray(shape.data) && shape.data.some(Boolean) ? placedPoints(shape) : [{ x: 0, y: 0 }];
            const width = Math.max(...cells.map(cell => cell.x)) + 1;
            const height = Math.max(...cells.map(cell => cell.y)) + 1;
            const stage = intAttr(item, 'MODULE_UPGRADE_STAGE_INT');
            const tier = machineIds.has(item.uuid) ? Math.max(1, Math.min(3, stage === undefined ? 1 : stage + 1)) as GridTier : undefined;
            const inventorySize = INVENTORY_SIZES[item.identifier];
            return {
                id: externalId(item.uuid),
                parentId: parentByChild.has(item.uuid) ? externalId(parentByChild.get(item.uuid)!.uuid) : null,
                name: item.identifier === 'save_bag' ? 'Shop Inventory' : item.identifier === 'back_inv_save_bag' ? 'Counter' : machineNameByUuid.get(item.uuid) || item.name || item.identifier || `Item ${item.uuid}`,
                x: shape['<minX>k__BackingField'] || 0,
                y: shape['<minY>k__BackingField'] || 0,
                width,
                height,
                container: machineIds.has(item.uuid) || Boolean(item.childItems?.length),
                identifier: item.identifier || '',
                machine: machineIds.has(item.uuid),
                tier,
                inventoryNode: inventoryNodeByChild.get(item.uuid),
                moduleId: moduleByUuid.has(item.uuid) ? `save_module_${externalId(item.uuid)}` : undefined,
                cells,
                inventoryWidth: inventorySize?.[0],
                inventoryHeight: inventorySize?.[1]
            };
        })
    };

    return { modules, machines, inventoryGrid };
}
