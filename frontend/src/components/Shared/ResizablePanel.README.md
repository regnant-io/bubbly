# ResizablePanel Component

## Overview

The `ResizablePanel` component provides a flexible, user-resizable panel with draggable handles, width constraints, and persistent sizing. It's designed to give users control over their workspace layout while maintaining a polished, professional experience.

## Features

- **Draggable Resize Handles**: Smooth, real-time resizing with visual feedback
- **Width Constraints**: Enforces minimum (200px default) and maximum (80% viewport default) widths
- **Persistence**: Saves panel sizes to localStorage for consistent experience across sessions
- **Reset Functionality**: Double-click resize handle to restore default width
- **Visual Indicators**: Cursor changes and hover effects for clear interaction cues
- **Responsive**: Automatically adjusts to window resizing
- **Flexible Positioning**: Supports left or right-positioned resize handles
- **Smooth Animations**: Uses CSS transitions for polished interactions

## Requirements Satisfied

- **17.1**: Display draggable resize handles between adjacent panels
- **17.2**: Update panel widths in real-time during drag
- **17.3**: Enforce minimum panel width of 200px
- **17.4**: Enforce maximum panel width of 80% of viewport width
- **17.5**: Persist panel sizes to localStorage
- **17.6**: Reset panels to default sizes on double-click
- **17.7**: Show visual indicator (cursor change) when hovering over resize handles
- **17.8**: Prevent panel resizing during active drag operations in other panels

## Usage

### Basic Example

```tsx
import { ResizablePanel } from './components/Shared';

function MyLayout() {
  return (
    <div className="flex">
      <ResizablePanel defaultWidth={300} storageKey="sidebar-width">
        <div>Sidebar Content</div>
      </ResizablePanel>
      
      <div className="flex-1">
        Main Content
      </div>
    </div>
  );
}
```

### With Custom Constraints

```tsx
<ResizablePanel
  defaultWidth={400}
  minWidth={250}
  maxWidthPercent={60}
  storageKey="file-explorer-width"
  position="left"
>
  <FileExplorer />
</ResizablePanel>
```

### With Resize Callback

```tsx
<ResizablePanel
  defaultWidth={300}
  onResize={(width) => {
    console.log('Panel resized to:', width);
    // Update other UI elements based on new width
  }}
>
  <ChatPanel />
</ResizablePanel>
```

## Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `children` | `ReactNode` | Required | Content to render inside the panel |
| `defaultWidth` | `number` | `300` | Default width in pixels |
| `minWidth` | `number` | `200` | Minimum width in pixels |
| `maxWidthPercent` | `number` | `80` | Maximum width as percentage of viewport (0-100) |
| `storageKey` | `string` | `undefined` | localStorage key for persisting width |
| `position` | `'left' \| 'right'` | `'right'` | Position of the resize handle |
| `className` | `string` | `''` | Additional CSS classes |
| `onResize` | `(width: number) => void` | `undefined` | Callback fired when width changes |

## Behavior

### Resizing

1. **Mouse Down**: Click and hold on the resize handle to start resizing
2. **Mouse Move**: Drag left or right to adjust panel width
3. **Mouse Up**: Release to finalize the new width
4. **Constraints**: Width is automatically clamped to min/max values during drag

### Reset

- **Double-click** the resize handle to instantly reset to `defaultWidth`
- Useful for quickly returning to a known good layout

### Persistence

When `storageKey` is provided:
- Width is saved to localStorage on mouse up
- Width is loaded from localStorage on component mount
- Invalid stored values fall back to `defaultWidth`

### Window Resize

- Component listens for window resize events
- Automatically constrains width if window shrinks below current panel width
- Ensures panel never exceeds `maxWidthPercent` of viewport

## Styling

The component uses Tailwind CSS classes and integrates with the existing animation system:

- **Resize Handle**: 1px wide, expands to 1.5px on hover with accent color
- **Cursor**: Changes to `col-resize` during drag
- **Transitions**: Smooth 150ms transitions when not actively resizing
- **Classes**: Applies `panel` class normally, `resizing` class during drag

### Custom Styling

```tsx
<ResizablePanel className="bg-surface-1 border-l border-border">
  {/* Your content */}
</ResizablePanel>
```

## Accessibility

- **Visual Feedback**: Clear cursor changes and hover states
- **Title Attribute**: Resize handle has descriptive title text
- **Keyboard**: Currently mouse-only (keyboard support could be added in future)

## Performance

- **GPU Acceleration**: Uses CSS transforms for smooth animations
- **Event Cleanup**: Properly removes event listeners on unmount
- **Debouncing**: Consider adding debouncing to `onResize` callback if it triggers expensive operations

## Integration with BubbleRoom

The ResizablePanel is designed to wrap existing panels in the BubbleRoom layout:

```tsx
// Before
<div className="w-56 border-r border-border">
  <FileExplorer />
</div>

// After
<ResizablePanel 
  defaultWidth={224} 
  storageKey="file-explorer-width"
  position="right"
>
  <FileExplorer />
</ResizablePanel>
```

## Testing

Comprehensive test suite covers:
- ✅ Rendering and children
- ✅ Default width application
- ✅ Min/max width constraints
- ✅ localStorage persistence
- ✅ Double-click reset
- ✅ Resize callbacks
- ✅ Cursor changes
- ✅ Window resize handling
- ✅ Event listener cleanup
- ✅ Invalid localStorage values
- ✅ CSS class application

Run tests with:
```bash
npm test ResizablePanel.test.tsx
```

## Future Enhancements

Potential improvements for future iterations:

1. **Keyboard Support**: Arrow keys to resize, Enter to reset
2. **Touch Support**: Mobile/tablet drag gestures
3. **Snap Points**: Predefined widths that panel "snaps" to
4. **Collapse/Expand**: Button to fully collapse panel to icon bar
5. **Resize Debouncing**: Built-in debouncing for `onResize` callback
6. **Vertical Resizing**: Support for height-based resizing
7. **Multi-Panel Coordination**: Linked resizing of multiple panels

## Browser Support

- ✅ Chrome/Edge (latest)
- ✅ Firefox (latest)
- ✅ Safari (latest)
- ⚠️ IE11 (not tested, likely needs polyfills)

## Related Components

- **BubbleRoom**: Main layout container
- **Sidebar**: Left navigation panel
- **RightPanel**: Right-side panel for diffs/specs
- **FileExplorer**: File tree panel
- **ChatPanel**: Main chat interface

## License

Part of the Bubbly project. See project LICENSE for details.
