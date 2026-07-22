import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ResizablePanel } from './ResizablePanel';

describe('ResizablePanel', () => {
  beforeEach(() => {
    // Clear localStorage before each test
    localStorage.clear();
    
    // Mock window.innerWidth
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: 1920,
    });
  });

  afterEach(() => {
    // Clean up any lingering event listeners
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  it('renders children correctly', () => {
    render(
      <ResizablePanel>
        <div>Test Content</div>
      </ResizablePanel>
    );

    expect(screen.getByText('Test Content')).toBeInTheDocument();
  });

  it('applies default width', () => {
    const { container } = render(
      <ResizablePanel defaultWidth={400}>
        <div>Content</div>
      </ResizablePanel>
    );

    const panel = container.firstChild as HTMLElement;
    expect(panel.style.width).toBe('400px');
  });

  it('enforces minimum width constraint', () => {
    const { container } = render(
      <ResizablePanel defaultWidth={100} minWidth={200}>
        <div>Content</div>
      </ResizablePanel>
    );

    const panel = container.firstChild as HTMLElement;
    // Should be clamped to minWidth
    expect(parseInt(panel.style.width)).toBeGreaterThanOrEqual(200);
  });

  it('enforces maximum width constraint based on viewport', () => {
    const { container } = render(
      <ResizablePanel defaultWidth={2000} maxWidthPercent={80}>
        <div>Content</div>
      </ResizablePanel>
    );

    const panel = container.firstChild as HTMLElement;
    const maxWidth = window.innerWidth * 0.8;
    expect(parseInt(panel.style.width)).toBeLessThanOrEqual(maxWidth);
  });

  it('persists width to localStorage when storageKey is provided', () => {
    const storageKey = 'test-panel-width';
    const { container } = render(
      <ResizablePanel defaultWidth={350} storageKey={storageKey}>
        <div>Content</div>
      </ResizablePanel>
    );

    const resizeHandle = container.querySelector('.cursor-col-resize') as HTMLElement;
    
    // Simulate drag
    fireEvent.mouseDown(resizeHandle, { clientX: 0 });
    fireEvent.mouseMove(document, { clientX: 50 });
    fireEvent.mouseUp(document);

    // Check localStorage
    const stored = localStorage.getItem(storageKey);
    expect(stored).toBeTruthy();
    expect(parseInt(stored!)).toBeGreaterThan(350);
  });

  it('loads width from localStorage on mount', () => {
    const storageKey = 'test-panel-width';
    localStorage.setItem(storageKey, '500');

    const { container } = render(
      <ResizablePanel defaultWidth={300} storageKey={storageKey}>
        <div>Content</div>
      </ResizablePanel>
    );

    const panel = container.firstChild as HTMLElement;
    expect(panel.style.width).toBe('500px');
  });

  it('resets to default width on double-click', () => {
    const { container } = render(
      <ResizablePanel defaultWidth={300}>
        <div>Content</div>
      </ResizablePanel>
    );

    const panel = container.firstChild as HTMLElement;
    const resizeHandle = container.querySelector('.cursor-col-resize') as HTMLElement;

    // First, resize the panel
    fireEvent.mouseDown(resizeHandle, { clientX: 0 });
    fireEvent.mouseMove(document, { clientX: 100 });
    fireEvent.mouseUp(document);

    // Verify it changed
    expect(panel.style.width).not.toBe('300px');

    // Double-click to reset
    fireEvent.doubleClick(resizeHandle);

    // Should be back to default
    expect(panel.style.width).toBe('300px');
  });

  it('calls onResize callback when width changes', () => {
    const onResize = vi.fn();
    const { container } = render(
      <ResizablePanel defaultWidth={300} onResize={onResize}>
        <div>Content</div>
      </ResizablePanel>
    );

    const resizeHandle = container.querySelector('.cursor-col-resize') as HTMLElement;

    // Simulate drag
    fireEvent.mouseDown(resizeHandle, { clientX: 0 });
    fireEvent.mouseMove(document, { clientX: 50 });
    fireEvent.mouseUp(document);

    // onResize should have been called during drag
    expect(onResize).toHaveBeenCalled();
    expect(onResize).toHaveBeenCalledWith(expect.any(Number));
  });

  it('changes cursor during resize', () => {
    const { container } = render(
      <ResizablePanel defaultWidth={300}>
        <div>Content</div>
      </ResizablePanel>
    );

    const resizeHandle = container.querySelector('.cursor-col-resize') as HTMLElement;

    // Start resize
    fireEvent.mouseDown(resizeHandle, { clientX: 0 });
    expect(document.body.style.cursor).toBe('col-resize');

    // End resize
    fireEvent.mouseUp(document);
    expect(document.body.style.cursor).toBe('');
  });

  it('applies custom className', () => {
    const { container } = render(
      <ResizablePanel className="custom-class">
        <div>Content</div>
      </ResizablePanel>
    );

    const panel = container.firstChild as HTMLElement;
    expect(panel.className).toContain('custom-class');
  });

  it('supports left position for resize handle', () => {
    const { container } = render(
      <ResizablePanel position="left">
        <div>Content</div>
      </ResizablePanel>
    );

    const resizeHandle = container.querySelector('.left-0') as HTMLElement;
    expect(resizeHandle).toBeInTheDocument();
  });

  it('supports right position for resize handle (default)', () => {
    const { container } = render(
      <ResizablePanel>
        <div>Content</div>
      </ResizablePanel>
    );

    const resizeHandle = container.querySelector('.right-0') as HTMLElement;
    expect(resizeHandle).toBeInTheDocument();
  });

  it('handles window resize to enforce max width', () => {
    const { container } = render(
      <ResizablePanel defaultWidth={1000} maxWidthPercent={80}>
        <div>Content</div>
      </ResizablePanel>
    );

    const panel = container.firstChild as HTMLElement;
    
    // Shrink window
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: 1000,
    });
    
    fireEvent(window, new Event('resize'));

    // Panel should be constrained to new max width
    const maxWidth = 1000 * 0.8;
    expect(parseInt(panel.style.width)).toBeLessThanOrEqual(maxWidth);
  });

  it('prevents text selection during resize', () => {
    const { container } = render(
      <ResizablePanel defaultWidth={300}>
        <div>Content</div>
      </ResizablePanel>
    );

    const resizeHandle = container.querySelector('.cursor-col-resize') as HTMLElement;

    // Start resize
    fireEvent.mouseDown(resizeHandle, { clientX: 0 });
    expect(document.body.style.userSelect).toBe('none');

    // End resize
    fireEvent.mouseUp(document);
    expect(document.body.style.userSelect).toBe('');
  });

  it('cleans up event listeners on unmount', () => {
    const { container, unmount } = render(
      <ResizablePanel defaultWidth={300}>
        <div>Content</div>
      </ResizablePanel>
    );

    const resizeHandle = container.querySelector('.cursor-col-resize') as HTMLElement;

    // Start resize
    fireEvent.mouseDown(resizeHandle, { clientX: 0 });

    // Unmount while resizing
    unmount();

    // Body styles should be cleaned up
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
  });

  it('handles invalid localStorage values gracefully', () => {
    const storageKey = 'test-panel-width';
    localStorage.setItem(storageKey, 'invalid-number');

    const { container } = render(
      <ResizablePanel defaultWidth={300} storageKey={storageKey}>
        <div>Content</div>
      </ResizablePanel>
    );

    const panel = container.firstChild as HTMLElement;
    // Should fall back to default width
    expect(panel.style.width).toBe('300px');
  });

  it('applies resizing class during drag', () => {
    const { container } = render(
      <ResizablePanel defaultWidth={300}>
        <div>Content</div>
      </ResizablePanel>
    );

    const panel = container.firstChild as HTMLElement;
    const resizeHandle = container.querySelector('.cursor-col-resize') as HTMLElement;

    // Before resize
    expect(panel.className).toContain('panel');
    expect(panel.className).not.toContain('resizing');

    // During resize
    fireEvent.mouseDown(resizeHandle, { clientX: 0 });
    expect(panel.className).toContain('resizing');

    // After resize
    fireEvent.mouseUp(document);
    expect(panel.className).toContain('panel');
    expect(panel.className).not.toContain('resizing');
  });
});
