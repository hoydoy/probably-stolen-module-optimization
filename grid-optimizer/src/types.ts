export type GridTier = 1 | 2 | 3;
export type ModuleColor = 'White' | 'Red' | 'Yellow' | 'Green' | 'Purple' | 'DarkRed' | 'Grey';
export type ModuleShape =
    | 'Node1x2' | 'L3' | 'L4_Base' | 'T4_Base' | 'Square4_Base'
    | 'L4_High' | 'T4_High' | 'Square4_High' | 'P5' | 'C5' | 'Line4';

export type FilterGroup = 'All' | 'Performance' | 'Quality' | 'Efficiency' | 'Special';
export type ItemEffect = 'None' | 'Premium' | 'Inferior' | 'Overcharged' | 'Degrading' | 'Negative Feedback' | 'Receiver' | 'Side Mount' | 'Top Mount' | 'Learning Algorithm';
export type MachineMode = 'optimize' | 'donate' | 'ignore';
export type FurnaceModules = 'none' | 'junk' | 'blast' | 'both';

export interface InventoryItem {
    id: string;
    shape: ModuleShape;
    color: ModuleColor;
    displayName: string;
    effects: [ItemEffect, ItemEffect];
    effectValues: [number, number];
    isInfinite?: boolean;
    isLocked?: boolean;
    moduleType?: string;
    optimizable?: boolean;
    source?: {
        uuid: number;
        location: string;
        parentId: string | null;
        machineId?: string;
        x: number;
        y: number;
    };
}

export interface ModuleTemplate {
    shape: ModuleShape;
    color: ModuleColor;
    size: number;
    tier: 'Base' | 'High' | 'Special';
    shapeType: string;
    displayName: string;
    group: FilterGroup;
}

export interface Stats {
    Performance: number;
    Quality: number;
    Efficiency: number;
}

export interface TargetStats {
    Performance: number | null;
    Quality: number | null;
    Efficiency: number | null;
}

export type Point = { x: number; y: number };
