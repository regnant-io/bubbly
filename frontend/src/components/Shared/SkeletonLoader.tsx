import React from 'react';

interface SkeletonLoaderProps {
  width?: string | number;
  height?: string | number;
  count?: number;
  className?: string;
  variant?: 'text' | 'rectangular' | 'circular';
}

/**
 * SkeletonLoader Component
 * 
 * Displays a shimmer animation placeholder for loading content.
 * Uses the Solarized theme colors and supports multiple variants.
 * 
 * Requirements:
 * - 6.1: Display skeleton loader before approval blocks appear
 * - 6.2: Show bubble animation with "Preparing action..." text during approval preparation
 * 
 * @param width - Width of the skeleton (default: '100%')
 * @param height - Height of the skeleton (default: '20px')
 * @param count - Number of skeleton lines to render (default: 1)
 * @param className - Optional additional CSS classes
 * @param variant - Shape variant: 'text', 'rectangular', or 'circular' (default: 'text')
 */
export function SkeletonLoader({
  width = '100%',
  height = '20px',
  count = 1,
  className = '',
  variant = 'text',
}: SkeletonLoaderProps) {
  // Convert numeric values to px strings
  const widthStyle = typeof width === 'number' ? `${width}px` : width;
  const heightStyle = typeof height === 'number' ? `${height}px` : height;

  // Variant-specific styles
  const variantClasses = {
    text: 'rounded',
    rectangular: 'rounded-md',
    circular: 'rounded-full',
  };

  // Generate array of skeleton elements
  const skeletons = Array.from({ length: count }, (_, index) => {
    // For multiple text lines, vary the width slightly for a more natural look
    const lineWidth = count > 1 && variant === 'text' && index === count - 1
      ? `${Math.random() * 30 + 60}%` // Last line is 60-90% width
      : widthStyle;

    return (
      <div
        key={index}
        className={`skeleton ${variantClasses[variant]} ${className}`}
        style={{
          width: lineWidth,
          height: heightStyle,
          marginBottom: count > 1 && index < count - 1 ? '8px' : '0',
        }}
        role="status"
        aria-label="Loading..."
      />
    );
  });

  return <div className="skeleton-container">{skeletons}</div>;
}

/**
 * SkeletonApprovalBlock Component
 * 
 * Specialized skeleton loader for approval blocks with predefined layout.
 * Shows a skeleton that matches the typical approval block structure.
 */
export function SkeletonApprovalBlock() {
  return (
    <div className="skeleton-approval-block bg-surface-2 border border-border rounded-lg p-4 space-y-3 fade-enter">
      {/* Header skeleton */}
      <div className="flex items-center gap-3">
        <SkeletonLoader variant="circular" width={32} height={32} />
        <SkeletonLoader width="40%" height={16} />
      </div>
      
      {/* Content skeleton */}
      <div className="space-y-2">
        <SkeletonLoader width="100%" height={14} />
        <SkeletonLoader width="90%" height={14} />
        <SkeletonLoader width="70%" height={14} />
      </div>
      
      {/* Action buttons skeleton */}
      <div className="flex gap-2 pt-2">
        <SkeletonLoader variant="rectangular" width={80} height={32} />
        <SkeletonLoader variant="rectangular" width={80} height={32} />
      </div>
    </div>
  );
}
