# SkeletonLoader Component

## Overview

The `SkeletonLoader` component provides animated placeholder elements that indicate content is loading. It uses a shimmer animation with the Solarized theme colors to create a polished loading experience.

## Requirements

This component satisfies the following requirements:

- **6.1**: Display skeleton loader before approval blocks appear
- **6.2**: Show loading state during approval preparation

## Components

### SkeletonLoader

The main skeleton loader component with customizable dimensions and variants.

#### Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `width` | `string \| number` | `'100%'` | Width of the skeleton. Numbers are converted to px. |
| `height` | `string \| number` | `'20px'` | Height of the skeleton. Numbers are converted to px. |
| `count` | `number` | `1` | Number of skeleton lines to render. |
| `className` | `string` | `''` | Additional CSS classes to apply. |
| `variant` | `'text' \| 'rectangular' \| 'circular'` | `'text'` | Shape variant of the skeleton. |

#### Variants

- **text**: Slightly rounded corners, suitable for text placeholders (default)
- **rectangular**: More rounded corners, suitable for cards and containers
- **circular**: Fully rounded, suitable for avatars and icons

#### Usage

```tsx
import { SkeletonLoader } from '@/components/Shared';

// Basic usage
<SkeletonLoader />

// Multiple lines
<SkeletonLoader count={3} />

// Custom dimensions
<SkeletonLoader width="200px" height={40} />

// Circular avatar placeholder
<SkeletonLoader variant="circular" width={48} height={48} />

// Rectangular card placeholder
<SkeletonLoader variant="rectangular" width="100%" height={200} />
```

### SkeletonApprovalBlock

A specialized skeleton loader that matches the structure of approval blocks.

#### Props

None. This component has a predefined layout.

#### Usage

```tsx
import { SkeletonApprovalBlock } from '@/components/Shared';

// Show while approval block is being prepared
{isPreparingApproval && <SkeletonApprovalBlock />}
```

## Features

### Shimmer Animation

The skeleton uses a shimmer animation defined in `animations.css`:

```css
@keyframes shimmer {
  0% {
    background-position: -1000px 0;
  }
  100% {
    background-position: 1000px 0;
  }
}
```

The animation creates a smooth left-to-right shimmer effect using a gradient background.

### Theme Integration

The skeleton automatically adapts to the current theme (light/dark) using CSS custom properties:

- `--surface-2`: Base skeleton color
- `--surface-3`: Shimmer highlight color

### Accessibility

- Each skeleton element has `role="status"` for screen readers
- Includes `aria-label="Loading..."` to indicate loading state
- Respects `prefers-reduced-motion` for users who prefer reduced animations

### Natural Text Appearance

When rendering multiple text lines (`count > 1` with `variant="text"`), the last line automatically has a randomized width between 60-90% to create a more natural appearance, similar to real text paragraphs.

## Common Patterns

### User Profile Card

```tsx
<div className="flex items-center gap-4">
  <SkeletonLoader variant="circular" width={48} height={48} />
  <div className="flex-1">
    <SkeletonLoader width="40%" height={20} className="mb-2" />
    <SkeletonLoader width="60%" height={14} />
  </div>
</div>
```

### Message List

```tsx
<div className="space-y-4">
  {[1, 2, 3].map((i) => (
    <div key={i} className="bg-surface-1 p-4 rounded-lg">
      <div className="flex items-start gap-3">
        <SkeletonLoader variant="circular" width={32} height={32} />
        <div className="flex-1">
          <SkeletonLoader width="30%" height={16} className="mb-2" />
          <SkeletonLoader count={2} />
        </div>
      </div>
    </div>
  ))}
</div>
```

### File List

```tsx
<div className="space-y-2">
  {[1, 2, 3, 4, 5].map((i) => (
    <div key={i} className="flex items-center gap-3">
      <SkeletonLoader variant="rectangular" width={20} height={20} />
      <SkeletonLoader width="60%" height={16} />
    </div>
  ))}
</div>
```

### Button Group

```tsx
<div className="flex gap-2">
  <SkeletonLoader variant="rectangular" width={100} height={36} />
  <SkeletonLoader variant="rectangular" width={100} height={36} />
</div>
```

## Integration with Approval Blocks

The `SkeletonApprovalBlock` component is designed to be shown while an approval request is being prepared:

```tsx
function ApprovalSection() {
  const [isPreparingApproval, setIsPreparingApproval] = useState(false);
  const [approvalData, setApprovalData] = useState(null);

  useEffect(() => {
    // Listen for approval preparation events
    socket.on('approval:preparing', () => {
      setIsPreparingApproval(true);
    });

    socket.on('approval:ready', (data) => {
      setIsPreparingApproval(false);
      setApprovalData(data);
    });
  }, []);

  if (isPreparingApproval) {
    return <SkeletonApprovalBlock />;
  }

  if (approvalData) {
    return <ApprovalCard data={approvalData} />;
  }

  return null;
}
```

## Animation Details

The shimmer animation:
- Duration: 2 seconds
- Timing: Linear (constant speed)
- Iteration: Infinite loop
- Direction: Left to right

The animation is GPU-accelerated using `background-position` for smooth performance.

## Browser Support

The component works in all modern browsers that support:
- CSS custom properties (CSS variables)
- CSS animations
- Flexbox

## Testing

The component includes comprehensive unit tests covering:
- Default rendering
- Multiple skeleton lines
- Custom dimensions (string and numeric)
- All variant types
- Custom class names
- Accessibility attributes
- Natural text width variation
- SkeletonApprovalBlock structure

Run tests with:

```bash
npm test SkeletonLoader.test.tsx
```

## Related Components

- **BubbleLoader**: Animated bubble loader for agent thinking state
- **AnimatedMessage**: Wrapper for message appearance animations
- **ApprovalCard**: The actual approval block component

## Performance Considerations

- Uses CSS animations (GPU-accelerated) instead of JavaScript
- Minimal DOM elements (one per skeleton line)
- No external dependencies
- Lightweight component (~2KB)

## Future Enhancements

Potential improvements for future versions:

1. **Wave animation**: Alternative animation style
2. **Pulse animation**: Fade in/out instead of shimmer
3. **Custom colors**: Override theme colors for specific use cases
4. **Speed control**: Adjust animation speed
5. **Direction control**: Right-to-left shimmer option
