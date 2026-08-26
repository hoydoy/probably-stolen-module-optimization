import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateBoardStats, emptyBoard, optimizeGlobal, scoreBoards } from '../src/optimizerCore.ts';
import { applyInternalEffects } from '../src/utils.ts';
import { isModuleAllowedForMachine } from '../src/moduleRules.ts';
import type { OptimizerMachine } from '../src/optimizerCore.ts';
import type { InventoryItem } from '../src/types.ts';

const item = (id: string, color: InventoryItem['color']): InventoryItem => ({
    id,
    displayName: color === 'Red' ? 'Performance' : 'Quality',
    color,
    shape: 'L3',
    effects: ['None', 'None'],
    effectValues: [0, 0],
    moduleType: 'MODULE_TYPE_UNIVERSAL'
});
const boardWith = (...items: InventoryItem[]) => {
    const board = emptyBoard(3);
    items.forEach((module, index) => [[0, 0], [1, 0], [1, 1]].forEach(([dy, dx]) => { board[dy][index * 2 + dx] = module; }));
    return board;
};

test('global allocation does not trap performance modules in a quality-targeted alarm', async () => {
    const machines: OptimizerMachine[] = [
        {
            id: 'moisture', tier: 3,
            targetStats: { Performance: null, Quality: null, Efficiency: null },
            maximizeStats: { Performance: true, Quality: false, Efficiency: false }
        },
        {
            id: 'alarm', tier: 3, moduleType: 'MODULE_TYPE_ALARM',
            targetStats: { Performance: null, Quality: 50, Efficiency: null },
            maximizeStats: { Performance: false, Quality: false, Efficiency: false }
        }
    ];
    const inventory = [item('performance', 'Red'), ...Array.from({ length: 9 }, (_, index) => item(`quality-${index}`, 'Yellow'))];
    const result = await optimizeGlobal(machines, inventory, 0, () => undefined);

    assert.equal(result[0].board.flat().some(cell => cell !== null && cell !== 'Locked' && cell.id === 'performance'), true);
    assert.equal(result[1].board.flat().some(cell => cell !== null && cell !== 'Locked' && cell.id === 'performance'), false);
});

test('target allocation releases surplus modules to maximizing machines', async () => {
    const machines: OptimizerMachine[] = [
        {
            id: 'target', tier: 3,
            targetStats: { Performance: null, Quality: 6, Efficiency: null },
            maximizeStats: { Performance: false, Quality: false, Efficiency: false }
        },
        {
            id: 'maximize', tier: 3,
            targetStats: { Performance: null, Quality: null, Efficiency: null },
            maximizeStats: { Performance: false, Quality: true, Efficiency: false }
        }
    ];
    const inventory = [item('quality-1', 'Yellow'), item('quality-2', 'Yellow')];
    const result = await optimizeGlobal(machines, inventory, 0, () => undefined);
    const ids = result.map(update => new Set(update.board.flat().filter(cell => cell && cell !== 'Locked').map(cell => cell.id)));

    assert.equal(ids[0].size, 1);
    assert.equal(ids[1].size, 1);
    assert.equal(new Set([...ids[0], ...ids[1]]).size, 2);
});

test('required modules stay exclusive to their assigned machine', async () => {
    const red1 = item('red-1', 'Red');
    const red2 = item('red-2', 'Red');
    const machines: OptimizerMachine[] = ['one', 'two'].map((id, index) => ({
        id, tier: 3,
        targetStats: { Performance: null, Quality: null, Efficiency: null },
        maximizeStats: { Performance: true, Quality: false, Efficiency: false },
        requiredModuleIds: [index ? red2.id : red1.id]
    }));
    const result = await optimizeGlobal(machines, [red1, red2], 0, () => undefined);
    const ids = result.map(update => new Set(update.board.flat().filter(cell => cell && cell !== 'Locked').map(cell => cell.id)));
    assert.equal(ids[0].has(red1.id), true);
    assert.equal(ids[0].has(red2.id), false);
    assert.equal(ids[1].has(red2.id), true);
    assert.equal(ids[1].has(red1.id), false);
});

test('invalid required module assignments fail clearly', async () => {
    const alarm = { ...item('alarm', 'Red'), displayName: 'Alarm Module', moduleType: 'MODULE_TYPE_ALARM' };
    const machine: OptimizerMachine = {
        id: 'normal', tier: 3,
        targetStats: { Performance: null, Quality: null, Efficiency: null },
        maximizeStats: { Performance: true, Quality: false, Efficiency: false },
        requiredModuleIds: [alarm.id]
    };
    await assert.rejects(optimizeGlobal([machine], [alarm], 0, () => undefined), /cannot be used/);
});

test('cached module stats preserve board scoring without mutating the cache', () => {
    const module = item('performance', 'Red');
    module.effects = ['Negative Feedback', 'Premium'];
    const board = emptyBoard(3);
    board[0][0] = board[0][1] = board[1][0] = module;
    const cached = new Map([[module.id, applyInternalEffects(module)]]);
    const before = { ...cached.get(module.id)! };

    assert.deepEqual(calculateBoardStats(board, cached), calculateBoardStats(board));
    assert.deepEqual(cached.get(module.id), before);
});

test('starting boards keep compatible modules and discard invalid assignments and duplicates', async () => {
    const machines: OptimizerMachine[] = Array.from({ length: 2 }, (_, index) => ({
        id: `machine-${index}`, tier: 3,
        targetStats: { Performance: null, Quality: null, Efficiency: null },
        maximizeStats: { Performance: false, Quality: false, Efficiency: false }
    }));
    const normal = item('normal', 'Red');
    const alarm = { ...item('alarm', 'Red'), displayName: 'Alarm Module', moduleType: 'MODULE_TYPE_ALARM' };
    const boards = machines.map(() => emptyBoard(3));
    [[0, 0], [0, 1], [1, 1]].forEach(([y, x]) => {
        boards[0][y][x] = normal;
        boards[1][y][x] = normal;
    });
    [[0, 5], [0, 6], [1, 6]].forEach(([y, x]) => { boards[0][y][x] = alarm; });

    const result = await optimizeGlobal(machines, [normal, alarm], 0, () => undefined, boards);
    const ids = result.map(update => new Set(update.board.flat().filter(cell => cell && cell !== 'Locked').map(cell => cell.id)));

    assert.deepEqual([...ids[0]], ['normal']);
    assert.deepEqual([...ids[1]], []);
});

test('partial search keeps boards connected, compatible, and globally unique', async () => {
    const machines: OptimizerMachine[] = ['blast', 'junk'].map(choice => ({
        id: choice, tier: 3, moduleType: 'MODULE_TYPE_FURNACE', furnaceModules: choice as 'blast' | 'junk',
        targetStats: { Performance: null, Quality: null, Efficiency: null },
        maximizeStats: { Performance: true, Quality: false, Efficiency: false }
    }));
    const blast = { ...item('blast', 'Grey'), displayName: 'Blast Module', shape: 'Line4' as const, moduleType: 'MODULE_TYPE_FURNACE' };
    const junk = { ...item('junk', 'Grey'), displayName: 'Junk Processing', shape: 'Line4' as const, moduleType: 'MODULE_TYPE_FURNACE' };
    const inventory = [blast, junk, ...Array.from({ length: 8 }, (_, index) => item(`performance-${index}`, 'Red'))];
    const boards = machines.map(() => emptyBoard(3));
    [0, 1, 2, 3].forEach(x => boards[0][0][x] = blast);
    [0, 1, 2, 3].forEach(x => boards[1][0][x] = junk);

    const result = await optimizeGlobal(machines, inventory, 30, () => undefined, boards);
    const used = new Set<string>();
    result.forEach((update, index) => {
        const cells = update.board.flatMap((row, y) => row.flatMap((cell, x) => cell && cell !== 'Locked' ? [{ cell, x, y }] : []));
        const ids = new Set(cells.map(({ cell }) => cell.id));
        ids.forEach(id => {
            assert.equal(used.has(id), false);
            used.add(id);
            assert.equal(isModuleAllowedForMachine(inventory.find(candidate => candidate.id === id)!, machines[index]), true);
        });
        const wanted = new Set(cells.map(({ x, y }) => y * 7 + x));
        const pending = wanted.size ? [[...wanted][0]] : [];
        const seen = new Set(pending);
        while (pending.length) {
            const cell = pending.pop()!, x = cell % 7, y = Math.floor(cell / 7);
            [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]].forEach(([nx, ny]) => {
                const next = ny * 7 + nx;
                if (nx >= 0 && nx < 7 && ny >= 0 && ny < 5 && wanted.has(next) && !seen.has(next)) { seen.add(next); pending.push(next); }
            });
        }
        assert.equal(seen.size, wanted.size);
    });
    assert.equal(used.has('blast'), true);
    assert.equal(used.has('junk'), true);
});

test('priorities and cross-machine balance affect score in that order', () => {
    const red = item('red', 'Red');
    const red2 = item('red-2', 'Red');
    const yellow = item('yellow', 'Yellow');
    const base: OptimizerMachine = {
        id: 'one', tier: 3,
        targetStats: { Performance: null, Quality: null, Efficiency: null },
        maximizeStats: { Performance: true, Quality: false, Efficiency: false }
    };

    const prioritized = {
        ...base,
        targetStats: { Performance: null, Quality: 6, Efficiency: null },
        statPriority: { Performance: 2, Quality: 1, Efficiency: 3 }
    };
    const redScore = scoreBoards([boardWith(red)], [prioritized], [red, yellow]);
    const yellowScore = scoreBoards([boardWith(yellow)], [prioritized], [red, yellow]);
    assert.ok(yellowScore[1] > redScore[1]);

    const pair = [{ ...base, id: 'one' }, { ...base, id: 'two' }];
    const imbalanced = scoreBoards([boardWith(red, red2), emptyBoard(3)], pair, [red, red2]);
    const balanced = scoreBoards([boardWith(red), boardWith(red2)], pair, [red, red2]);
    assert.ok(balanced[1] > imbalanced[1]);
});
