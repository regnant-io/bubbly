# Tab Visibility Detection Implementation

## Overview

This document describes the implementation of tab visibility detection in Bubbly, which pauses non-critical updates when the browser tab is not visible to improve performance and reduce resource usage.

## Implementation Details

### Hook: `useTabVisibility`

**Location**: `frontend/src/hooks/useTabVisibility.ts`

The `useTabVisibility` hook provides a simple way to detect when the browser tab is visible or hidden.

**Features**:
- Returns a boolean indicating whether the tab is currently visible
- Listens to the `visibilitychange` event on the document
- Adds/removes the `tab-hidden` class to the document body for CSS-based optimizations
- Automatically cleans up event listeners on unmount

**Usage**:
```typescript
import { useTabVisibility } from './hooks/useTabVisibility';

function MyComponent() {
  const isTabVisible = useTabVisibility();
  
  useEffect(() => {
    if (isTabVisible) {
      // Perform updates only when tab is visible
      updateUI();
    }
  }, [isTabVisible, data]);
}
```

### Integration Points

#### 1. MessageList Component

**Location**: `frontend/src/components/Chat/MessageList.tsx`

The `MessageList` component uses `useTabVisibility` to control auto-scrolling behavior:

```typescript
const isTabVisible = useTabVisibility();

useEffect(() => {
  // Only auto-scroll when tab is visible to avoid unnecessary work
  if (isTabVisible) {
    scrollToBottom();
  }
}, [messages, scrollToBottom, isTabVisible]);
```

**Benefits**:
- Prevents unnecessary scroll calculations when tab is hidden
- Reduces CPU usage when user is not viewing the tab
- Scroll position is updated when user returns to the tab

#### 2. CSS Animations

**Location**: `frontend/src/styles/animations.css`

CSS rules pause all animations when the tab is hidden:

```css
/* Pause animations when tab is hidden to save resources */
body.tab-hidden * {
  animation-play-state: paused !important;
}
```

**Benefits**:
- Stops all CSS animations when tab is hidden
- Reduces GPU usage and battery consumption
- Animations resume automatically when tab becomes visible

## Requirements Satisfied

This implementation satisfies the following requirements from the spec:

- **Requirement 4.1**: THE Frontend SHALL preserve all chat messages in memory (messages are still received and stored)
- **Requirement 4.7**: THE Frontend SHALL detect tab visibility changes and pause non-critical updates when hidden

## Performance Benefits

1. **Reduced CPU Usage**: Auto-scrolling and DOM updates are skipped when tab is hidden
2. **Reduced GPU Usage**: CSS animations are paused when tab is hidden
3. **Battery Savings**: Less work means better battery life on mobile devices
4. **No Data Loss**: WebSocket events are still received and processed, ensuring no messages are lost

## Testing

### Manual Testing

1. Open Bubbly in a browser tab
2. Start a conversation with the agent
3. Switch to another tab while the agent is responding
4. Verify that animations are paused (check DevTools Performance tab)
5. Switch back to the Bubbly tab
6. Verify that all messages are present and animations resume

### Automated Testing

A test suite is provided in `useTabVisibility.test.ts` that verifies:
- Hook returns correct visibility state
- Body class is added/removed correctly
- Hook responds to visibility change events
- Event listeners are cleaned up on unmount

## Future Enhancements

Potential improvements for future iterations:

1. **Buffered Updates**: Batch multiple updates when tab is hidden and apply them all at once when tab becomes visible
2. **Throttled Rendering**: Reduce render frequency when tab is hidden but still update periodically
3. **Visibility Metrics**: Track how much time users spend with the tab visible vs hidden for analytics
4. **Smart Notifications**: Show browser notifications for important events when tab is hidden

## Browser Compatibility

The Page Visibility API is supported in all modern browsers:
- Chrome 33+
- Firefox 18+
- Safari 7+
- Edge 12+

The implementation gracefully degrades in older browsers by always returning `true` (tab visible).
