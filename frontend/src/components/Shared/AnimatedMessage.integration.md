# AnimatedMessage Integration Guide

## Overview

This guide shows how to integrate the `AnimatedMessage` component into the existing `MessageList` component to add smooth slide-in animations for chat messages.

## Current State

The `MessageList` component currently uses a simple `animate-fade-in` class for messages. This provides a basic fade-in effect but doesn't include the slide-up motion specified in the design requirements.

## Integration Steps

### Step 1: Import AnimatedMessage

Add the import at the top of `MessageList.tsx`:

```tsx
import { AnimatedMessage } from '../Shared/AnimatedMessage';
```

### Step 2: Wrap Message Components

Wrap each message type with `AnimatedMessage` to apply the slide-in animation:

#### User Messages

```tsx
function UserMessage({ content }: { content: string }) {
  return (
    <AnimatedMessage>
      <div className="flex justify-end mb-4">
        <div className="max-w-[80%] bg-accent/15 border border-accent/25 rounded-2xl rounded-tr-sm px-4 py-3">
          <p className="text-sm text-text whitespace-pre-wrap leading-relaxed">{content}</p>
        </div>
      </div>
    </AnimatedMessage>
  );
}
```

#### Assistant Messages

```tsx
function AssistantMessage({ content, streaming }: { content: string; streaming?: boolean }) {
  return (
    <AnimatedMessage>
      <div className="flex gap-3 mb-4">
        <div className="w-7 h-7 rounded-full bg-accent/20 border border-accent/30 flex items-center justify-center shrink-0 mt-0.5">
          <Sparkles size={13} className="text-accent-bright" />
        </div>
        <div className="flex-1 min-w-0">
          <div className={`text-sm text-text leading-relaxed ${streaming ? 'typing-cursor' : ''}`}>
            {content ? (
              <MarkdownContent content={content} />
            ) : (
              streaming ? '' : '​'
            )}
          </div>
        </div>
      </div>
    </AnimatedMessage>
  );
}
```

#### Status Messages

```tsx
function StatusMessage({ content }: { content: string }) {
  return (
    <AnimatedMessage>
      <div className="flex items-center gap-2 py-1 mb-2">
        <div className="flex gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: '0ms' }} />
          <span className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: '150ms' }} />
          <span className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: '300ms' }} />
        </div>
        <span className="text-xs text-text-dim">{content}</span>
      </div>
    </AnimatedMessage>
  );
}
```

#### Error Messages

```tsx
function ErrorMessage({ content }: { content: string }) {
  return (
    <AnimatedMessage>
      <div className="flex items-start gap-2 mb-4">
        <AlertCircle size={14} className="text-red-agent mt-0.5 shrink-0" />
        <div className="bg-red-950/20 border border-red-900/30 rounded-xl px-3 py-2 flex-1">
          <p className="text-sm text-red-agent">{content}</p>
        </div>
      </div>
    </AnimatedMessage>
  );
}
```

### Step 3: Add Staggered Animation (Optional)

For a more polished effect, you can add staggered delays when rendering multiple messages:

```tsx
export function MessageList({ messages, onApprove, onReject }: MessageListProps) {
  // ... existing code ...

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4">
      {/* ... empty state ... */}

      {visibleMessages.map((msg, index) => {
        // Calculate delay based on position (only for new messages)
        const delay = index > visibleMessages.length - 5 ? (index % 5) * 50 : 0;

        switch (msg.type) {
          case 'user':
            return (
              <AnimatedMessage key={msg.id} delay={delay}>
                <UserMessage content={msg.content} />
              </AnimatedMessage>
            );

          case 'assistant':
            return (
              <AnimatedMessage key={msg.id} delay={delay}>
                <AssistantMessage content={msg.content} streaming={msg.streaming} />
              </AnimatedMessage>
            );

          // ... other cases ...
        }
      })}

      <div ref={bottomRef} />
    </div>
  );
}
```

### Step 4: Remove Old Animation Classes

After wrapping components with `AnimatedMessage`, you can remove the old `animate-fade-in` classes from the individual message components since the animation is now handled by the wrapper.

## Alternative Approach: Minimal Changes

If you want to minimize changes to existing code, you can wrap at the render level instead of modifying each message component:

```tsx
export function MessageList({ messages, onApprove, onReject }: MessageListProps) {
  // ... existing code ...

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4">
      {/* ... empty state ... */}

      {visibleMessages.map((msg) => {
        let content;
        
        switch (msg.type) {
          case 'user':
            content = <UserMessage content={msg.content} />;
            break;
          case 'assistant':
            content = <AssistantMessage content={msg.content} streaming={msg.streaming} />;
            break;
          // ... other cases ...
        }

        // Wrap all messages with AnimatedMessage
        return content ? (
          <AnimatedMessage key={msg.id}>
            {content}
          </AnimatedMessage>
        ) : null;
      })}

      <div ref={bottomRef} />
    </div>
  );
}
```

## Benefits

1. **Smooth Animations**: Messages slide up from below while fading in (300ms)
2. **GPU Acceleration**: Uses `translate3d` for 60fps performance
3. **Accessibility**: Respects `prefers-reduced-motion` setting
4. **Consistent UX**: All messages use the same animation pattern
5. **Flexible**: Easy to add delays for staggered effects

## Testing

After integration, test the following scenarios:

1. **Single Message**: Send a message and verify it slides in smoothly
2. **Multiple Messages**: Send several messages quickly and check for smooth staggering
3. **Thread Loading**: Load an existing thread and verify all messages animate
4. **Reduced Motion**: Enable "reduce motion" in system settings and verify animations are minimal
5. **Performance**: Test with 50+ messages to ensure smooth scrolling

## Performance Considerations

- The animation only runs once when the component mounts
- GPU acceleration ensures smooth 60fps animation
- No layout reflows are triggered (only opacity and transform changes)
- Staggered delays should be kept minimal (50-100ms) to avoid long wait times

## Rollback

If you need to rollback the changes, simply remove the `AnimatedMessage` wrapper and restore the `animate-fade-in` class to the original message components.
