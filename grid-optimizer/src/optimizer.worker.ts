/// <reference lib="webworker" />
import { optimizeGlobal } from './optimizerCore';
import type { Board, OptimizerMachine } from './optimizerCore';
import type { InventoryItem } from './types';

type RunMessage = {
    machines: OptimizerMachine[];
    boards: Board[];
    inventory: InventoryItem[];
    timeLimitMs: number;
};

self.onmessage = async ({ data }: MessageEvent<RunMessage>) => {
    self.postMessage({ type: 'started' });
    const result = await optimizeGlobal(data.machines, data.inventory, data.timeLimitMs, updates => self.postMessage({ type: 'update', updates }), data.boards);
    self.postMessage({ type: 'done', updates: result });
};
