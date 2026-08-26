import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMovePlan, reconcileMoveTargets } from '../src/movePlan.ts';

test('move plan preserves exact modules, breaks swaps with staging, and clears extras last', () => {
    const current = [
        { moduleId: 'keep', locationId: 'a', locationName: 'A', cells: [0], columns: 3 },
        { moduleId: 'left', locationId: 'a', locationName: 'A', cells: [1], columns: 3 },
        { moduleId: 'right', locationId: 'b', locationName: 'B', cells: [1], columns: 3 },
        { moduleId: 'extra', locationId: 'a', locationName: 'A', cells: [2], columns: 3 }
    ];
    const target = [
        { moduleId: 'keep', locationId: 'a', locationName: 'A', cells: [0], columns: 3 },
        { moduleId: 'left', locationId: 'b', locationName: 'B', cells: [1], columns: 3 },
        { moduleId: 'right', locationId: 'a', locationName: 'A', cells: [1], columns: 3 }
    ];
    const steps = buildMovePlan(current, target, new Set(['a', 'b']), [{ id: 'shop', name: 'Shop Inventory', width: 4, height: 4, occupied: [] }]);

    assert.equal(steps.some(step => step.moduleId === 'keep'), false);
    assert.equal(steps.filter(step => step.temporary).length, 2);
    assert.equal(steps.at(-1)?.moduleId, 'extra');
    assert.equal(steps.find(step => step.temporary && step.moduleId !== 'extra')?.finalToName, 'B');
    assert.deepEqual(new Set(steps.filter(step => !step.temporary).map(step => step.moduleId)), new Set(['left', 'right']));
});

test('move plan batches moves that use the same open inventories', () => {
    const current = ['one', 'two', 'three'].map((moduleId, index) => ({ moduleId, locationId: 'shop', locationName: 'Shop', cells: [index], columns: 3 }));
    const target = [
        { moduleId: 'one', locationId: 'a', locationName: 'A', cells: [0], columns: 3 },
        { moduleId: 'three', locationId: 'b', locationName: 'B', cells: [0], columns: 3 },
        { moduleId: 'two', locationId: 'a', locationName: 'A', cells: [1], columns: 3 }
    ];

    const steps = buildMovePlan(current, target, new Set(['a', 'b']), [{ id: 'shop', name: 'Shop', width: 3, height: 3, occupied: [] }]);
    assert.deepEqual(steps.map(step => step.toId), ['a', 'a', 'b']);
});

test('temporary moves use exact Shop cells, then fall back to real storage without rotating', () => {
    const current = [
        { moduleId: 'left', locationId: 'a', locationName: 'A', cells: [0, 1, 3], columns: 3 },
        { moduleId: 'right', locationId: 'b', locationName: 'B', cells: [0, 1, 3], columns: 3 }
    ];
    const target = [
        { moduleId: 'left', locationId: 'b', locationName: 'B', cells: [0, 1, 3], columns: 3 },
        { moduleId: 'right', locationId: 'a', locationName: 'A', cells: [0, 1, 3], columns: 3 }
    ];
    const steps = buildMovePlan(current, target, new Set(['a', 'b']), [
        { id: 'shop', name: 'Shop', width: 2, height: 2, occupied: [0, 1] },
        { id: 'storage', name: 'Storage', width: 4, height: 4, occupied: [] }
    ]);
    const staged = steps.find(step => step.temporary)!;

    assert.equal(staged.toId, 'storage');
    assert.deepEqual(staged.targetCells, [0, 1, 4]);
    assert.equal(staged.targetColumns, 4);
});

test('all temporary modules use one staging inventory instead of spilling across several', () => {
    const current = ['one', 'two'].map((moduleId, index) => ({
        moduleId, locationId: 'machine', locationName: 'Machine', cells: [index], columns: 2
    }));
    const steps = buildMovePlan(current, [], new Set(['machine']), [
        { id: 'shop', name: 'Shop', width: 1, height: 1, occupied: [] },
        { id: 'storage', name: 'Storage', width: 2, height: 1, occupied: [] }
    ]);

    assert.deepEqual(steps.map(step => step.toId), ['storage', 'storage']);
});

test('cycle planning chooses the single shared breaker instead of staging twice', () => {
    const current = [
        { moduleId: 'a', locationId: 'machine', locationName: 'Machine', cells: [0, 3], columns: 3 },
        { moduleId: 'b', locationId: 'machine', locationName: 'Machine', cells: [1], columns: 3 },
        { moduleId: 'c', locationId: 'machine', locationName: 'Machine', cells: [2], columns: 3 }
    ];
    const target = [
        { ...current[0], cells: [1, 2] },
        { ...current[1], cells: [0] },
        { ...current[2], cells: [3] }
    ];
    const steps = buildMovePlan(current, target, new Set(['machine']), [{ id: 'shop', name: 'Shop', width: 4, height: 4, occupied: [] }]);

    assert.equal(steps.length, 4);
    assert.deepEqual(steps.filter(step => step.temporary).map(step => step.moduleId), ['a']);
});

test('identical modules keep their existing slots instead of swapping IDs', () => {
    const current = [
        { moduleId: 'node-a', locationId: 'machine', locationName: 'Machine', cells: [0, 3], columns: 3, interchangeableGroup: 'node' },
        { moduleId: 'node-b', locationId: 'machine', locationName: 'Machine', cells: [1, 4], columns: 3, interchangeableGroup: 'node' }
    ];
    const target = [
        { moduleId: 'node-a', locationId: 'machine', locationName: 'Machine', cells: [1, 4], columns: 3, interchangeableGroup: 'node' },
        { moduleId: 'node-b', locationId: 'machine', locationName: 'Machine', cells: [0, 3], columns: 3, interchangeableGroup: 'node' }
    ];

    assert.deepEqual(buildMovePlan(current, target, new Set(['machine']), [{ id: 'shop', name: 'Shop', width: 4, height: 4, occupied: [] }]), []);
    assert.deepEqual(reconcileMoveTargets(current, target).map(placement => placement.moduleId), ['node-b', 'node-a']);
    assert.deepEqual(reconcileMoveTargets(current, target, new Set(['node-a'])).map(placement => placement.moduleId), ['node-a', 'node-b']);
});

test('move plan rejects a target module missing from the imported inventory', () => {
    assert.throws(() => buildMovePlan([], [
        { moduleId: 'missing', locationId: 'machine', locationName: 'Machine', cells: [0], columns: 7 }
    ], new Set(['machine']), [{ id: 'shop', name: 'Shop', width: 4, height: 4, occupied: [] }]), /missing from the imported inventory/);
});
