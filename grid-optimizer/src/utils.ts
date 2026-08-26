import type {ModuleShape, ModuleColor, Stats, Point, InventoryItem} from './types';
import { SHAPE_DEFINITIONS } from './constants.ts';

export const getBaseStats = (template: { shape: ModuleShape, color: ModuleColor, displayName: string }): Stats => {
    const stats = { Performance: 0, Quality: 0, Efficiency: 0 };
    if (template.shape === 'Node1x2') return stats;

    const { shape, color, displayName } = template;

    if (displayName.includes('Ruined')) return stats;
    if (displayName.includes('Neural Core (Uncapped)')) return { Performance: 200, Quality: 100, Efficiency: -200 };
    if (displayName.includes('Neural Core (Capped)')) return { Performance: 100, Quality: 50, Efficiency: -100 };
    if (displayName.includes('Alarm Module')) return { Performance: 0, Quality: 0, Efficiency: -50 };
    if (displayName.includes('Junk Processing')) return { Performance: 0, Quality: 0, Efficiency: 0 };
    if (displayName.includes('Blast Module')) return { Performance: 0, Quality: 0, Efficiency: -100 };

    const isL3 = shape === 'L3';
    const isBase4 = shape.includes('_Base');
    const isHigh4 = shape.includes('_High');
    const isSize5 = shape === 'P5' || shape === 'C5';

    if (color === 'Red') {
        if (isL3) stats.Performance = 12;
        if (isBase4) stats.Performance = 16;
        if (isHigh4) { stats.Performance = 36; stats.Efficiency = -44; }
        if (isSize5) { stats.Performance = 45; stats.Efficiency = -55; }
    } else if (color === 'Yellow') {
        if (isL3) stats.Quality = 6;
        if (isBase4) stats.Quality = 8;
        if (isHigh4) { stats.Performance = -8; stats.Quality = 25; stats.Efficiency = -15; }
        if (isSize5) { stats.Performance = -10; stats.Quality = 31; stats.Efficiency = -18; }
    } else if (color === 'Green') {
        if (isL3) stats.Efficiency = 12;
        if (isBase4) stats.Efficiency = 16;
        if (isHigh4) { stats.Performance = -16; stats.Efficiency = 32; }
        if (isSize5) { stats.Performance = -20; stats.Efficiency = 40; }
    }
    return stats;
};

const computeItemStats = (item: InventoryItem): { effectiveBase: Stats, internal: Stats } => {
    let { Performance: p, Quality: q, Efficiency: e } = getBaseStats(item);
    let effectiveBase: Stats = { Performance: p, Quality: q, Efficiency: e };
    const claimed = { Performance: false, Quality: false, Efficiency: false };
    const multiply = (factor: number) => {
        if (!claimed.Performance) p = Math.trunc(p * factor);
        if (!claimed.Quality) q = Math.trunc(q * factor);
        if (!claimed.Efficiency) e = Math.trunc(e * factor);
    };

    item.effects.forEach((effect, idx) => {
        const customVal = item.effectValues[idx];

        if (effect === 'Degrading') {
            if (customVal !== undefined && !isNaN(customVal)) {
                const truncVal = Math.trunc(customVal);
                if (p > 0) { p = truncVal; claimed.Performance = true; }
                else p *= 2;
                if (q > 0) { q = truncVal; claimed.Quality = true; }
                else q *= 2;
                if (e > 0) { e = truncVal; claimed.Efficiency = true; }
                else e *= 2;
            }
            effectiveBase = { Performance: p, Quality: q, Efficiency: e };
        }
        else if (effect === 'Learning Algorithm') {
            if (customVal !== undefined && !isNaN(customVal)) {
                const truncVal = Math.trunc(customVal);
                if (p > 0) { p = truncVal; claimed.Performance = true; }
                else if (p < 0) { p = Math.min(0, p + truncVal); claimed.Performance = true; }

                if (q > 0) { q = truncVal; claimed.Quality = true; }
                else if (q < 0) { q = Math.min(0, q + truncVal); claimed.Quality = true; }

                if (e > 0) { e = truncVal; claimed.Efficiency = true; }
                else if (e < 0) { e = Math.min(0, e + truncVal); claimed.Efficiency = true; }
            }
            effectiveBase = { Performance: p, Quality: q, Efficiency: e };
        }
        else if (effect === 'Premium') {
            multiply(1.2);
        }
        else if (effect === 'Inferior') {
            multiply(0.8);
        }
        else if (effect === 'Overcharged') {
            multiply(2);
        }
        else if (effect === 'Negative Feedback') {
            multiply(1.25);
        }
    });

    return { effectiveBase, internal: { Performance: p, Quality: q, Efficiency: e } };
};

export const getEffectiveBaseStats = (item: InventoryItem): Stats => computeItemStats(item).effectiveBase;
export const applyInternalEffects = (item: InventoryItem): Stats => computeItemStats(item).internal;

// Shared by the upstream stat engine; epsilon avoids floating-point values
// such as 31.999999999 being truncated to the wrong integer.
export const roundStat = (value: number) => value < 0
    ? Math.ceil(value - 1e-9)
    : Math.floor(value + 1e-9);

export const formatStatValue = (val: number) => {
    const rounded = Math.trunc(val);
    return rounded > 0 ? `+${rounded}%` : `${rounded}%`;
};

export const getStatColor = (val: number) => {
    return val > 0 ? '#4caf50' : (val < 0 ? '#ff4d4d' : '#888');
};

// Geometry Pre-Processor
const rotateMatrix = (m: number[][]) => m[0].map((_, idx) => m.map(row => row[idx]).reverse());
const flipMatrix = (m: number[][]) => m.map(row => [...row].reverse());

const matrixToOffsets = (matrix: number[][]): Point[] => {
    const points: Point[] = [];
    for (let y = 0; y < matrix.length; y++) {
        for (let x = 0; x < matrix[y].length; x++) {
            if (matrix[y][x]) points.push({ x, y });
        }
    }
    const minY = Math.min(...points.map(p => p.y));
    const topRow = points.filter(p => p.y === minY);
    const minX = Math.min(...topRow.map(p => p.x));
    return points.map(p => ({ x: p.x - minX, y: p.y - minY })).sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));
};

const generateAllOffsets = (baseMatrix: number[][]): Point[][] => {
    const offsetsMap = new Set<string>();
    const result: Point[][] = [];
    let current = baseMatrix;

    for (let i = 0; i < 4; i++) {
        const normalPts = matrixToOffsets(current);
        const normalHash = JSON.stringify(normalPts);
        if (!offsetsMap.has(normalHash)) { offsetsMap.add(normalHash); result.push(normalPts); }

        const flippedPts = matrixToOffsets(flipMatrix(current));
        const flippedHash = JSON.stringify(flippedPts);
        if (!offsetsMap.has(flippedHash)) { offsetsMap.add(flippedHash); result.push(flippedPts); }

        current = rotateMatrix(current);
    }
    return result;
};

export const PRECOMPUTED_OFFSETS = new Map<ModuleShape, Point[][]>();
(Object.keys(SHAPE_DEFINITIONS) as ModuleShape[]).forEach(shape => {
    PRECOMPUTED_OFFSETS.set(shape, generateAllOffsets(SHAPE_DEFINITIONS[shape]));
});
