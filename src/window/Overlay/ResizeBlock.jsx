import React, { useRef } from 'react';

// 8 个缩放控制点：key => [光标, 影响的边]
const HANDLES = [
    { key: 'nw', cursor: 'nwse-resize', edges: ['l', 't'] },
    { key: 'n', cursor: 'ns-resize', edges: ['t'] },
    { key: 'ne', cursor: 'nesw-resize', edges: ['r', 't'] },
    { key: 'e', cursor: 'ew-resize', edges: ['r'] },
    { key: 'se', cursor: 'nwse-resize', edges: ['r', 'b'] },
    { key: 's', cursor: 'ns-resize', edges: ['b'] },
    { key: 'sw', cursor: 'nesw-resize', edges: ['l', 'b'] },
    { key: 'w', cursor: 'ew-resize', edges: ['w'] },
];

const HANDLE_POS = {
    nw: { left: -4, top: -4 },
    n: { left: '50%', top: -4, transform: 'translateX(-50%)' },
    ne: { right: -4, top: -4 },
    e: { right: -4, top: '50%', transform: 'translateY(-50%)' },
    se: { right: -4, bottom: -4 },
    s: { left: '50%', bottom: -4, transform: 'translateX(-50%)' },
    sw: { left: -4, bottom: -4 },
    w: { left: -4, top: '50%', transform: 'translateY(-50%)' },
};

const MIN_SIZE = 4; // 百分比
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

// 可拖拽缩放的译文覆盖块（仿网易有道截图翻译）
// overrideEdges：会话内缩放结果 {l,t,r,b}（百分比，r/b 为距左/上的绝对百分比坐标）
export default function ResizeBlock({
    edges,
    fontSize,
    blockTheme,
    compare,
    sourceText,
    translation,
    selected,
    onSelect,
    onResize,
}) {
    const dragRef = useRef(null);

    const beginResize = (e, handleEdges) => {
        e.stopPropagation();
        e.preventDefault();
        const container = e.currentTarget.parentElement.parentElement; // 控制点 -> 块 -> 容器
        const rect = container.getBoundingClientRect();
        dragRef.current = {
            edges: handleEdges,
            startX: e.clientX,
            startY: e.clientY,
            start: { ...edges },
            width: rect.width,
            height: rect.height,
        };
        const onMove = (ev) => {
            const d = dragRef.current;
            if (!d) return;
            const dxPct = ((ev.clientX - d.startX) / d.width) * 100;
            const dyPct = ((ev.clientY - d.startY) / d.height) * 100;
            const next = { ...d.start };
            for (const edge of d.edges) {
                if (edge === 'l') next.l = clamp(d.start.l + dxPct, 0, next.r - MIN_SIZE);
                if (edge === 'r') next.r = clamp(d.start.r + dxPct, next.l + MIN_SIZE, 100);
                if (edge === 't') next.t = clamp(d.start.t + dyPct, 0, next.b - MIN_SIZE);
                if (edge === 'b') next.b = clamp(d.start.b + dyPct, next.t + MIN_SIZE, 100);
            }
            onResize(next);
        };
        const onUp = () => {
            dragRef.current = null;
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    };

    const light = blockTheme === 'light';

    return (
        <div
            onPointerDown={(e) => {
                e.stopPropagation();
                onSelect();
            }}
            className={`absolute flex flex-col justify-center rounded-[2px] ${
                light ? 'bg-white/85 text-neutral-800' : 'bg-black/72 text-white'
            } ${
                selected
                    ? 'outline outline-[1.5px] outline-[#ff6a3d]'
                    : 'hover:outline hover:outline-[1px] hover:outline-[#ff6a3d]/70'
            }`}
            style={{
                left: `${edges.l}%`,
                top: `${edges.t}%`,
                width: `${edges.r - edges.l}%`,
                height: `${edges.b - edges.t}%`,
                padding: '0 3px',
                overflow: 'hidden',
            }}
        >
            {compare && sourceText && (
                <span
                    className={`block whitespace-pre-wrap break-words leading-tight ${
                        light ? 'text-neutral-500' : 'text-white/55'
                    }`}
                    style={{ fontSize: Math.max(9, fontSize * 0.62) }}
                >
                    {sourceText}
                </span>
            )}
            {translation && (
                <span
                    className='whitespace-pre-wrap break-words leading-[1.15]'
                    style={{ fontSize }}
                >
                    {translation}
                </span>
            )}

            {selected &&
                HANDLES.map((h) => (
                    <span
                        key={h.key}
                        onPointerDown={(e) => beginResize(e, h.edges)}
                        className='absolute z-10 h-[7px] w-[7px] rounded-full border-[1.5px] border-[#ff6a3d] bg-white'
                        style={{ cursor: h.cursor, position: 'absolute', ...HANDLE_POS[h.key] }}
                    />
                ))}
        </div>
    );
}
