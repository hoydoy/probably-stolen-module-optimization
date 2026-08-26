import type { FurnaceModules, InventoryItem } from './types';
import { applyInternalEffects } from './utils.ts';

export const isJunk = (item: InventoryItem) => item.displayName.includes('Junk Processing');
export const isBlast = (item: InventoryItem) => item.displayName.includes('Blast Module');
export const isAlarm = (item: InventoryItem) => item.displayName.includes('Alarm Module');

export const getModuleLabel = (name: string) => {
    const labels: [string, string][] = [
        ['Performance', 'Perf'], ['Overclock', 'Over'], ['Quality', 'Qual'], ['Refinement', 'Ref'],
        ['Efficiency', 'Eff'], ['Eco', 'Eco'], ['Neural Core', 'Core'], ['Node', 'Node'],
        ['Junk Processing', 'Junk'], ['Blast', 'Blast'], ['Alarm', 'Alarm'], ['Ruined', 'Ruin']
    ];
    return labels.find(([prefix]) => name.startsWith(prefix))?.[1] || name.replace(/ Module/g, '').slice(0, 5);
};

export const getMachineAbbreviation = (name: string) => name.split(/\s+/)
    .map(word => word.startsWith('#') ? word : word[0]?.toUpperCase() || '')
    .join('');

export const getModuleLabelArea = (cells: { x: number; y: number }[]) => {
    const occupied = new Set(cells.map(cell => `${cell.x},${cell.y}`));
    const minX = Math.min(...cells.map(cell => cell.x));
    const minY = Math.min(...cells.map(cell => cell.y));
    const width = Math.max(...cells.map(cell => cell.x)) - minX + 1;
    const height = Math.max(...cells.map(cell => cell.y)) - minY + 1;
    if (cells.length === width * height) return { x: minX, y: minY, width, height };
    const centerX = cells.reduce((sum, cell) => sum + cell.x, 0) / cells.length;
    const centerY = cells.reduce((sum, cell) => sum + cell.y, 0) / cells.length;
    let horizontal = { x: cells[0].x, y: cells[0].y, width: 1, height: 1 };
    let vertical = horizontal;
    cells.forEach(cell => {
        if (!occupied.has(`${cell.x - 1},${cell.y}`)) {
            let width = 1;
            while (occupied.has(`${cell.x + width},${cell.y}`)) width++;
            if (width > horizontal.width || (width === horizontal.width && Math.abs(cell.y - centerY) < Math.abs(horizontal.y - centerY))) horizontal = { x: cell.x, y: cell.y, width, height: 1 };
        }
        if (!occupied.has(`${cell.x},${cell.y - 1}`)) {
            let height = 1;
            while (occupied.has(`${cell.x},${cell.y + height}`)) height++;
            if (height > vertical.height || (height === vertical.height && Math.abs(cell.x - centerX) < Math.abs(vertical.x - centerX))) vertical = { x: cell.x, y: cell.y, width: 1, height };
        }
    });
    return horizontal.width >= 2 || horizontal.width >= vertical.height ? horizontal : vertical;
};

export const wantsFurnaceModule = (choice: FurnaceModules | undefined, item: InventoryItem) =>
    (isJunk(item) && (choice === 'junk' || choice === 'both')) ||
    (isBlast(item) && (choice === 'blast' || choice === 'both'));

const placementEffects = (item: InventoryItem) => item.effects
    .filter(effect => ['Side Mount', 'Top Mount', 'Receiver', 'Negative Feedback'].includes(effect))
    .sort().join('|');

export const hasStrongerSameShape = (item: InventoryItem, inventory: InventoryItem[], availableIds?: Set<string>) => {
    const stats = applyInternalEffects(item);
    return inventory.some(other => {
        if (other.id === item.id || (availableIds && !availableIds.has(other.id)) || other.optimizable === false
            || other.shape !== item.shape || other.moduleType !== item.moduleType
            || other.effects.includes('Degrading') || placementEffects(other) !== placementEffects(item)) return false;
        const better = applyInternalEffects(other);
        return better.Performance >= stats.Performance
            && better.Quality >= stats.Quality
            && better.Efficiency >= stats.Efficiency
            && (better.Performance > stats.Performance || better.Quality > stats.Quality || better.Efficiency > stats.Efficiency);
    });
};

export const isModuleAllowedForMachine = (
    item: InventoryItem,
    machine: { moduleType?: string; furnaceModules?: FurnaceModules; alarmModule?: boolean }
) => {
    if (machine.moduleType && item.moduleType !== 'MODULE_TYPE_UNIVERSAL' && item.moduleType !== machine.moduleType) return false;
    if (isJunk(item) || isBlast(item)) return machine.moduleType === 'MODULE_TYPE_FURNACE' && wantsFurnaceModule(machine.furnaceModules, item);
    if (isAlarm(item)) return machine.moduleType === 'MODULE_TYPE_ALARM' && machine.alarmModule === true;
    return true;
};
