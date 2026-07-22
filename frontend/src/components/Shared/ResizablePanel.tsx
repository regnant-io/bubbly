import React, { useState, useRef, useEffect, ReactNode } from 'react';

interface ResizablePanelProps {
  children: ReactNode;
  /** Horizontal axis (default): initial width in px. */
  defaultWidth?: number;
  minWidth?: number;
  maxWidthPercent?: number;
  /** Vertical axis: initial height in px. */
  defaultHeight?: number;
  minHeight?: number;
  maxHeightPercent?: number;
  storageKey?: string;
  /** Which edge the resize handle sits on. */
  position?: 'left' | 'right' | 'top' | 'bottom';
  /** Resize direction. */
  axis?: 'horizontal' | 'vertical';
  className?: string;
  onResize?: (size: number) => void;
}

/**
 * ResizablePanel — draggable resize handle on one edge. Supports both
 * horizontal (width) and vertical (height) resizing, with persistence and
 * double-click reset. Used for the IDE sidebar, right panel, and terminal.
 */
export function ResizablePanel({
  children,
  defaultWidth = 300,
  minWidth = 200,
  maxWidthPercent = 80,
  defaultHeight = 240,
  minHeight = 100,
  maxHeightPercent = 80,
  storageKey,
  position = 'right',
  axis = 'horizontal',
  className = '',
  onResize,
}: ResizablePanelProps) {
  const isVertical = axis === 'vertical';
  const defaultSize = isVertical ? defaultHeight : defaultWidth;
  const minSize = isVertical ? minHeight : minWidth;
  const maxPercent = isVertical ? maxHeightPercent : maxWidthPercent;

  const getMaxSize = (): number =>
    (isVertical ? window.innerHeight : window.innerWidth) * (maxPercent / 100);

  const getInitialSize = (): number => {
    if (storageKey) {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const parsed = parseInt(stored, 10);
        if (!isNaN(parsed)) return Math.max(minSize, Math.min(parsed, getMaxSize()));
      }
    }
    return defaultSize;
  };

  const [size, setSize] = useState<number>(getInitialSize);
  const [isResizing, setIsResizing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const startPosRef = useRef<number>(0);
  const startSizeRef = useRef<number>(0);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    startPosRef.current = isVertical ? e.clientY : e.clientX;
    startSizeRef.current = size;
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = isVertical ? 'row-resize' : 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (!isResizing && startPosRef.current === 0) return;
    const current = isVertical ? e.clientY : e.clientX;
    // For top/left handles, dragging toward origin grows the panel.
    const grows = position === 'right' || position === 'bottom';
    const delta = grows ? current - startPosRef.current : startPosRef.current - current;
    const next = Math.max(minSize, Math.min(startSizeRef.current + delta, getMaxSize()));
    setSize(next);
    onResize?.(next);
  };

  const handleMouseUp = () => {
    setIsResizing(false);
    startPosRef.current = 0;
    startSizeRef.current = 0;
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    if (storageKey) localStorage.setItem(storageKey, String(size));
  };

  const handleDoubleClick = () => {
    setSize(defaultSize);
    if (storageKey) localStorage.setItem(storageKey, String(defaultSize));
    onResize?.(defaultSize);
  };

  useEffect(() => {
    const onWin = () => {
      const max = getMaxSize();
      if (size > max) { setSize(max); onResize?.(max); }
    };
    window.addEventListener('resize', onWin);
    return () => window.removeEventListener('resize', onWin);
  }, [size]);

  useEffect(() => () => {
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  const handleClass = isVertical
    ? `absolute left-0 ${position === 'top' ? 'top-0' : 'bottom-0'} w-full h-1 cursor-row-resize`
    : `absolute top-0 ${position === 'left' ? 'left-0' : 'right-0'} h-full w-1 cursor-col-resize`;

  return (
    <div
      ref={panelRef}
      className={`relative ${className}`}
      style={isVertical ? { height: `${size}px` } : { width: `${size}px` }}
    >
      {children}
      <div
        className={`${handleClass} z-10 hover:bg-primary/40 transition-colors`}
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClick}
        title="Drag to resize, double-click to reset"
      />
    </div>
  );
}
