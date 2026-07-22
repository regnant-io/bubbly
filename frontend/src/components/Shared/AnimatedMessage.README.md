# AnimatedMessage Component

## Overview

The `AnimatedMessage` component provides a smooth slide-in animation for message content in the Bubbly chat interface. It wraps any React children with a GPU-accelerated animation that slides content up from below while fading in.

## Features

- **Smooth Animation**: Uses the `slideInUp` keyframe animation (300ms duration)
- **GPU-Accelerated**: Leverages `translate3d` for optimal performance
- **Configurable Delay**: Support for staggered animations when rendering multiple messages
- **Accessibility**: Respects `prefers-reduced-motion` user preference
- **Flexible**: Accepts any React children and custom className

## Usage

### Basic Usage

```tsx
import { AnimatedMessage } from './components/Shared/AnimatedMessage';

function ChatMessage({ content }) {
  return (
    <AnimatedMessage>
      <div className="message-content">
        {content}
      </div>
    </AnimatedMessage>
  );
}
```

### With Delay (Staggered Animation)

```tsx
function MessageList({ messages }) {
  return (
    <div>
      {messages.map((message, index) => (
        <AnimatedMessage key={message.id} delay={index * 50}>
          <div className="message">{message.content}</div>
        </AnimatedMessage>
      ))}
    </div>
  );
}
```

### With Custom Styling

```tsx
<AnimatedMessage className="shadow-lg rounded-xl">
  <div className="p-4 bg-surface-2">
    Custom styled message
  </div>
</AnimatedMessage>
```

## Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `children` | `ReactNode` | required | The content to animate |
| `delay` | `number` | `0` | Delay in milliseconds before animation starts |
| `className` | `string` | `''` | Additional CSS classes to apply |

## Animation Details

The component uses the `slideInUp` animation defined in `styles/animations.css`:

```css
@keyframes slideInUp {
  from {
    opacity: 0;
    transform: translate3d(0, 20px, 0);
  }
  to {
    opacity: 1;
    transform: translate3d(0, 0, 0);
  }
}
```

- **Duration**: 300ms
- **Easing**: `cubic-bezier(0.4, 0, 0.2, 1)` (smooth ease-in-out)
- **Transform**: Slides up 20px while fading in
- **GPU Acceleration**: Uses `translate3d` for hardware acceleration

## Accessibility

The animation automatically respects the user's motion preferences:

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

Users who have enabled "reduce motion" in their system settings will see instant appearance instead of animated transitions.

## Performance Considerations

1. **GPU Acceleration**: The component uses `translate3d` instead of `translateY` to leverage GPU acceleration, ensuring smooth 60fps animations even with many messages.

2. **Minimal Reflows**: The animation only affects `opacity` and `transform`, which don't trigger layout reflows.

3. **Staggered Rendering**: When rendering many messages at once, use the `delay` prop to stagger animations and avoid overwhelming the browser.

## Integration with MessageList

The AnimatedMessage component is designed to be used in the `MessageList` component to animate chat messages as they appear:

```tsx
// In MessageList.tsx
import { AnimatedMessage } from '../Shared/AnimatedMessage';

function MessageList({ messages }) {
  return (
    <div className="message-list">
      {messages.map((message, index) => (
        <AnimatedMessage key={message.id} delay={index * 75}>
          {renderMessage(message)}
        </AnimatedMessage>
      ))}
    </div>
  );
}
```

## Related Components

- **BubbleLoader**: Animated loading indicator for agent activity
- **ApprovalCard**: Uses `scaleIn` animation for approval blocks
- **ToolBubble**: Tool execution indicators

## Requirements Satisfied

This component satisfies the following requirements from the design document:

- **Requirement 16.1**: Animate message appearance with fade-in and slide-up effect (300ms)
- **Requirement 16.5**: Use GPU-accelerated transforms (translate3d, scale)
- **Requirement 16.6**: Reduce animations when user has "prefers-reduced-motion" enabled

## Testing

Unit tests are provided in `AnimatedMessage.test.tsx`. To run tests:

1. Install test dependencies:
   ```bash
   npm install -D vitest @testing-library/react @testing-library/jest-dom jsdom
   ```

2. Add test script to `package.json`:
   ```json
   {
     "scripts": {
       "test": "vitest"
     }
   }
   ```

3. Run tests:
   ```bash
   npm test
   ```

## Examples

See `AnimatedMessage.example.tsx` for comprehensive usage examples including:
- Basic usage
- Delayed/staggered animations
- Chat message integration
- Custom styling
- MessageList integration
