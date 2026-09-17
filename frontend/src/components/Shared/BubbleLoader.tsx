interface BubbleLoaderProps {
  text?: string;
  size?: 'small' | 'medium' | 'large';
}

/**
 * BubbleLoader Component
 * 
 * Displays an animated bubble loader with three bubbles that pulse in sequence.
 * Uses Solarized theme accent colors (brown, orange, yellow) for visual appeal.
 * 
 * Requirements:
 * - 20.1: Display animated bubble loader when agent is waiting for model response
 * - 20.2: Use three bubbles that scale up and down in sequence
 * - 20.3: Color bubbles using Solarized theme accent colors
 * - 20.4: Display configurable text below the bubble loader
 * - 20.5: Show bubble loader in chat area where next message will appear
 * - 20.6: Transition from bubble loader to message content smoothly
 * - 20.7: Loop bubble animation continuously until response arrives
 */
export function BubbleLoader({ text = 'Thinking...', size = 'medium' }: BubbleLoaderProps) {
  const sizeClasses = {
    small: 'w-2 h-2',
    medium: 'w-3 h-3',
    large: 'w-4 h-4',
  };

  const gapClasses = {
    small: 'gap-1',
    medium: 'gap-2',
    large: 'gap-3',
  };

  const textSizeClasses = {
    small: 'text-xs',
    medium: 'text-sm',
    large: 'text-base',
  };

  return (
    <div className="bubble-loader-container flex flex-col items-center justify-center py-4 motion-appear">
      {/* Three bubbles with staggered pulse animation */}
      {/*
        THE COLOURS COME FROM THE PALETTE, NOT FROM A HEX LITERAL.

        These three dots were hard-coded to #b58900 / #cb4b16 / #b58900 —
        Solarized yellow and orange — which meant that on eight of the nine
        palettes this loader rendered in colours from a theme the user had not
        chosen, and in light mode it sat at the wrong contrast entirely. The
        accent and secondary tokens re-skin with everything else.
      */}
      <div className={`bubble-loader ${gapClasses[size]}`} aria-hidden="true">
        <div className={`bubble ${sizeClasses[size]}`} style={{ animationDelay: '0s' }} />
        <div className={`bubble ${sizeClasses[size]}`} style={{ animationDelay: '0.2s' }} />
        <div className={`bubble ${sizeClasses[size]}`} style={{ animationDelay: '0.4s' }} />
      </div>

      {/* Configurable text below bubbles */}
      {text && (
        <div className={`mt-3 text-text-muted ${textSizeClasses[size]}`}>
          {text}
        </div>
      )}
    </div>
  );
}
