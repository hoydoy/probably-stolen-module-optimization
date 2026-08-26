import type { InventoryItem, Stats } from './types';
import type { Board, OptimizerMachine, OptimizerUpdate } from './optimizerCore';

export function runOptimizationWorker(
    machines: OptimizerMachine[],
    boards: Board[],
    inventory: InventoryItem[],
    isSolvingRef: { current: boolean },
    onUpdate: (updates: Map<string, { board: Board; totals: Stats; pieceStats: Map<string, Stats>; code: string }>) => void,
    timeLimitMs = 1500
) {
    return new Promise<void>((resolve, reject) => {
        const worker = new Worker(new URL('./optimizer.worker.ts', import.meta.url), { type: 'module' });
        let finished = false;
        let deadline: number | undefined;
        const finish = () => {
            if (finished) return;
            finished = true;
            clearInterval(cancelPoll);
            if (deadline !== undefined) clearTimeout(deadline);
            worker.terminate();
            resolve();
        };
        const emit = (updates: OptimizerUpdate[]) => onUpdate(new Map(updates.map(update => [update.id, { ...update, code: '' }])));
        const cancelPoll = window.setInterval(() => { if (!isSolvingRef.current) finish(); }, 25);
        worker.onmessage = ({ data }) => {
            if (finished) return;
            if (data.type === 'started' && Number.isFinite(timeLimitMs)) deadline = window.setTimeout(finish, timeLimitMs);
            if (data.type === 'update') emit(data.updates);
            if (data.type === 'done') { emit(data.updates); finish(); }
        };
        worker.onerror = event => {
            if (finished) return;
            finished = true;
            clearInterval(cancelPoll);
            if (deadline !== undefined) clearTimeout(deadline);
            worker.terminate();
            reject(new Error(event.message));
        };
        worker.postMessage({ machines, boards, inventory, timeLimitMs });
    });
}
