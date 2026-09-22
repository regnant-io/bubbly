/** Development-only workspace fixture. No live agent or backend required. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { ActivityBar } from './components/BubbleRoom/ActivityBar';
import { RightPanel } from './components/BubbleRoom/RightPanel';
import { ChatInput } from './components/Chat/ChatInput';
import { MessageList } from './components/Chat/MessageList';
import { ContextMenuProvider } from './components/Shared/ContextMenu';
import { BubblyMark } from './components/Shared/BubblyMark';
import { useStore } from './store';
import type { ChatMessage } from './types';
useStore.setState({ workspacePath: '/projects/studio', rightStack: ['plans', 'tasks', 'diff'], leftHidden: false, navHidden: false, chatDraft: '' });
const messages: ChatMessage[] = [
  { id: '1', type: 'user', content: 'Make the workspace feel beautifully simple. Give every detail a little room to breathe.', timestamp: 1 },
  { id: '2', type: 'assistant', content: 'I’ll refine the layout and bring the conversation, tools, and panels into one cohesive workspace.', timestamp: 2 },
  { id: '3', type: 'tool_call', callId: 'a', tool: 'read_file', args: { path: 'src/App.tsx' }, timestamp: 3 },
  { id: '4', type: 'tool_result', callId: 'a', tool: 'read_file', result: 'export default function App() { return <Workspace />; }', timestamp: 4 },
  { id: '5', type: 'tool_call', callId: 'b', tool: 'edit_file', args: { path: 'src/styles/workspace.css' }, timestamp: 5 },
  { id: '6', type: 'tool_result', callId: 'b', tool: 'edit_file', result: 'Updated workspace styles successfully.', timestamp: 6 },
  { id: '7', type: 'assistant', content: '### A calmer place to build\nThe navigation is compact, the tools stay within reach, and each panel makes use of the available space.\n\nTry collapsing a panel or expanding the steps above.', timestamp: 7 },
];
function Gallery() {
  const [width, setWidth] = React.useState(560);
  const [height, setHeight] = React.useState('100vh');
  const store = useStore();
  return <ContextMenuProvider><div className="ide-root flex flex-col" style={{height}}>
    <div style={{display:'flex',gap:12,padding:8,fontSize:11}}>
      <button onClick={() => { document.documentElement.classList.toggle('dark'); document.documentElement.setAttribute('data-theme', document.documentElement.classList.contains('dark') ? 'dark' : 'light'); }}>Toggle theme</button>
      <button onClick={() => setWidth(width === 560 ? 340 : 560)}>Resize tools</button>
      <button onClick={() => setHeight(height === '100vh' ? '480px' : '100vh')}>Short window</button>
      <button onClick={() => store.openRightContext('plans')}>Open plans</button>
      <button onClick={() => store.openRightContext('tasks')}>Open tasks</button>
    </div>
    <div className="workspace-body flex flex-1 min-h-0"><ActivityBar />
      <div className="workspace-content flex flex-1 min-w-0 min-h-0 gap-2"><main className="chat-surface flex flex-col flex-1 min-w-0 min-h-0">
        <header className="chat-heading"><div className="assistant-identity"><BubblyMark animation="orbit" />Bubbly studio</div><span className="eyebrow">DESIGN REVIEW</span></header>
        <MessageList messages={messages} onApprove={() => {}} onReject={() => {}} />
        <ChatInput onSend={() => store.setChatDraft('')} onStop={() => {}} isRunning={false} />
      </main>
      <aside className="workspace-right" style={{width, flexShrink:0}}><RightPanel /></aside></div>
    </div>
  </div></ContextMenuProvider>;
}
createRoot(document.getElementById('root')!).render(<Gallery />);
