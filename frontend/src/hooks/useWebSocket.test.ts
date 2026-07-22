import { renderHook, act, waitFor } from '@testing-library/react';
import { useWebSocket } from './useWebSocket';
import { useStore } from '../store';

// Mock WebSocket
class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  
  readyState = MockWebSocket.CLOSED;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err: any) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  
  constructor(public url: string) {
    // Simulate async connection
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      if (this.onopen) this.onopen();
    }, 10);
  }
  
  send(data: string) {
    // Mock send
  }
  
  close() {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) this.onclose();
  }
}

// Mock fetch for session restoration
global.fetch = jest.fn();

describe('useWebSocket reconnection logic', () => {
  let originalWebSocket: typeof WebSocket;
  
  beforeEach(() => {
    originalWebSocket = global.WebSocket;
    (global as any).WebSocket = MockWebSocket;
    jest.clearAllMocks();
    jest.useFakeTimers();
    
    // Mock fetch to return empty messages
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [] }),
    });
  });
  
  afterEach(() => {
    global.WebSocket = originalWebSocket;
    jest.useRealTimers();
  });
  
  it('should connect on mount', async () => {
    const { result } = renderHook(() => useWebSocket());
    
    // Wait for connection
    await act(async () => {
      jest.advanceTimersByTime(20);
    });
    
    await waitFor(() => {
      expect(result.current.connectionStatus).toBe('connected');
    });
  });
  
  it('should attempt reconnection with exponential backoff when connection drops', async () => {
    const { result } = renderHook(() => useWebSocket());
    
    // Wait for initial connection
    await act(async () => {
      jest.advanceTimersByTime(20);
    });
    
    await waitFor(() => {
      expect(result.current.connectionStatus).toBe('connected');
    });
    
    // Simulate connection drop
    const ws = (global as any).WebSocket.mock.instances[0];
    act(() => {
      ws.close();
    });
    
    // Should be reconnecting
    expect(result.current.connectionStatus).toBe('reconnecting');
    
    // First reconnect attempt should be after 1 second
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    
    // Should reconnect
    await act(async () => {
      jest.advanceTimersByTime(20);
    });
    
    await waitFor(() => {
      expect(result.current.connectionStatus).toBe('connected');
    });
  });
  
  it('should restore session state after reconnection', async () => {
    const mockMessages = [
      { id: '1', type: 'user', content: 'Hello', timestamp: Date.now() },
      { id: '2', type: 'assistant', content: 'Hi there', timestamp: Date.now() },
    ];
    
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ messages: mockMessages }),
    });
    
    // Set a current session ID
    useStore.getState().setCurrentSessionId('test-session-123');
    
    const { result } = renderHook(() => useWebSocket());
    
    // Wait for initial connection
    await act(async () => {
      jest.advanceTimersByTime(20);
    });
    
    await waitFor(() => {
      expect(result.current.connectionStatus).toBe('connected');
    });
    
    // Simulate connection drop
    const ws = (global as any).WebSocket.mock.instances[0];
    act(() => {
      ws.close();
    });
    
    // Wait for reconnection
    await act(async () => {
      jest.advanceTimersByTime(1020); // 1s delay + 20ms connection
    });
    
    // Should have called fetch to restore session
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/sessions/test-session-123/messages')
      );
    });
  });
  
  it('should use exponential backoff for multiple reconnection attempts', async () => {
    const { result } = renderHook(() => useWebSocket());
    
    // Wait for initial connection
    await act(async () => {
      jest.advanceTimersByTime(20);
    });
    
    // Simulate multiple connection drops
    for (let i = 0; i < 3; i++) {
      const ws = (global as any).WebSocket.mock.instances[i];
      act(() => {
        ws.close();
      });
      
      expect(result.current.connectionStatus).toBe('reconnecting');
      
      // Calculate expected delay: 1s, 2s, 4s
      const expectedDelay = 1000 * Math.pow(2, i);
      
      await act(async () => {
        jest.advanceTimersByTime(expectedDelay + 20);
      });
    }
  });
  
  it('should stop reconnecting after max attempts', async () => {
    // Create a WebSocket that always fails
    class FailingWebSocket extends MockWebSocket {
      constructor(url: string) {
        super(url);
        setTimeout(() => {
          this.readyState = MockWebSocket.CLOSED;
          if (this.onclose) this.onclose();
        }, 10);
      }
    }
    
    (global as any).WebSocket = FailingWebSocket;
    
    const { result } = renderHook(() => useWebSocket());
    
    // Attempt reconnections up to max attempts (10)
    for (let i = 0; i < 10; i++) {
      await act(async () => {
        const delay = Math.min(1000 * Math.pow(2, i), 16000);
        jest.advanceTimersByTime(delay + 20);
      });
    }
    
    // After max attempts, should be disconnected
    await waitFor(() => {
      expect(result.current.connectionStatus).toBe('disconnected');
    });
  });
  
  it('should notify user when connection is lost', async () => {
    const addMessageSpy = jest.spyOn(useStore.getState(), 'addMessage');
    
    const { result } = renderHook(() => useWebSocket());
    
    // Wait for initial connection
    await act(async () => {
      jest.advanceTimersByTime(20);
    });
    
    // Simulate connection drop
    const ws = (global as any).WebSocket.mock.instances[0];
    act(() => {
      ws.close();
    });
    
    // Should have added a status message
    expect(addMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'status',
        content: 'Connection lost. Reconnecting...',
      })
    );
  });
});
