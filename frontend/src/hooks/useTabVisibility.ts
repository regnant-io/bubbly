import { useEffect, useState } from 'react';

/**
 * Hook to detect when the browser tab is visible or hidden
 * Useful for pausing non-critical updates when tab is hidden
 */
export function useTabVisibility() {
  const [isVisible, setIsVisible] = useState(!document.hidden);

  useEffect(() => {
    const handleVisibilityChange = () => {
      const visible = !document.hidden;
      setIsVisible(visible);

      // Add/remove class to body for CSS control
      if (visible) {
        document.body.classList.remove('tab-hidden');
      } else {
        document.body.classList.add('tab-hidden');
      }
    };

    // Set initial state
    handleVisibilityChange();

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  return isVisible;
}
