import type {ModuleShape, ModuleColor, ItemEffect, ModuleTemplate} from './types';

export const SHAPE_DEFINITIONS: { [key in ModuleShape]: number[][] } = {
    Node1x2: [[1], [1]],
    L3: [[1, 0], [1, 1]],
    L4_Base: [[1, 0], [1, 0], [1, 1]],
    T4_Base: [[1, 1, 1], [0, 1, 0]],
    Square4_Base: [[1, 1], [1, 1]],
    L4_High: [[1, 0], [1, 0], [1, 1]],
    T4_High: [[1, 1, 1], [0, 1, 0]],
    Square4_High: [[1, 1], [1, 1]],
    P5: [[1, 1], [1, 1], [1, 0]],
    C5: [[1, 1], [1, 0], [1, 1]],
    Line4: [[1, 1, 1, 1]],
};

export const COLOR_MAP: { [key in ModuleColor]: string } = {
    White: '#e0e0e0',
    Red: '#ff4d4d',
    Yellow: '#ffd700',
    Green: '#4caf50',
    Purple: '#9c27b0',
    DarkRed: '#8b0000',
    Grey: '#808080'
};

export const EFFECTS_LIST: ItemEffect[] = [
    'None', 'Premium', 'Inferior', 'Overcharged', 'Degrading',
    'Negative Feedback', 'Receiver', 'Side Mount', 'Top Mount', 'Learning Algorithm'
];

export const MODULE_TEMPLATES: ModuleTemplate[] = [];

// Base & High Tier
(['Red', 'Yellow', 'Green'] as ModuleColor[]).forEach((color) => {
    const group = color === 'Red' ? 'Performance' : color === 'Yellow' ? 'Quality' : 'Efficiency';
    MODULE_TEMPLATES.push({ shape: 'L3', color, size: 3, tier: 'Base', shapeType: 'L', displayName: group, group });
    MODULE_TEMPLATES.push({ shape: 'L4_Base', color, size: 4, tier: 'Base', shapeType: 'L', displayName: group, group });
    MODULE_TEMPLATES.push({ shape: 'T4_Base', color, size: 4, tier: 'Base', shapeType: 'T', displayName: group, group });
    MODULE_TEMPLATES.push({ shape: 'Square4_Base', color, size: 4, tier: 'Base', shapeType: 'Square', displayName: group, group });

    const highName = color === 'Red' ? 'Overclock' : color === 'Yellow' ? 'Refinement' : 'Eco';
    MODULE_TEMPLATES.push({ shape: 'L4_High', color, size: 4, tier: 'High', shapeType: 'L', displayName: highName, group });
    MODULE_TEMPLATES.push({ shape: 'T4_High', color, size: 4, tier: 'High', shapeType: 'T', displayName: highName, group });
    MODULE_TEMPLATES.push({ shape: 'Square4_High', color, size: 4, tier: 'High', shapeType: 'Square', displayName: highName, group });
    MODULE_TEMPLATES.push({ shape: 'P5', color, size: 5, tier: 'High', shapeType: 'P', displayName: highName, group });
    MODULE_TEMPLATES.push({ shape: 'C5', color, size: 5, tier: 'High', shapeType: 'C', displayName: highName, group });
});

// Specials
MODULE_TEMPLATES.push({ shape: 'Square4_High', color: 'Purple', size: 4, tier: 'Special', shapeType: 'Square', displayName: 'Neural Core Module (Uncapped)', group: 'Special' });
MODULE_TEMPLATES.push({ shape: 'Square4_Base', color: 'Purple', size: 4, tier: 'Special', shapeType: 'Square', displayName: 'Neural Core Module (Capped)', group: 'Special' });
MODULE_TEMPLATES.push({ shape: 'Line4', color: 'DarkRed', size: 4, tier: 'Special', shapeType: 'Line', displayName: 'Alarm Transmitter Module', group: 'Special' });
MODULE_TEMPLATES.push({ shape: 'Line4', color: 'Grey', size: 4, tier: 'Special', shapeType: 'Line', displayName: 'Furnace Module (Junk Processing)', group: 'Special' });
MODULE_TEMPLATES.push({ shape: 'Line4', color: 'Grey', size: 4, tier: 'Special', shapeType: 'Line', displayName: 'Furnace Module (Blast)', group: 'Special' });

export const NODE_TEMPLATE: ModuleTemplate = { shape: 'Node1x2', color: 'White', size: 2, tier: 'Base', shapeType: 'Node', displayName: 'Node (Medium)', group: 'All' };