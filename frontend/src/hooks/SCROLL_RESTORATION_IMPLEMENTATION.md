# Scroll Position Restoration Implementation

## Overview

This document describes the implementation of scroll position restoration for the Bubbly chat interface, fulfilling Requirements 4.2 and 4.6 from the stability and UI improvements specification.

## Requirements Addressed

### Requirement 4.2: Restore scroll position on tab return
**Status:** ✅ Implemented

When a user switches browser tabs and returns to Bubbly, the frontend restores the exact scroll position in the chat.

### Requirement 4.6: Save scroll position before page unload
**Status:** ✅ Implemented

The scroll position is saved before the page unloads, allowing restoration when the user returns.

## Implementation Details

### Hook: `useScrollRestoration`

**Location:** `frontend/src/hooks/useScrollRestoration.ts`

**Features:**
1. **Scroll Position Persistence**: Uses `sessionStorage` to save scroll position
2. **Automatic Restoration**: Restores scroll position on component mount
3. **Debounced Saving**: Debounces scroll events (100ms) to avoid excessive storage writes
4. **User Scroll Detection**: Tracks whether user has scrolled up from bottom
5. **Smart Auto-Scroll**: Only auto-scrolls to bottom if user is at bottom
6. **Before Unload Handler**: Saves scroll position before page unload
7. **Cleanup**: Properly removes event listeners and clears timeouts on unmount

**API:**
```typescript
const { scrollRef, scrollToBottom, isUserScrolling } = useScrollRestoration(key, enabled);

// scrollRef: Ref to attach to scrollable element
// scrollToBottom: Function to scroll to bottom (with optional force parameter)
// isUserScrolling: Boolean indicating if user has scrolled up
```

**Parameters:**
- `key`: Unique identifier for the scroll position in sessionStorage
- `enabled`: Boolean to enable/disable scroll restoration (default: true)

## Integration: Multiple Components

The `useScrollRestoration` hook has been integrated into multiple scrollable components:

### 1. MessageList Component (Primary)

**Location:** `frontend/src/components/Chat/MessageList.tsx`

The `MessageList` component uses the `useScrollRestoration` hook to:
1. Restore scroll position when the component mounts
2. Auto-scroll to bottom when new messages arrive (unless user scrolled up)
3. Save scroll position continuously as user scrolls
4. Save scroll position before page unload

**Usage:**
```typescript
const { scrollRef, scrollToBottom } = useScrollRestoration('chat-messages', true);

useEffect(() => {
  // Auto-scroll to bottom when new messages arrive (if user hasn't scrolled up)
  scrollToBottom();
}, [messages, scrollToBottom]);

return (
  <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
    {/* Message content */}
  </div>
);
```

### 2. ThreadPanel Component

**Location:** `frontend/src/components/ThreadPanel/ThreadPanel.tsx`

Maintains scroll position when browsing through conversation history.

**Usage:**
```typescript
const { scrollRef } = useScrollRestoration('thread-list', true);

return (
  <div ref={scrollRef} className="flex-1 overflow-y-auto">
    {/* Thread list */}
  </div>
);
```

### 3. FileExplorer Component

**Location:** `frontend/src/components/FileExplorer/FileExplorer.tsx`

Preserves scroll position when navigating through the file tree.

**Usage:**
```typescript
const { scrollRef } = useScrollRestoration('file-explorer', true);

return (
  <div ref={scrollRef} className="flex-1 overflow-y-auto py-1">
    {/* File tree */}
  </div>
);
```

### 4. SpecPanel Component

**Location:** `frontend/src/components/SpecPanel/SpecPanel.tsx`

Maintains scroll position when viewing the list of specifications.

**Usage:**
```typescript
const { scrollRef } = useScrollRestoration('spec-panel', true);

return (
  <div ref={scrollRef} className="flex-1 overflow-y-auto p-3">
    {/* Spec list */}
  </div>
);
```

## Storage Strategy

### sessionStorage vs localStorage

The implementation uses `sessionStorage` instead of `localStorage` for scroll position:

**Rationale:**
- **Tab-specific**: Each browser tab maintains its own scroll position
- **Temporary**: Scroll position is cleared when tab is closed (intentional for chat UX)
- **Privacy**: Doesn't persist scroll position across browser sessions
- **Performance**: Faster than localStorage for frequent updates

**Storage Key Format:**
```
scroll-position-{key}
```

Example: `scroll-position-chat-messages`

## User Experience

### Scenario 1: Tab Switching
1. User scrolls to a specific position in chat
2. User switches to another browser tab
3. User returns to Bubbly tab
4. **Result:** Scroll position is exactly where they left it

### Scenario 2: New Messages
1. User is at bottom of chat (reading latest messages)
2. New message arrives
3. **Result:** Chat auto-scrolls to show new message

### Scenario 3: Reading History
1. User scrolls up to read old messages
2. New message arrives
3. **Result:** Chat does NOT auto-scroll (user stays at their position)

### Scenario 4: Force Scroll
1. User has scrolled up
2. User wants to jump to latest message
3. User can call `scrollToBottom(true)` to force scroll
4. **Result:** Chat scrolls to bottom regardless of user scroll state

## Testing

### Manual Testing Checklist

- [x] Scroll position is restored when switching tabs
- [x] Scroll position is saved before page unload
- [x] Auto-scroll works when user is at bottom
- [x] Auto-scroll is disabled when user scrolls up
- [x] Scroll events are debounced (no performance issues)
- [x] Multiple scroll restoration instances work independently
- [x] Event listeners are cleaned up on unmount

### Automated Testing

A comprehensive test suite has been created at:
`frontend/src/hooks/useScrollRestoration.test.ts`

**Test Coverage:**
- Scroll position restoration on mount
- Scroll position saving on scroll events
- Debouncing of scroll events
- User scroll detection (at bottom vs scrolled up)
- Auto-scroll behavior
- Force scroll functionality
- Before unload handler
- Event listener cleanup
- Multiple instances with different keys

**Note:** The frontend currently doesn't have a test runner configured. To run tests:
1. Install testing dependencies (Jest, React Testing Library)
2. Configure Jest for React/TypeScript
3. Run: `npm test -- useScrollRestoration.test.ts`

## Performance Considerations

### Debouncing
Scroll events are debounced with a 100ms delay to:
- Reduce sessionStorage write frequency
- Improve performance during rapid scrolling
- Prevent UI jank

### Storage Size
Each scroll position is stored as a simple integer string:
- Minimal storage footprint
- Fast serialization/deserialization
- No JSON parsing overhead

### Memory Management
- Timeouts are properly cleared on unmount
- Event listeners are removed on unmount
- No memory leaks

## Future Enhancements

### Potential Improvements
1. **Smooth Scroll Animation**: Add smooth scrolling when restoring position
2. **Scroll Position Indicator**: Show visual indicator when user is not at bottom
3. **Jump to Bottom Button**: Add floating button to quickly scroll to bottom (especially useful in chat)
4. **Scroll Position History**: Track scroll position history for undo/redo
5. **Accessibility**: Add keyboard shortcuts for scroll navigation
6. **Virtual Scrolling**: For very long lists, implement virtual scrolling for better performance

## Related Files

- `frontend/src/hooks/useScrollRestoration.ts` - Hook implementation
- `frontend/src/hooks/useScrollRestoration.test.ts` - Test suite
- `frontend/src/components/Chat/MessageList.tsx` - Chat integration
- `frontend/src/components/ThreadPanel/ThreadPanel.tsx` - Thread list integration
- `frontend/src/components/FileExplorer/FileExplorer.tsx` - File explorer integration
- `frontend/src/components/SpecPanel/SpecPanel.tsx` - Spec panel integration
- `frontend/src/hooks/useTabVisibility.ts` - Related tab visibility detection

## References

- **Requirement 4.2**: UI State Persistence - Scroll position restoration
- **Requirement 4.6**: UI State Persistence - Save before page unload
- **Task 5.15**: Implement scroll position restoration
