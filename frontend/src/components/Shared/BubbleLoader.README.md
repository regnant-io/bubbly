# BubbleLoader Component

## Overview

The `BubbleLoader` component displays an animated loading indicator with three bubbles that pulse in sequence. It uses Solarized theme accent colors (brown, orange, yellow) for visual appeal and provides a smooth, professional loading experience.

## Requirements Satisfied

This component satisfies the following requirements from the design document:

- **20.1**: Display animated bubble loader when agent is waiting for model response
- **20.2**: Use three bubbles that scale up and down in sequence
- **20.3**: Color bubbles using Solarized theme accent colors
- **20.4**: Display configurable text below the bubble loader
- **20.5**: Show bubble loader in chat area where next message will appear
- **20.6**: Transition from bubble loader to message content smoothly (via fade-enter class)
- **20.7**: Loop bubble animation continuously until response arrives

## Props

```typescript
interface BubbleLoaderProps {
  text?: string;           // Text to display below bubbles (default: "Thinking...")
  size?: 'small' | 'medium' | 'large';  // Size of the bubbles (default: 'medium')
}
```

## Usage

### Basic Usage

```tsx
import { BubbleLoader } from './components/Shared/BubbleLoader';

function MyComponent() {
  return <BubbleLoader />;
}
```

### Custom Text

```tsx
<BubbleLoader text="Preparing action..." />
```

### Different Sizes

```tsx
<BubbleLoader size="small" text="Loading..." />
<BubbleLoader size="medium" text="Processing..." />
<BubbleLoader size="large" text="Analyzing..." />
```

### No Text

```tsx
<BubbleLoader text="" />
```

### Conditional Rendering

```tsx
function ChatMessage() {
  const [isLoading, setIsLoading] = useState(true);
  const [response, setResponse] = useState('');

  return (
    <div>
      {isLoading ? (
        <BubbleLoader text="Generating response..." />
      ) : (
        <div className="message fade-enter">{response}</div>
      )}
    </div>
  );
}
```

## Animation Details

### Bubble Pulse Animation

The bubbles use the `bubblePulse` keyframe animation defined in `animations.css`:

- **Duration**: 1.5 seconds
- **Timing**: ease-in-out
- **Loop**: infinite
- **Effect**: Scale from 1 to 1.2 and opacity from 0.6 to 1

### Staggered Delays

Each bubble has a staggered animation delay:
- Bubble 1: 0s (brown/yellow #b58900)
- Bubble 2: 0.2s (orange #cb4b16)
- Bubble 3: 0.4s (yellow #b58900)

This creates a wave-like effect across the three bubbles.

### Fade-In Transition

The component uses the `fade-enter` class for smooth appearance:
- **Duration**: 200ms
- **Effect**: Fade from opacity 0 to 1

## Styling

The component uses:
- **Tailwind CSS** for layout and spacing
- **CSS custom properties** from `theme.css` for colors
- **Keyframe animations** from `animations.css` for bubble pulse

### Size Classes

| Size   | Bubble Size | Gap   | Text Size |
|--------|-------------|-------|-----------|
| small  | w-2 h-2     | gap-1 | text-xs   |
| medium | w-3 h-3     | gap-2 | text-sm   |
| large  | w-4 h-4     | gap-3 | text-base |

## Accessibility

The component respects the `prefers-reduced-motion` media query. When users have reduced motion enabled, animations are minimized to 0.01ms duration (defined in `animations.css`).

## Integration Points

### Chat Panel

Use in `ChatPanel.tsx` to show loading state while waiting for AI response:

```tsx
{isWaitingForResponse && (
  <BubbleLoader text="Thinking..." />
)}
```

### Approval Blocks

Use before approval blocks appear to indicate preparation:

```tsx
{preparingApproval ? (
  <BubbleLoader text="Preparing action..." />
) : (
  <ApprovalCard {...approvalProps} />
)}
```

### Tool Execution

Use to indicate tool execution in progress:

```tsx
{executingTool && (
  <BubbleLoader text={`Executing ${toolName}...`} size="small" />
)}
```

## Related Components

- **ToolBubble**: Displays tool execution status with icons
- **ApprovalCard**: Shows approval requests for sensitive operations
- **MessageList**: Container for chat messages where BubbleLoader appears

## Files

- `BubbleLoader.tsx` - Main component implementation
- `BubbleLoader.example.tsx` - Usage examples
- `BubbleLoader.README.md` - This documentation
- `../../styles/animations.css` - Animation definitions
- `../../styles/theme.css` - Color definitions

## Future Enhancements

Potential improvements for future iterations:

1. **Custom Colors**: Allow passing custom colors for bubbles
2. **Animation Speed**: Configurable animation duration
3. **Bubble Count**: Support for different numbers of bubbles
4. **Progress Indicator**: Show percentage or time elapsed
5. **Custom Icons**: Replace bubbles with custom icons or shapes
