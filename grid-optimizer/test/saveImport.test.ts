import assert from 'node:assert/strict';
import test from 'node:test';
import { importEs3Save, inferMachinePanes } from '../src/saveImport.ts';
import type { ImportedGridItem } from '../src/saveImport.ts';

const shape = (x: number, y: number, width: number, height: number, data: number[], orientation = 0) => ({
    '<minX>k__BackingField': x,
    '<minY>k__BackingField': y,
    '<flipped>k__BackingField': false,
    '<orientation>k__BackingField': orientation,
    '<width>k__BackingField': width,
    '<height>k__BackingField': height,
    data
});

const value = (identifier: string, valueInt = 0, internalValueString = '') => ({
    '<identifier>k__BackingField': identifier,
    valueInt,
    internalValueString
});

test('imports module ownership, effects, machine tier, and board position', () => {
    const moduleValues = [
        value('MODULE_TAG'),
        value('MODULE_TYPE', 0, 'MODULE_TYPE_UNIVERSAL'),
        value('BONUS_PERCENTAGE_PERFORMANCE_INT', 20),
        value('BONUS_PERCENTAGE_QUALITY_INT'),
        value('BONUS_PERCENTAGE_EFFICIENCY_INT'),
        value('MODULE_EFFECT1_TAG', 0, 'MODULE_EFFECT_RECEIVER'),
        value('MODULE_EFFECT2_TAG', 0, 'MODULE_EFFECT_NEGATIVE_FEEDBACK')
    ];
    const items = [
        {
            uuid: 0,
            identifier: 'save_bag',
            name: 'Save Bag',
            childItems: [1, 4, 5],
            itemModifiedShape: shape(0, 0, 3, 4, Array(12).fill(1)),
            _keys: [],
            _values: []
        },
        {
            uuid: 1,
            identifier: 'moisture_farm',
            name: 'Moisture Farm',
            childItems: [2, 3],
            childItemInventoryNode: [3, 3],
            itemModifiedShape: shape(6, 8, 3, 3, Array(9).fill(1)),
            _keys: ['MODULE_UPGRADE_STAGE_INT', 'IS_RECEIVING_BONUS_FROM_MODULE_BOOL'],
            _values: [value('MODULE_UPGRADE_STAGE_INT', 2), value('IS_RECEIVING_BONUS_FROM_MODULE_BOOL')]
        },
        {
            uuid: 2,
            identifier: 'system_module_performance',
            name: 'Performance Module',
            childItems: [],
            itemShape: shape(0, 0, 2, 2, [1, 1, 1, 1]),
            itemModifiedShape: shape(3, 2, 2, 2, [1, 1, 1, 1]),
            _keys: moduleValues.map(item => item['<identifier>k__BackingField']),
            _values: moduleValues
        },
        {
            uuid: 3,
            identifier: 'module_node_medium',
            name: 'Node (Medium)',
            childItems: [],
            itemShape: shape(0, 0, 1, 2, [1, 1]),
            itemModifiedShape: shape(4, 4, 1, 2, [1, 1], 3),
            _keys: ['MODULE_TAG', 'MODULE_TYPE'],
            _values: [value('MODULE_TAG'), value('MODULE_TYPE', 0, 'MODULE_TYPE_UNIVERSAL')]
        },
        {
            uuid: 4,
            identifier: 'system_module_ruined',
            name: 'Ruined Module',
            childItems: [],
            itemShape: shape(0, 0, 2, 2, [1, 1, 1, 0]),
            itemModifiedShape: shape(0, 0, 2, 2, [1, 1, 1, 0]),
            _keys: ['MODULE_TAG'],
            _values: [value('MODULE_TAG')]
        },
        {
            uuid: 5,
            identifier: 'furnace',
            name: 'Furnace',
            childItems: [],
            itemModifiedShape: shape(9, 8, 3, 3, Array(9).fill(1)),
            _keys: ['MODULE_UPGRADE_STAGE_INT', 'IS_RECEIVING_BONUS_FROM_MODULE_BOOL'],
            _values: [value('MODULE_UPGRADE_STAGE_INT', 0), value('IS_RECEIVING_BONUS_FROM_MODULE_BOOL')]
        }
    ];
    const outer = {
        dictionary: { '1': true },
        playerStore: { value: { mainInvJSON: JSON.stringify({ saveItems: items }) } }
    };
    const es3 = JSON.stringify(outer).replace('"dictionary":{"1":', '"dictionary":{1:');
    const imported = importEs3Save(es3);

    assert.equal(imported.modules.length, 3);
    assert.equal(imported.machines.length, 2);
    assert.equal(imported.machines[0].tier, 3);
    assert.equal(imported.machines[1].name, 'Furnace');
    assert.equal(imported.machines[1].tier, 1);
    assert.equal(imported.machines[1].board.flat().some(cell => cell !== null && typeof cell === 'object'), false);
    assert.equal(imported.inventoryGrid.items.find(item => item.id === '1')?.tier, 3);
    assert.equal(imported.inventoryGrid.items.find(item => item.id === '5')?.machine, true);
    assert.equal(imported.inventoryGrid.items.find(item => item.id === '5')?.container, true);
    assert.equal(imported.machines[0].location, 'Shop Inventory @ (6, 8)');
    assert.deepEqual(imported.modules[0].effects, ['Receiver', 'Negative Feedback']);
    assert.equal(imported.modules[0].source?.location, 'Shop Inventory → Moisture Farm');
    assert.equal(imported.modules[2].source?.location, 'Shop Inventory');
    assert.equal(imported.modules[2].optimizable, false);
    assert.equal(imported.machines[0].board[2][3], imported.modules[0]);
    assert.equal(imported.machines[0].board[3][4], imported.modules[0]);
    assert.equal(imported.machines[0].board[4][4], imported.modules[1]);
    assert.equal(imported.machines[0].board[4][5], imported.modules[1]);
    assert.deepEqual(imported.inventoryGrid.items.find(item => item.id === '3')?.cells.map(cell => `${cell.x},${cell.y}`).sort(), ['0,0', '1,0']);
});

test('unknown machine panes stay separate and omit instruction notes', () => {
    const child = (id: string, node: number, x: number, y: number, width: number, height: number, identifier = id): ImportedGridItem => ({
        id, parentId: 'machine', name: id, x, y, width, height, container: false, identifier,
        machine: false, inventoryNode: node, cells: [{ x: 0, y: 0 }]
    });
    const panes = inferMachinePanes([
        child('battery', 2, 0, 0, 1, 2),
        child('module', 3, 5, 3, 2, 2),
        child('wine', 4, 5, 0, 1, 4),
        child('instructions', 5, 0, 0, 2, 2, 'postit')
    ]);

    assert.deepEqual(panes.map(pane => pane.node), [2, 3, 4]);
    assert.deepEqual(panes.map(({ width, height }) => [width, height]), [[1, 2], [7, 5], [6, 4]]);
});

test('imports the occupied counter as a separate inventory root', () => {
    const main = [{
        uuid: 0, identifier: 'save_bag', name: 'Save Bag', childItems: [],
        itemModifiedShape: shape(0, 0, 1, 1, [1]), _keys: [], _values: []
    }];
    const counter = [
        {
            uuid: 0, identifier: 'back_inv_save_bag', name: 'Back Inv Save Bag', childItems: [1],
            itemModifiedShape: shape(0, 0, 17, 10, Array(170).fill(1)), _keys: [], _values: []
        },
        {
            uuid: 1, identifier: 'storage_bay', name: 'Storage Bay', childItems: [2],
            itemModifiedShape: shape(9, 0, 3, 3, Array(9).fill(1)), _keys: [], _values: []
        },
        {
            uuid: 2, identifier: 'system_module_performance', name: 'Performance Module', childItems: [],
            itemShape: shape(0, 0, 2, 2, [1, 1, 1, 1]), itemModifiedShape: shape(2, 3, 2, 2, [1, 1, 1, 1]),
            _keys: ['MODULE_TAG', 'MODULE_TYPE'],
            _values: [value('MODULE_TAG'), value('MODULE_TYPE', 0, 'MODULE_TYPE_UNIVERSAL')]
        }
    ];
    const imported = importEs3Save(JSON.stringify({ playerStore: { value: {
        mainInvJSON: JSON.stringify({ saveItems: main }),
        backInvJSON: JSON.stringify({ saveItems: counter })
    } } }));

    assert.equal(imported.inventoryGrid.items.find(item => item.id === imported.inventoryGrid.counterRootId)?.name, 'Counter');
    const storage = imported.inventoryGrid.items.find(item => item.identifier === 'storage_bay');
    assert.equal(storage?.inventoryWidth, 10);
    assert.equal(imported.modules[0].source?.location, 'Counter → Storage Bay');
    assert.equal(imported.modules[0].source?.parentId, storage?.id);

    const withHigherMainUuid = importEs3Save(JSON.stringify({ playerStore: { value: {
        mainInvJSON: JSON.stringify({ saveItems: [...main, { ...main[0], uuid: 50, identifier: 'mouse_trap', name: 'Mouse Trap' }] }),
        backInvJSON: JSON.stringify({ saveItems: counter })
    } } }));
    assert.equal(withHigherMainUuid.modules[0].id, imported.modules[0].id);
});
