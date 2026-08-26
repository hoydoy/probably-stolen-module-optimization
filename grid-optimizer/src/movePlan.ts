export type MovePlacement = {
    moduleId: string;
    locationId: string;
    locationName: string;
    cells: number[];
    columns: number;
    interchangeableGroup?: string;
};

export type StagingArea = {
    id: string;
    name: string;
    width: number;
    height: number;
    occupied: number[];
};

export type MoveStep = {
    moduleId: string;
    fromId: string;
    fromName: string;
    toId: string;
    toName: string;
    targetCells: number[];
    targetColumns: number;
    temporary: boolean;
    finalToName?: string;
};

const sameCells = (a: number[], b: number[]) => a.length === b.length && a.every(cell => b.includes(cell));

function findDependencyCycle(graph: Map<string, string[]>, removed: Set<string>) {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const stack: string[] = [];
    const visit = (id: string): string[] | null => {
        if (removed.has(id) || visited.has(id)) return null;
        if (visiting.has(id)) return stack.slice(stack.indexOf(id));
        visiting.add(id);
        stack.push(id);
        for (const dependency of graph.get(id) || []) {
            const cycle = visit(dependency);
            if (cycle) return cycle;
        }
        stack.pop();
        visiting.delete(id);
        visited.add(id);
        return null;
    };
    for (const id of graph.keys()) {
        const cycle = visit(id);
        if (cycle) return cycle;
    }
    return null;
}

function minimumCycleBreakers(graph: Map<string, string[]>) {
    let budget = 4096;
    let exhausted = false;
    let best: Set<string> | null = null;
    const search = (removed: Set<string>) => {
        if (--budget < 0) {
            exhausted = true;
            return;
        }
        if (best && removed.size >= best.size) return;
        const cycle = findDependencyCycle(graph, removed);
        if (!cycle) {
            best = new Set(removed);
            return;
        }
        cycle.forEach(id => search(new Set([...removed, id])));
    };
    search(new Set());
    if (!exhausted && best) return [...best];

    // ponytail: bounded exact search; fall back to a guaranteed member of a real cycle.
    const cycle = findDependencyCycle(graph, new Set());
    if (!cycle) return [];
    return cycle.sort((a, b) =>
        ((graph.get(b)?.length || 0) + [...graph.values()].filter(deps => deps.includes(b)).length)
        - ((graph.get(a)?.length || 0) + [...graph.values()].filter(deps => deps.includes(a)).length)
    ).slice(0, 1);
}

function normalizedShape(placement: MovePlacement) {
    const points = placement.cells.map(cell => ({ x: cell % placement.columns, y: Math.floor(cell / placement.columns) }));
    const minX = Math.min(...points.map(point => point.x));
    const minY = Math.min(...points.map(point => point.y));
    return points.map(point => ({ x: point.x - minX, y: point.y - minY }));
}

export function reconcileMoveTargets(current: MovePlacement[], target: MovePlacement[], fixedModuleIds = new Set<string>()) {
    const normalizedTarget = target.map(placement => ({ ...placement, cells: [...placement.cells] }));
    const slotsByGroup = new Map<string, MovePlacement[]>();
    normalizedTarget.forEach(placement => {
        if (placement.interchangeableGroup) (slotsByGroup.get(placement.interchangeableGroup) || slotsByGroup.set(placement.interchangeableGroup, []).get(placement.interchangeableGroup)!).push(placement);
    });
    slotsByGroup.forEach((slots, group) => {
        const candidates = current.filter(placement => placement.interchangeableGroup === group);
        const used = new Set<string>();
        const assigned = new Set<MovePlacement>();
        const assign = (slot: MovePlacement, candidate?: MovePlacement) => {
            if (!candidate) return;
            slot.moduleId = candidate.moduleId;
            used.add(candidate.moduleId);
            assigned.add(slot);
        };
        slots.filter(slot => fixedModuleIds.has(slot.moduleId)).forEach(slot => {
            used.add(slot.moduleId);
            assigned.add(slot);
        });
        slots.filter(slot => !assigned.has(slot)).forEach(slot => assign(slot, candidates.find(candidate => !used.has(candidate.moduleId) && candidate.locationId === slot.locationId && sameCells(candidate.cells, slot.cells))));
        slots.forEach(slot => {
            if (assigned.has(slot)) return;
            assign(slot, candidates.find(candidate => !used.has(candidate.moduleId) && candidate.locationId === slot.locationId)
                || candidates.find(candidate => !used.has(candidate.moduleId) && candidate.moduleId === slot.moduleId)
                || candidates.find(candidate => !used.has(candidate.moduleId)));
        });
    });
    return normalizedTarget;
}

function buildMovePlanUsing(
    current: MovePlacement[],
    target: MovePlacement[],
    managedMachineIds: Set<string>,
    stagingArea?: StagingArea,
    fixedModuleIds = new Set<string>()
) {
    const state = new Map(current.map(placement => [placement.moduleId, { ...placement, cells: [...placement.cells] }]));
    const normalizedTarget = reconcileMoveTargets(current, target, fixedModuleIds);
    const targets = new Map(normalizedTarget.map(placement => [placement.moduleId, placement]));
    const pending = new Set(normalizedTarget.filter(wanted => {
        const placed = state.get(wanted.moduleId);
        return !placed || placed.locationId !== wanted.locationId || !sameCells(placed.cells, wanted.cells);
    }).map(placement => placement.moduleId));
    const steps: MoveStep[] = [];
    let open = new Set<string>();

    const addMove = (moduleId: string, destination: MovePlacement, temporary: boolean) => {
        const source = state.get(moduleId);
        if (!source) throw new Error(`Module ${moduleId} is missing from the imported inventory.`);
        steps.push({
            moduleId,
            fromId: source.locationId,
            fromName: source.locationName,
            toId: destination.locationId,
            toName: destination.locationName,
            targetCells: [...destination.cells],
            targetColumns: destination.columns,
            temporary,
            finalToName: temporary ? targets.get(moduleId)?.locationName : undefined
        });
        state.set(moduleId, { ...destination, moduleId, cells: [...destination.cells] });
        open = new Set([source.locationId, destination.locationId]);
    };

    const blockersFor = (wanted: MovePlacement) => [...state.values()].filter(placed =>
        placed.moduleId !== wanted.moduleId
        && placed.locationId === wanted.locationId
        && placed.cells.some(cell => wanted.cells.includes(cell))
    );

    const stagingPlacement = (moduleId: string) => {
        const source = state.get(moduleId)!;
        const shape = normalizedShape(source);
        if (stagingArea) {
            const occupied = new Set(stagingArea.occupied);
            state.forEach(placed => {
                if (placed.locationId === stagingArea.id) placed.cells.forEach(cell => occupied.add(cell));
            });
            for (let y = 0; y < stagingArea.height; y++) {
                for (let x = 0; x < stagingArea.width; x++) {
                    const cells = shape.map(point => (y + point.y) * stagingArea.width + x + point.x);
                    if (shape.some(point => x + point.x >= stagingArea.width || y + point.y >= stagingArea.height) || cells.some(cell => occupied.has(cell))) continue;
                    return { moduleId, locationId: stagingArea.id, locationName: stagingArea.name, cells, columns: stagingArea.width };
                }
            }
        }
        throw new Error('No real Shop Inventory or Storage Bay space can hold a temporary module.');
    };

    while (pending.size) {
        const ready = [...pending].map(id => targets.get(id)!).filter(wanted => blockersFor(wanted).length === 0);
        if (ready.length) {
            ready.sort((a, b) => {
                const sourceA = state.get(a.moduleId)!;
                const sourceB = state.get(b.moduleId)!;
                const costA = Number(!open.has(sourceA.locationId)) + Number(!open.has(a.locationId));
                const costB = Number(!open.has(sourceB.locationId)) + Number(!open.has(b.locationId));
                return costA - costB;
            });
            const wanted = ready[0];
            addMove(wanted.moduleId, wanted, false);
            pending.delete(wanted.moduleId);
            continue;
        }

        const blocked = [...pending].flatMap(id => blockersFor(targets.get(id)!));
        const externalBlocker = blocked
            .filter(blocker => !pending.has(blocker.moduleId))
            .sort((a, b) => blocked.filter(item => item.moduleId === b.moduleId).length - blocked.filter(item => item.moduleId === a.moduleId).length)[0];
        if (externalBlocker) {
            addMove(externalBlocker.moduleId, stagingPlacement(externalBlocker.moduleId), true);
            continue;
        }

        const dependencies = new Map([...pending].map(id => [
            id,
            blockersFor(targets.get(id)!).filter(blocker => pending.has(blocker.moduleId)).map(blocker => blocker.moduleId)
        ]));
        const breaker = minimumCycleBreakers(dependencies)
            .sort((a, b) => Number(!open.has(state.get(a)!.locationId)) - Number(!open.has(state.get(b)!.locationId)))[0];
        if (!breaker) throw new Error('Could not resolve blocked module placements.');
        addMove(breaker, stagingPlacement(breaker), true);
    }

    // Modules omitted from an optimized board are moved only after all required placements are complete.
    state.forEach(placed => {
        if (managedMachineIds.has(placed.locationId) && !targets.has(placed.moduleId)) {
            addMove(placed.moduleId, stagingPlacement(placed.moduleId), true);
        }
    });

    return steps;
}

export function buildMovePlan(
    current: MovePlacement[],
    target: MovePlacement[],
    managedMachineIds: Set<string>,
    stagingAreas: StagingArea[],
    fixedModuleIds = new Set<string>()
) {
    if (stagingAreas.length === 0) return buildMovePlanUsing(current, target, managedMachineIds, undefined, fixedModuleIds);
    let noSpace: unknown;
    for (const area of stagingAreas) {
        try {
            return buildMovePlanUsing(current, target, managedMachineIds, area, fixedModuleIds);
        } catch (error) {
            if (!(error instanceof Error) || !error.message.startsWith('No real Shop Inventory or Storage Bay space')) throw error;
            noSpace = error;
        }
    }
    throw noSpace;
}
