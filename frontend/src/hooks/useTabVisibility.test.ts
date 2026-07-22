import { renderHook, act } from '@testing-library/react';
import { useTabVisibility } from './useTabVisibility';

describe('useTabVisibility', () => {
  beforeEach(() => {
    // Reset document.hidden state
    Object.defineProperty(document, 'hidden', {
      writable: true,
      configurable: true,
      value: false,
    });
    
    // Clear body classes
    document.body.className = '';
  });

  it('should return true when tab is visible', () => {
    Object.defineProperty(document, 'hidden', {
      writable: true,
      configurable: true,
      value: false,
    });

    const { result } = renderHook(() => useTabVisibility());
    expect(result.current).toBe(true);
  });

  it('should return false when tab is hidden', () => {
    Object.defineProperty(document, 'hidden', {
      writable: true,
      configurable: true,
      value: true,
    });

    const { result } = renderHook(() => useTabVisibility());
    expect(result.current).toBe(false);
  });

  it('should add tab-hidden class to body when tab is hidden', () => {
    Object.defineProperty(document, 'hidden', {
      writable: true,
      configurable: true,
      value: true,
    });

    renderHook(() => useTabVisibility());
    expect(document.body.classList.contains('tab-hidden')).toBe(true);
  });

  it('should remove tab-hidden class from body when tab is visible', () => {
    Object.defineProperty(document, 'hidden', {
      writable: true,
      configurable: true,
      value: false,
    });

    renderHook(() => useTabVisibility());
    expect(document.body.classList.contains('tab-hidden')).toBe(false);
  });

  it('should update when visibility changes', () => {
    Object.defineProperty(document, 'hidden', {
      writable: true,
      configurable: true,
      value: false,
    });

    const { result } = renderHook(() => useTabVisibility());
    expect(result.current).toBe(true);
    expect(document.body.classList.contains('tab-hidden')).toBe(false);

    // Simulate tab becoming hidden
    act(() => {
      Object.defineProperty(document, 'hidden', {
        writable: true,
        configurable: true,
        value: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(result.current).toBe(false);
    expect(document.body.classList.contains('tab-hidden')).toBe(true);

    // Simulate tab becoming visible again
    act(() => {
      Object.defineProperty(document, 'hidden', {
        writable: true,
        configurable: true,
        value: false,
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(result.current).toBe(true);
    expect(document.body.classList.contains('tab-hidden')).toBe(false);
  });

  it('should clean up event listener on unmount', () => {
    const removeEventListenerSpy = jest.spyOn(document, 'removeEventListener');
    
    const { unmount } = renderHook(() => useTabVisibility());
    unmount();

    expect(removeEventListenerSpy).toHaveBeenCalledWith(
      'visibilitychange',
      expect.any(Function)
    );

    removeEventListenerSpy.mockRestore();
  });
});
