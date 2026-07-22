# Animation System

This document describes the animation system created for Bubbly's UI/UX improvements.

## Overview

The animation system provides GPU-accelerated animations with accessibility support (prefers-reduced-motion). All animations use CSS keyframes and are designed to be smooth and performant.

## Available Animations

### 1. Message Appearance (`slideInUp`)
- **Duration**: 300ms
- **Easing**: cubic-bezier(0.4, 0, 0.2, 1)
- **Usage**: Apply `.message-enter` class to messages
- **Effect**: Fades in and slides up from 20px below

### 2. Approval Block Appearance (`scaleIn`)
- **Duration**: 250ms
- **Easing**: cubic-bezier(0.4, 0, 0.2, 1)
- **Usage**: Apply `.approval-block-enter` class to approval blocks
- **Effect**: Fades in, slides up 10px, and scales from 0.95 to 1.0

### 3. Bubble Loader (`bubblePulse`)
- **Duration**: 1.5s loop
- **Easing**: ease-in-out
- **Usage**: Use `.bubble-loader` container with `.bubble` children
- **Effect**: Three bubbles pulse with staggered delays (0s, 0.2s, 0.4s)
- **Colors**: Solarized brown (#b58900), orange (#cb4b16), yellow (#b58900)

### 4. Skeleton Loader (`shimmer`)
- **Duration**: 2s loop
- **Easing**: linear
- **Usage**: Apply `.skeleton` class
- **Effect**: Gradient shimmer effect for loading states

### 5. File Tree Expand/Collapse
- **Duration**: 200ms
- **Easing**: cubic-bezier(0.4, 0, 0.2, 1)
- **Usage**: Apply `.file-tree-item` with `.collapsed` or `.expanded`
- **Effect**: Smooth height transition

### 6. Panel Resize
- **Duration**: 150ms
- **Easing**: cubic-bezier(0.4, 0, 0.2, 1)
- **Usage**: Apply `.panel` class, add `.resizing` during drag
- **Effect**: Smooth width transition (disabled during drag)

### 7. Tool Icon Pulse (`toolPulse`)
- **Duration**: 2s loop
- **Easing**: ease-in-out
- **Usage**: Apply `.tool-icon.active` class
- **Effect**: Subtle pulse with opacity and scale changes

### 8. Fade In/Out (`fadeIn`, `fadeOut`)
- **Duration**: 200ms
- **Easing**: ease
- **Usage**: Apply `.fade-enter` or `.fade-exit` classes
- **Effect**: Simple opacity transitions

### 9. Hover Effects
- **Duration**: 150ms
- **Easing**: cubic-bezier(0.4, 0, 0.2, 1)
- **Usage**: Apply `.button` or `.clickable` classes
- **Effect**: Lifts element 1px up with shadow on hover, returns on active

## Accessibility

The animation system respects the `prefers-reduced-motion` media query. When users have reduced motion enabled:
- All animation durations are reduced to 0.01ms
- Animation iteration counts are limited to 1
- Transition durations are reduced to 0.01ms

## GPU Acceleration

All animations use `translate3d()` instead of `translate()` to trigger GPU acceleration, ensuring smooth 60fps animations.

## Usage Examples

### Message Animation
```tsx
<div className="message-enter">
  <p>This message will slide in and fade in</p>
</div>
```

### Bubble Loader
```tsx
<div className="bubble-loader">
  <div className="bubble" />
  <div className="bubble" />
  <div className="bubble" />
</div>
```

### Skeleton Loader
```tsx
<div className="skeleton" style={{ width: '200px', height: '20px' }} />
```

### Tool Icon with Pulse
```tsx
<div className="tool-icon active">
  <FileIcon />
</div>
```

## Integration

The animation system is automatically imported in `src/index.css`:

```css
@import './styles/animations.css';
```

No additional setup is required. Simply apply the appropriate classes to your components.

## Requirements Satisfied

This animation system satisfies the following requirements from the spec:

- **Requirement 16.1**: Message appearance with fade-in and slide-up effect (300ms)
- **Requirement 16.2**: Approval blocks with scale and fade-in effect (250ms)
- **Requirement 16.3**: Panel transitions with easing functions (cubic-bezier)
- **Requirement 16.4**: File tree expand/collapse with smooth height transitions (200ms)
- **Requirement 16.5**: GPU-accelerated transforms (translate3d, scale)
- **Requirement 16.6**: Reduced animations when user has "prefers-reduced-motion" enabled
- **Requirement 16.7**: Loading states with subtle pulsing effects (1.5s loop)
- **Requirement 20.1-20.7**: Bubble loader for agent activity

## Next Steps

The animation classes are now available for use in components. Future tasks will:
1. Create React components that use these animations (AnimatedMessage, BubbleLoader, SkeletonLoader)
2. Apply animations to existing components (ChatPanel, ThreadPanel, FileExplorer)
3. Add animation triggers based on user interactions and state changes
