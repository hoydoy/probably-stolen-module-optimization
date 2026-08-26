import assert from 'node:assert/strict';
import test from 'node:test';
import { getMachineAbbreviation, getModuleLabelArea, hasStrongerSameShape, isModuleAllowedForMachine } from '../src/moduleRules.ts';
import { applyInternalEffects } from '../src/utils.ts';
import type { InventoryItem } from '../src/types.ts';

const moduleItem = (displayName: string, moduleType = 'MODULE_TYPE_FURNACE') => ({
    id: displayName,
    displayName,
    moduleType,
    shape: 'Line4',
    color: 'Grey',
    effects: ['None', 'None'],
    effectValues: [0, 0]
} as InventoryItem);

test('furnace special modules are used only when selected for a furnace', () => {
    const junk = moduleItem('Junk Processing');
    const blast = moduleItem('Blast Module');
    const normal = moduleItem('Performance', 'MODULE_TYPE_UNIVERSAL');

    assert.equal(isModuleAllowedForMachine(junk, { moduleType: 'MODULE_TYPE_FURNACE', furnaceModules: 'none' }), false);
    assert.equal(isModuleAllowedForMachine(junk, { moduleType: 'MODULE_TYPE_FURNACE', furnaceModules: 'junk' }), true);
    assert.equal(isModuleAllowedForMachine(blast, { moduleType: 'MODULE_TYPE_FURNACE', furnaceModules: 'junk' }), false);
    assert.equal(isModuleAllowedForMachine(blast, { moduleType: 'MODULE_TYPE_FURNACE', furnaceModules: 'both' }), true);
    assert.equal(isModuleAllowedForMachine(junk, { moduleType: undefined, furnaceModules: 'both' }), false);
    assert.equal(isModuleAllowedForMachine(normal, { moduleType: undefined }), true);
});

test('alarm modules are used only when selected for an alarm system', () => {
    const alarm = moduleItem('Alarm Module', 'MODULE_TYPE_ALARM');
    assert.equal(isModuleAllowedForMachine(alarm, { moduleType: 'MODULE_TYPE_ALARM', alarmModule: false }), false);
    assert.equal(isModuleAllowedForMachine(alarm, { moduleType: 'MODULE_TYPE_ALARM', alarmModule: true }), true);
    assert.equal(isModuleAllowedForMachine(alarm, { moduleType: undefined, alarmModule: true }), false);
});

test('module labels prefer a usable horizontal arm', () => {
    assert.deepEqual(getModuleLabelArea([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }]), { x: 0, y: 0, width: 2, height: 2 });
    assert.deepEqual(getModuleLabelArea([{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 0, y: 2 }]), { x: 0, y: 1, width: 2, height: 1 });
    assert.deepEqual(getModuleLabelArea([{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }]), { x: 0, y: 0, width: 1, height: 3 });
});

test('machine names get compact inventory labels', () => {
    assert.equal(getMachineAbbreviation('Moisture Farm #1'), 'MF#1');
    assert.equal(getMachineAbbreviation('Water Purifier'), 'WP');
});

test('a same-shape module with higher stats makes the weaker one replaceable', () => {
    const weak = { ...moduleItem('Quality', 'MODULE_TYPE_UNIVERSAL'), id: 'weak', shape: 'Square4_Base', color: 'Yellow' } as InventoryItem;
    const strong = { ...weak, id: 'strong', effects: ['Premium', 'Premium'] } as InventoryItem;
    const differentShape = { ...strong, id: 'different', shape: 'T4_Base' } as InventoryItem;
    const degrading = { ...weak, id: 'degrading', effects: ['Degrading', 'None'], effectValues: [64, 0] } as InventoryItem;

    assert.equal(hasStrongerSameShape(weak, [weak, strong]), true);
    assert.equal(hasStrongerSameShape(weak, [weak, differentShape]), false);
    assert.equal(hasStrongerSameShape(weak, [weak, degrading]), false);
    assert.equal(hasStrongerSameShape(strong, [weak, strong]), false);
});

test('a degrading module does not make a stable same-shape backup replaceable', () => {
    const stable = { ...moduleItem('Eco', 'MODULE_TYPE_UNIVERSAL'), id: 'stable', shape: 'Square4_High', color: 'Green' } as InventoryItem;
    const degrading = { ...stable, id: 'degrading', effects: ['Degrading', 'None'], effectValues: [64, 0] } as InventoryItem;

    assert.deepEqual(applyInternalEffects(stable), { Performance: -16, Quality: 0, Efficiency: 32 });
    assert.deepEqual(applyInternalEffects(degrading), { Performance: -32, Quality: 0, Efficiency: 64 });
    assert.equal(hasStrongerSameShape(stable, [stable, degrading]), false);
});

test('replacement candidates must be available and have matching placement effects', () => {
    const weak = { ...moduleItem('Quality', 'MODULE_TYPE_UNIVERSAL'), id: 'weak', shape: 'Square4_Base', color: 'Yellow' } as InventoryItem;
    const strong = { ...weak, id: 'strong', effects: ['Premium', 'None'] } as InventoryItem;
    const receiver = { ...strong, id: 'receiver', effects: ['Receiver', 'Premium'] } as InventoryItem;

    assert.equal(hasStrongerSameShape(weak, [weak, strong], new Set(['weak'])), false);
    assert.equal(hasStrongerSameShape(weak, [weak, receiver]), false);
    assert.equal(hasStrongerSameShape(weak, [weak, strong], new Set(['weak', 'strong'])), true);
});
