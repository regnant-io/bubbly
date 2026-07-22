import { useEffect, useRef, useState } from 'react';

/**
 * Hook to persist and restore scroll position for a scrollable element
 * Uses sessionStorage to maintain scroll position across tab switches
 * but not across page refreshes (intentional for chat UX)
 */
export function useScrollRestoration(key: string, enabled: boolean = true) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isUserScrollingRef = useRef(false);
  const scrollTimeoutRef = useRef<number>();
  // Reactive "is the view pinned to the bottom?" — drives the scroll-to-bottom
  // button visibility. Ref alone can't trigger re-renders.
  const [isAtBottom, setIsAtBottom] = useState(true);

  useEffect(() => {
    if (!enabled || !scrollRef.current) return;

    const element = scrollRef.current;
    const storageKey = `scroll-position-${key}`;

    // Restore scroll position on mount
    const savedPosition = sessionStorage.getItem(storageKey);
    if (savedPosition) {
      element.scrollTop = parseInt(savedPosition, 10);
    }

    // Track user scrolling
    const handleScroll = () => {
      // Update the at-bottom flag immediately (cheap) for responsive UI.
      const atBottom =
        element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      isUserScrollingRef.current = !atBottom;
      setIsAtBottom((prev) => (prev !== atBottom ? atBottom : prev));

      // Debounce the persistence side-effect.
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
      scrollTimeoutRef.current = window.setTimeout(() => {
        sessionStorage.setItem(storageKey, element.scrollTop.toString());
      }, 100);
    };

    element.addEventListener('scroll', handleScroll, { passive: true });

    // Save scroll position before page unload
    const handleBeforeUnload = () => {
      sessionStorage.setItem(storageKey, element.scrollTop.toString());
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      element.removeEventListener('scroll', handleScroll);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, [key, enabled]);

  // Function to scroll to bottom (for new messages)
  const scrollToBottom = (force: boolean = false) => {
    if (!scrollRef.current) return;

    // Only auto-scroll if user hasn't scrolled up, or if forced
    if (force || !isUserScrollingRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      isUserScrollingRef.current = false;
      setIsAtBottom(true);
    }
  };

  return {
    scrollRef,
    scrollToBottom,
    isAtBottom,
    isUserScrolling: isUserScrollingRef.current,
  };
}
