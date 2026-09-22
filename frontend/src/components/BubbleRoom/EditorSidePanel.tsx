import React from 'react';
import { useStore } from '../../store';
import { RightPanel } from './RightPanel';
import { ChatPanel } from '../Chat/ChatPanel';
import { MessageSquare, LayoutGrid } from '../Shared/icons';

/** Editor mode shares its side region between conversation and the tool grid. */
export function EditorSidePanel() {
  const rightStack = useStore(s => s.rightStack);
  const [active, setActive] = React.useState<'chat' | 'tools'>('chat');
  const previous = React.useRef(rightStack);
  React.useEffect(() => {
    if (rightStack.some(id => !previous.current.includes(id))) setActive('tools');
    if (!rightStack.length) setActive('chat');
    previous.current = rightStack;
  }, [rightStack]);
  return (
    <div className="editor-side-region h-full flex flex-col overflow-hidden">
      {rightStack.length > 0 && <div className="editor-side-tabs" role="group" aria-label="Assistant view">
        <button onClick={() => setActive('chat')} aria-pressed={active === 'chat'}><MessageSquare size={14} /> Conversation</button>
        <button onClick={() => setActive('tools')} aria-pressed={active === 'tools'}><LayoutGrid size={14} /> Tools <span>{rightStack.length}</span></button>
      </div>}
      <div className="flex-1 min-h-0 relative">
        <div className={`absolute inset-0 ${active === 'chat' ? '' : 'invisible pointer-events-none'}`}><ChatPanel /></div>
        <div className={`absolute inset-0 ${active === 'tools' ? '' : 'invisible pointer-events-none'}`}><RightPanel /></div>
      </div>
    </div>
  );
}
