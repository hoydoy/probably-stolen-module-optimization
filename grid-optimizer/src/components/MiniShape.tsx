import {PRECOMPUTED_OFFSETS} from '../utils';
import type {ModuleShape, Point} from '../types';

interface MiniShapeProps {
    shape: ModuleShape;
    colorHex?: string;
    size?: string;
}

export default function MiniShape({shape, colorHex = '#fff', size = '8px'}: MiniShapeProps) {
    // Safely retrieve offsets with a fallback to a single 1x1 block if the shape is undefined/unregistered
    const offsetsList = PRECOMPUTED_OFFSETS.get(shape);
    const offsets: Point[] = (offsetsList && offsetsList.length > 0) ? offsetsList[0] : [{x: 0, y: 0}];

    const minX = Math.min(...offsets.map(p => p.x));
    const maxX = Math.max(...offsets.map(p => p.x));
    const minY = Math.min(...offsets.map(p => p.y));
    const maxY = Math.max(...offsets.map(p => p.y));

    const width = maxX - minX + 1;
    const height = maxY - minY + 1;

    return (
        <div style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${width}, ${size})`,
            gridTemplateRows: `repeat(${height}, ${size})`,
            gap: '1px',
            alignItems: 'center',
            justifyContent: 'center'
        }}>
            {offsets.map((pt, idx) => (
                <div
                    key={idx}
                    style={{
                        gridColumn: pt.x - minX + 1,
                        gridRow: pt.y - minY + 1,
                        width: size,
                        height: size,
                        backgroundColor: colorHex,
                        borderRadius: '1px'
                    }}
                />
            ))}
        </div>
    );
}