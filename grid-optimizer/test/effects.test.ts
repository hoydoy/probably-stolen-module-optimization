import assert from 'node:assert/strict';
import test from 'node:test';
import { applyInternalEffects } from '../src/utils.ts';
import type { InventoryItem } from '../src/types.ts';

const moduleItem = (shape: InventoryItem['shape'], color: InventoryItem['color'], effects: InventoryItem['effects']): InventoryItem => ({
    id: `${shape}-${color}`,
    shape,
    color,
    displayName: color === 'Green' ? 'Efficiency' : 'Overclock',
    effects,
    effectValues: [0, 0]
});

test('internal effects truncate in save slot order, including negative stats', () => {
    assert.deepEqual(
        applyInternalEffects(moduleItem('L3', 'Green', ['Premium', 'Negative Feedback'])),
        { Performance: 0, Quality: 0, Efficiency: 17 }
    );
    assert.deepEqual(
        applyInternalEffects(moduleItem('Square4_High', 'Red', ['Side Mount', 'Negative Feedback'])),
        { Performance: 45, Quality: 0, Efficiency: -55 }
    );
});

test('learning and degrading respect non-commutative slot order', () => {
    const premiumThenLearning = moduleItem('L3', 'Green', ['Premium', 'Learning Algorithm']);
    premiumThenLearning.effectValues = [0, 5];
    assert.deepEqual(applyInternalEffects(premiumThenLearning), { Performance: 0, Quality: 0, Efficiency: 5 });

    const premiumThenDegrading = moduleItem('L3', 'Green', ['Premium', 'Degrading']);
    premiumThenDegrading.effectValues = [0, 10];
    assert.deepEqual(applyInternalEffects(premiumThenDegrading), { Performance: 0, Quality: 0, Efficiency: 10 });

    const degradingThenPremium = moduleItem('L3', 'Green', ['Degrading', 'Premium']);
    degradingThenPremium.effectValues = [10, 0];
    assert.deepEqual(applyInternalEffects(degradingThenPremium), { Performance: 0, Quality: 0, Efficiency: 10 });

    const degradingMixedStats = moduleItem('Square4_High', 'Green', ['Degrading', 'None']);
    degradingMixedStats.effectValues = [64, 0];
    assert.deepEqual(applyInternalEffects(degradingMixedStats), { Performance: -32, Quality: 0, Efficiency: 64 });
});

test('ruined modules provide no machine stats', () => {
    const ruined = { ...moduleItem('L3', 'Green', ['None', 'None']), displayName: 'Ruined Module' };
    assert.deepEqual(applyInternalEffects(ruined), { Performance: 0, Quality: 0, Efficiency: 0 });
});
