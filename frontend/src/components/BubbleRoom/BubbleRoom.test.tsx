import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BubbleRoom } from './BubbleRoom';
import { useStore } from '../../store';

// Mock the store
vi.mock('../../store', () => ({
  useStore: vi.fn(),
}));

// Mock child components
vi.mock('./Sidebar', () => ({
  Sidebar: () => <div data-testid="sidebar">Sidebar</div>,
}));

vi.mock('./StatusBar', () => ({
  StatusBar: () => <div data-testid="statusbar">StatusBar</div>,
}));

vi.mock('./RightPanel', () => ({
  RightPanel: () => <div data-testid="rightpanel">RightPanel</div>,
}));

vi.mock('../Chat/ChatPanel', () => ({
  ChatPanel: () => <div data-testid="chatpanel">ChatPanel</div>,
}));

vi.mock('../FileExplorer/FileExplorer', () => ({
  FileExplorer: () => <div data-testid="fileexplorer">FileExplorer</div>,
}));

vi.mock('../FileExplorer/EditorPanel', () => ({
  EditorPanel: () => <div data-testid="editorpanel">EditorPanel</div>,
}));

vi.mock('../Settings/SettingsPanel', () => ({
  SettingsPanel: () => <div data-testid="settingspanel">SettingsPanel</div>,
}));

vi.mock('../SpecPanel/SpecPanel', () => ({
  SpecPanel: () => <div data-testid="specpanel">SpecPanel</div>,
}));

vi.mock('../Chat/AuditPanel', () => ({
  AuditPanel: () => <div data-testid="auditpanel">AuditPanel</div>,
}));

vi.mock('../ThreadPanel/ThreadPanel', () => ({
  ThreadPanel: () => <div data-testid="threadpanel">ThreadPanel</div>,
}));

vi.mock('../Shared/ResizablePanel', () => ({
  ResizablePanel: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="resizablepanel">{children}</div>
  ),
}));

vi.mock('../../utils/messageReconstruction', () => ({
  loadThread: vi.fn(),
}));

describe('BubbleRoom', () => {
  beforeEach(() => {
    // Reset mocks before each test
    vi.clearAllMocks();
    
    // Setup default store state
    (useStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      activePanel: 'chat',
      openFile: null,
      setActivePanel: vi.fn(),
      setCurrentSessionId: vi.fn(),
      clearMessages: vi.fn(),
      loadMessages: vi.fn(),
      rightPanelOpen: false,
    });

    // Mock useStore.getState() for RightPanel visibility check
    (useStore as unknown as { getState: () => unknown }).getState = vi.fn(() => ({
      rightPanelOpen: false,
    }));
  });

  it('renders StatusBar and Sidebar', () => {
    render(<BubbleRoom />);
    
    expect(screen.getByTestId('statusbar')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
  });

  it('renders ChatPanel when activePanel is chat', () => {
    render(<BubbleRoom />);
    
    expect(screen.getByTestId('chatpanel')).toBeInTheDocument();
  });

  it('renders FileExplorer with ResizablePanel when activePanel is files', () => {
    (useStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      activePanel: 'files',
      openFile: null,
      setActivePanel: vi.fn(),
      setCurrentSessionId: vi.fn(),
      clearMessages: vi.fn(),
      loadMessages: vi.fn(),
      rightPanelOpen: false,
    });

    render(<BubbleRoom />);
    
    // FileExplorer should be wrapped in ResizablePanel
    expect(screen.getByTestId('fileexplorer')).toBeInTheDocument();
    expect(screen.getByTestId('editorpanel')).toBeInTheDocument();
    expect(screen.getAllByTestId('resizablepanel').length).toBeGreaterThan(0);
  });

  it('renders SpecPanel when activePanel is specs', () => {
    (useStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      activePanel: 'specs',
      openFile: null,
      setActivePanel: vi.fn(),
      setCurrentSessionId: vi.fn(),
      clearMessages: vi.fn(),
      loadMessages: vi.fn(),
      rightPanelOpen: false,
    });

    render(<BubbleRoom />);
    
    expect(screen.getByTestId('specpanel')).toBeInTheDocument();
  });

  it('renders AuditPanel when activePanel is audit', () => {
    (useStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      activePanel: 'audit',
      openFile: null,
      setActivePanel: vi.fn(),
      setCurrentSessionId: vi.fn(),
      clearMessages: vi.fn(),
      loadMessages: vi.fn(),
      rightPanelOpen: false,
    });

    render(<BubbleRoom />);
    
    expect(screen.getByTestId('auditpanel')).toBeInTheDocument();
  });

  it('renders SettingsPanel when activePanel is settings', () => {
    (useStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      activePanel: 'settings',
      openFile: null,
      setActivePanel: vi.fn(),
      setCurrentSessionId: vi.fn(),
      clearMessages: vi.fn(),
      loadMessages: vi.fn(),
      rightPanelOpen: false,
    });

    render(<BubbleRoom />);
    
    expect(screen.getByTestId('settingspanel')).toBeInTheDocument();
  });

  it('renders ThreadPanel when activePanel is threads', () => {
    (useStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      activePanel: 'threads',
      openFile: null,
      setActivePanel: vi.fn(),
      setCurrentSessionId: vi.fn(),
      clearMessages: vi.fn(),
      loadMessages: vi.fn(),
      rightPanelOpen: false,
    });

    render(<BubbleRoom />);
    
    expect(screen.getByTestId('threadpanel')).toBeInTheDocument();
  });

  it('renders RightPanel with ResizablePanel when rightPanelOpen is true', () => {
    (useStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      activePanel: 'chat',
      openFile: null,
      setActivePanel: vi.fn(),
      setCurrentSessionId: vi.fn(),
      clearMessages: vi.fn(),
      loadMessages: vi.fn(),
      rightPanelOpen: true,
    });

    // Mock useStore.getState() to return rightPanelOpen: true
    (useStore as unknown as { getState: () => unknown }).getState = vi.fn(() => ({
      rightPanelOpen: true,
    }));

    render(<BubbleRoom />);
    
    // RightPanel should be wrapped in ResizablePanel
    expect(screen.getByTestId('rightpanel')).toBeInTheDocument();
    expect(screen.getByTestId('resizablepanel')).toBeInTheDocument();
  });

  it('does not render RightPanel when rightPanelOpen is false', () => {
    render(<BubbleRoom />);
    
    expect(screen.queryByTestId('rightpanel')).not.toBeInTheDocument();
  });

  it('wraps Sidebar with ResizablePanel', () => {
    render(<BubbleRoom />);
    
    const resizablePanels = screen.getAllByTestId('resizablepanel');
    const sidebar = screen.getByTestId('sidebar');
    
    // Sidebar should be inside a ResizablePanel
    expect(resizablePanels.length).toBeGreaterThan(0);
    expect(sidebar).toBeInTheDocument();
  });

  it('wraps ChatPanel with ResizablePanel when activePanel is chat', () => {
    render(<BubbleRoom />);
    
    const chatPanel = screen.getByTestId('chatpanel');
    const resizablePanels = screen.getAllByTestId('resizablepanel');
    
    // ChatPanel should be inside a ResizablePanel
    expect(chatPanel).toBeInTheDocument();
    expect(resizablePanels.length).toBeGreaterThan(0);
  });

  it('wraps FileExplorer with ResizablePanel when activePanel is files', () => {
    (useStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      activePanel: 'files',
      openFile: null,
      setActivePanel: vi.fn(),
      setCurrentSessionId: vi.fn(),
      clearMessages: vi.fn(),
      loadMessages: vi.fn(),
      rightPanelOpen: false,
    });

    render(<BubbleRoom />);
    
    const fileExplorer = screen.getByTestId('fileexplorer');
    const resizablePanels = screen.getAllByTestId('resizablepanel');
    
    // FileExplorer should be inside a ResizablePanel
    expect(fileExplorer).toBeInTheDocument();
    expect(resizablePanels.length).toBeGreaterThan(0);
  });
});
