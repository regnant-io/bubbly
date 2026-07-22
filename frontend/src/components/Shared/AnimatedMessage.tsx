import React, { ReactNode } from 'react';

interface AnimatedMessageProps {
  children: ReactNode;
  delay?: number; // Delay in milliseconds before animation starts
  className?: string;
}

/**
 * AnimatedMessage component
 * 
 * Wraps message content with a slideInUp animation for smooth appearance.
 * Uses GPU-accelerated transforms (translate3d) for optimal performance.
 * 
 * @param children - The content to animate
 * @param delay - Optional delay in milliseconds before animation starts (default: 0)
 * @param className - Optional additional CSS classes
 */
export function AnimatedMessage({ children, delay = 0, className = '' }: AnimatedMessageProps) {
  const animationStyle: React.CSSProperties = {
    animationDelay: delay > 0 ? `${delay}ms` : undefined,
  };

  return (
    <div 
      className={`message-enter ${className}`}
      style={animationStyle}
    >
      {children}
    </div>
  );
}
