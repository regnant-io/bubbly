import { renderHook, act } from '@testing-library/react';
import { useScrollRestoration } from './useScrollRestoration';

describe('useScrollRestoration', () => {
  let mockElement: HTMLDivElement;
  let sessionStorageMock: { [key: string]: string };

  beforeEach(() => {
    // Create a mock scrollable element
    mockElement = document.createElement('div');
    Object.defineProperties(mockElement, {
      scrollTop: {
        value: 0,
        writable: true,
        configurable: true,
      },
      scrollHeight: {
        value: 1000,
        writable: true,
        configurable: true,
      },
      clientHeight: {
        value: 500,
        writable: true,
        configurable: true,
      },
    });

    // Mock sessionStorage
    sessionStorageMock = {};
    global.sessionStorage = {
      getItem: jest.fn((key: string) => sessionStorageMock[key] || null),
      setItem: jest.fn((key: string, value: string) => {
        sessionStorageMock[key] = value;
      }),
      removeItem: jest.fn((key: string) => {
        delete sessionStorageMock[key];
      }),
      clear: jest.fn(() => {
        sessionStorageMock = {};
      }),
      length: 0,
      key: jest.fn(),
    };

    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe('Requirement 4.2: Restore scroll position on tab return', () => {
    it('should restore saved scroll position on mount', () => {
      const storageKey = 'scroll-position-test-key';
      sessionStorageMock[storageKey] = '250';

      const { result } = renderHook(() => useScrollRestoration('test-key', true));

      // Manually set the ref to our mock element
      act(() => {
        if (result.current.scrollRef.current) {
          Object.assign(result.current.scrollRef.current, mockElement);
        }
      });

      // Simulate mount by triggering the effect
      act(() => {
        result.current.scrollRef.current = mockElement;
      });

      // The scroll position should be restored
      expect(mockElement.scrollTop).toBe(250);
    });

    it('should not restore scroll position when disabled', () => {
      const storageKey = 'scroll-position-test-key';
      sessionStorageMock[storageKey] = '250';

      const { result } = renderHook(() => useScrollRestoration('test-key', false));

      act(() => {
        result.current.scrollRef.current = mockElement;
      });

      // Scroll position should remain at 0
      expect(mockElement.scrollTop).toBe(0);
    });
  });

  describe('Requirement 4.6: Save scroll position before page unload', () => {
    it('should save scroll position on beforeunload event', () => {
      const { result } = renderHook(() => useScrollRestoration('test-key', true));

      act(() => {
        result.current.scrollRef.current = mockElement;
      });

      // Simulate scrolling
      act(() => {
        mockElement.scrollTop = 300;
        mockElement.dispatchEvent(new Event('scroll'));
      });

      // Fast-forward debounce timer
      act(() => {
        jest.advanceTimersByTime(100);
      });

      // Simulate beforeunload
      act(() => {
        window.dispatchEvent(new Event('beforeunload'));
      });

      expect(sessionStorage.setItem).toHaveBeenCalledWith(
        'scroll-position-test-key',
        '300'
      );
    });
  });

  describe('Scroll position tracking', () => {
    it('should save scroll position after debounce delay', () => {
      const { result } = renderHook(() => useScrollRestoration('test-key', true));

      act(() => {
        result.current.scrollRef.current = mockElement;
      });

      // Simulate scrolling
      act(() => {
        mockElement.scrollTop = 150;
        mockElement.dispatchEvent(new Event('scroll'));
      });

      // Should not save immediately
      expect(sessionStorage.setItem).not.toHaveBeenCalled();

      // Fast-forward debounce timer
      act(() => {
        jest.advanceTimersByTime(100);
      });

      // Should save after debounce
      expect(sessionStorage.setItem).toHaveBeenCalledWith(
        'scroll-position-test-key',
        '150'
      );
    });

    it('should debounce multiple scroll events', () => {
      const { result } = renderHook(() => useScrollRestoration('test-key', true));

      act(() => {
        result.current.scrollRef.current = mockElement;
      });

      // Simulate multiple rapid scroll events
      act(() => {
        mockElement.scrollTop = 100;
        mockElement.dispatchEvent(new Event('scroll'));
      });

      act(() => {
        jest.advanceTimersByTime(50);
      });

      act(() => {
        mockElement.scrollTop = 200;
        mockElement.dispatchEvent(new Event('scroll'));
      });

      act(() => {
        jest.advanceTimersByTime(50);
      });

      act(() => {
        mockElement.scrollTop = 300;
        mockElement.dispatchEvent(new Event('scroll'));
      });

      // Fast-forward to complete debounce
      act(() => {
        jest.advanceTimersByTime(100);
      });

      // Should only save the final position once
      expect(sessionStorage.setItem).toHaveBeenCalledTimes(1);
      expect(sessionStorage.setItem).toHaveBeenCalledWith(
        'scroll-position-test-key',
        '300'
      );
    });
  });

  describe('Auto-scroll behavior', () => {
    it('should detect when user is at bottom', () => {
      const { result } = renderHook(() => useScrollRestoration('test-key', true));

      act(() => {
        result.current.scrollRef.current = mockElement;
      });

      // Scroll to bottom (scrollHeight - scrollTop - clientHeight < 50)
      act(() => {
        mockElement.scrollTop = 500; // 1000 - 500 - 500 = 0 (at bottom)
        mockElement.dispatchEvent(new Event('scroll'));
      });

      act(() => {
        jest.advanceTimersByTime(100);
      });

      // isUserScrolling should be false when at bottom
      expect(result.current.isUserScrolling).toBe(false);
    });

    it('should detect when user scrolled up', () => {
      const { result } = renderHook(() => useScrollRestoration('test-key', true));

      act(() => {
        result.current.scrollRef.current = mockElement;
      });

      // Scroll up from bottom
      act(() => {
        mockElement.scrollTop = 200; // 1000 - 200 - 500 = 300 (not at bottom)
        mockElement.dispatchEvent(new Event('scroll'));
      });

      act(() => {
        jest.advanceTimersByTime(100);
      });

      // isUserScrolling should be true when not at bottom
      expect(result.current.isUserScrolling).toBe(true);
    });

    it('should auto-scroll to bottom when not user scrolling', () => {
      const { result } = renderHook(() => useScrollRestoration('test-key', true));

      act(() => {
        result.current.scrollRef.current = mockElement;
      });

      // User is at bottom
      act(() => {
        mockElement.scrollTop = 500;
        mockElement.dispatchEvent(new Event('scroll'));
      });

      act(() => {
        jest.advanceTimersByTime(100);
      });

      // Call scrollToBottom
      act(() => {
        result.current.scrollToBottom();
      });

      // Should scroll to bottom
      expect(mockElement.scrollTop).toBe(mockElement.scrollHeight);
    });

    it('should not auto-scroll when user has scrolled up', () => {
      const { result } = renderHook(() => useScrollRestoration('test-key', true));

      act(() => {
        result.current.scrollRef.current = mockElement;
      });

      // User scrolled up
      act(() => {
        mockElement.scrollTop = 200;
        mockElement.dispatchEvent(new Event('scroll'));
      });

      act(() => {
        jest.advanceTimersByTime(100);
      });

      const previousScrollTop = mockElement.scrollTop;

      // Call scrollToBottom without force
      act(() => {
        result.current.scrollToBottom(false);
      });

      // Should not change scroll position
      expect(mockElement.scrollTop).toBe(previousScrollTop);
    });

    it('should force scroll to bottom when force=true', () => {
      const { result } = renderHook(() => useScrollRestoration('test-key', true));

      act(() => {
        result.current.scrollRef.current = mockElement;
      });

      // User scrolled up
      act(() => {
        mockElement.scrollTop = 200;
        mockElement.dispatchEvent(new Event('scroll'));
      });

      act(() => {
        jest.advanceTimersByTime(100);
      });

      // Call scrollToBottom with force=true
      act(() => {
        result.current.scrollToBottom(true);
      });

      // Should scroll to bottom even though user scrolled up
      expect(mockElement.scrollTop).toBe(mockElement.scrollHeight);
    });
  });

  describe('Cleanup', () => {
    it('should remove event listeners on unmount', () => {
      const removeEventListenerSpy = jest.spyOn(mockElement, 'removeEventListener');
      const windowRemoveEventListenerSpy = jest.spyOn(window, 'removeEventListener');

      const { result, unmount } = renderHook(() => useScrollRestoration('test-key', true));

      act(() => {
        result.current.scrollRef.current = mockElement;
      });

      unmount();

      expect(removeEventListenerSpy).toHaveBeenCalledWith('scroll', expect.any(Function));
      expect(windowRemoveEventListenerSpy).toHaveBeenCalledWith(
        'beforeunload',
        expect.any(Function)
      );
    });

    it('should clear timeout on unmount', () => {
      const { result, unmount } = renderHook(() => useScrollRestoration('test-key', true));

      act(() => {
        result.current.scrollRef.current = mockElement;
      });

      // Trigger scroll to create timeout
      act(() => {
        mockElement.scrollTop = 100;
        mockElement.dispatchEvent(new Event('scroll'));
      });

      // Unmount before timeout completes
      unmount();

      // Advance timers - should not throw or save
      act(() => {
        jest.advanceTimersByTime(100);
      });

      // Should not have saved (cleanup cleared the timeout)
      expect(sessionStorage.setItem).not.toHaveBeenCalled();
    });
  });

  describe('Multiple instances', () => {
    it('should handle multiple scroll restoration instances with different keys', () => {
      const { result: result1 } = renderHook(() => useScrollRestoration('key1', true));
      const { result: result2 } = renderHook(() => useScrollRestoration('key2', true));

      const mockElement1 = { ...mockElement };
      const mockElement2 = { ...mockElement };

      act(() => {
        result1.current.scrollRef.current = mockElement1 as HTMLDivElement;
        result2.current.scrollRef.current = mockElement2 as HTMLDivElement;
      });

      // Scroll both elements
      act(() => {
        mockElement1.scrollTop = 100;
        mockElement1.dispatchEvent(new Event('scroll'));
      });

      act(() => {
        mockElement2.scrollTop = 200;
        mockElement2.dispatchEvent(new Event('scroll'));
      });

      act(() => {
        jest.advanceTimersByTime(100);
      });

      // Both should save with different keys
      expect(sessionStorage.setItem).toHaveBeenCalledWith('scroll-position-key1', '100');
      expect(sessionStorage.setItem).toHaveBeenCalledWith('scroll-position-key2', '200');
    });
  });
});
