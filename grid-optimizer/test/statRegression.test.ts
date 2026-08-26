import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateBoardStats, emptyBoard } from '../src/optimizerCore.ts';
import { applyInternalEffects } from '../src/utils.ts';
import type { InventoryItem } from '../src/types.ts';

type Fixture = [string, InventoryItem['displayName'], InventoryItem['shape'], InventoryItem['color'], InventoryItem['effects'], [number, number][]];

const item = ([id, displayName, shape, color, effects]: Fixture): InventoryItem => ({
    id, displayName, shape, color, effects, effectValues: [0, 0]
});

const moistureFarm1: Fixture[] = [
    ['307', 'Overclock', 'Square4_High', 'Red', ['None', 'None'], [[0, 0], [1, 0], [0, 1], [1, 1]]],
    ['308', 'Node', 'Node1x2', 'White', ['None', 'None'], [[2, 0], [2, 1]]],
    ['317', 'Ruined', 'L3', 'Grey', ['None', 'None'], [[4, 0], [5, 0], [5, 1]]],
    ['309', 'Node', 'Node1x2', 'White', ['None', 'None'], [[6, 0], [6, 1]]],
    ['310', 'Node', 'Node1x2', 'White', ['None', 'None'], [[4, 1], [4, 2]]],
    ['311', 'Overclock', 'P5', 'Red', ['None', 'None'], [[0, 2], [1, 2], [0, 3], [1, 3], [1, 4]]],
    ['312', 'Node', 'Node1x2', 'White', ['None', 'None'], [[2, 2], [3, 2]]],
    ['313', 'Overclock', 'Square4_High', 'Red', ['Premium', 'Negative Feedback'], [[5, 2], [6, 2], [5, 3], [6, 3]]],
    ['314', 'Node', 'Node1x2', 'White', ['None', 'None'], [[2, 3], [2, 4]]],
    ['315', 'Refinement', 'Square4_High', 'Yellow', ['Receiver', 'None'], [[3, 3], [4, 3], [3, 4], [4, 4]]],
    ['316', 'Node', 'Node1x2', 'White', ['None', 'None'], [[5, 4], [6, 4]]]
];

test('save regression: Premium then Negative Feedback folds in slot order', () => {
    assert.deepEqual(applyInternalEffects(item(moistureFarm1[7])), {
        Performance: 53,
        Quality: 0,
        Efficiency: -65
    });
});

test('save regression: Moisture Farm #1 matches its stored game totals', () => {
    const board = emptyBoard(3);
    moistureFarm1.forEach(fixture => {
        const module = item(fixture);
        fixture[5].forEach(([x, y]) => { board[y][x] = module; });
    });

    const stats = calculateBoardStats(board);
    assert.deepEqual(stats.totals, { Performance: 170, Quality: 55, Efficiency: -269 });
    assert.deepEqual(stats.pieceStats.get('313'), { Performance: 51, Quality: 0, Efficiency: -68 });
});
