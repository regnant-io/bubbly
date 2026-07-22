import { renderHook, act } from '@testing-library/react';
import { useTheme } from './useTheme';
import { useStore } from '../store';

// Mock the store
jest.mock('../store', () => ({
  useStore: jest.fn(),
}));

describe('useTheme', () => {
  let mockSetResolvedTheme: jest.Mock;
  let mockTheme: 'light' | 'dark' | 'system';

  beforeEach(() => {
    mockSetResolvedTheme = jest.fn();
    mockTheme = 'dark';

    (useStore as unknown as jest.Mock).mockImplementation(() => ({
      theme: mockTheme,
      resolvedTheme: 'dark',
      setResolvedTheme: mockSetResolvedTheme,
    }));

    // Clear localStorage
    localStorage.clear();
    
    // Reset document classes
    document.documentElement.classList.remove('dark');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should apply dark theme class when theme is dark', () => {
    mockTheme = 'dark';
    (useStore as unknown as jest.Mock).mockImplementation(() => ({
      theme: 'dark',
      resolvedTheme: 'dark',
      setResolvedTheme: mockSetResolvedTheme,
    }));

    renderHook(() => useTheme());

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(mockSetResolvedTheme).toHaveBeenCalledWith('dark');
  });

  it('should remove dark theme class when theme is light', () => {
    mockTheme = 'light';
    (useStore as unknown as jest.Mock).mockImplementation(() => ({
      theme: 'light',
      resolvedTheme: 'light',
      setResolvedTheme: mockSetResolvedTheme,
    }));

    renderHook(() => useTheme());

    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(mockSetResolvedTheme).toHaveBeenCalledWith('light');
  });

  it('should persist theme to localStorage', () => {
    mockTheme = 'dark';
    (useStore as unknown as jest.Mock).mockImplementation(() => ({
      theme: 'dark',
      resolvedTheme: 'dark',
      setResolvedTheme: mockSetResolvedTheme,
    }));

    renderHook(() => useTheme());

    expect(localStorage.getItem('bubbly-theme')).toBe('dark');
  });

  it('should detect system theme preference when theme is system', () => {
    // Mock matchMedia to return dark preference
    const mockMatchMedia = jest.fn().mockImplementation((query) => ({
      matches: query === '(prefers-color-scheme: dark)',
      media: query,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    }));
    window.matchMedia = mockMatchMedia;

    mockTheme = 'system';
    (useStore as unknown as jest.Mock).mockImplementation(() => ({
      theme: 'system',
      resolvedTheme: 'dark',
      setResolvedTheme: mockSetResolvedTheme,
    }));

    renderHook(() => useTheme());

    expect(mockMatchMedia).toHaveBeenCalledWith('(prefers-color-scheme: dark)');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(mockSetResolvedTheme).toHaveBeenCalledWith('dark');
  });

  it('should listen for system theme changes when theme is system', () => {
    const mockAddEventListener = jest.fn();
    const mockRemoveEventListener = jest.fn();
    const mockMatchMedia = jest.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      addEventListener: mockAddEventListener,
      removeEventListener: mockRemoveEventListener,
    }));
    window.matchMedia = mockMatchMedia;

    mockTheme = 'system';
    (useStore as unknown as jest.Mock).mockImplementation(() => ({
      theme: 'system',
      resolvedTheme: 'light',
      setResolvedTheme: mockSetResolvedTheme,
    }));

    const { unmount } = renderHook(() => useTheme());

    expect(mockAddEventListener).toHaveBeenCalledWith('change', expect.any(Function));

    unmount();

    expect(mockRemoveEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('should return theme and resolvedTheme', () => {
    mockTheme = 'dark';
    (useStore as unknown as jest.Mock).mockImplementation(() => ({
      theme: 'dark',
      resolvedTheme: 'dark',
      setResolvedTheme: mockSetResolvedTheme,
    }));

    const { result } = renderHook(() => useTheme());

    expect(result.current.theme).toBe('dark');
    expect(result.current.resolvedTheme).toBe('dark');
  });
});
