import React, { useMemo } from 'react';
import { Circle, CircleDot } from '../Shared/icons';
import type { ChatMessage } from '../../types';

interface ConversationNavigatorProps {
  messages: ChatMessage[];
  scrollToMessage: (id: string) => void;
}

/**
 * Fixed left-side dots tracking prompts and responses.
 * Minimal indicators showing conversation flow - attached to chat UI, not overall layout.
 */
export function ConversationNavigator({ messages, scrollToMessage }: ConversationNavigatorProps) {
  // Extract prompts and their immediate responses
  const conversationPairs = useMemo(() => {
    const pairs: Array<{ promptId: string; responseId?: string; promptContent: string }> = [];
    
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.type === 'user') {
        // Find the next assistant/thinking message as the response
        let responseId: string | undefined;
        for (let j = i + 1; j < messages.length; j++) {
          if (messages[j].type === 'assistant' || messages[j].type === 'thinking') {
            responseId = messages[j].id;
            break;
          }
          // Stop at next user message
          if (messages[j].type === 'user') break;
        }
        
        pairs.push({
          promptId: msg.id,
          responseId,
          promptContent: (msg as Extract<ChatMessage, { type: 'user' }>).content.slice(0, 50),
        });
      }
    }
    
    return pairs;
  }, [messages]);

  // Find currently visible message for highlighting
  const [activeIndex, setActiveIndex] = React.useState(0);

  React.useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const id = entry.target.id.replace('msg-', '');
            const index = conversationPairs.findIndex(
              (p) => p.promptId === id || p.responseId === id
            );
            if (index !== -1) setActiveIndex(index);
          }
        });
      },
      { threshold: 0.5 }
    );

    // Observe all message elements
    conversationPairs.forEach((pair) => {
      const promptEl = document.getElementById(`msg-${pair.promptId}`);
      if (promptEl) observer.observe(promptEl);
      if (pair.responseId) {
        const responseEl = document.getElementById(`msg-${pair.responseId}`);
        if (responseEl) observer.observe(responseEl);
      }
    });

    return () => observer.disconnect();
  }, [conversationPairs]);

  if (conversationPairs.length === 0) return null;

  return (
    <div className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-8 flex flex-col gap-3 py-4">
      {conversationPairs.map((pair, index) => (
        <button
          key={pair.promptId}
          onClick={() => scrollToMessage(pair.promptId)}
          className="group relative"
          title={`Jump to: ${pair.promptContent}${pair.promptContent.length >= 50 ? '...' : ''}`}
        >
          {/* Dot indicator */}
          {index === activeIndex ? (
            <CircleDot size={10} className="text-accent-bright transition-colors" />
          ) : (
            <Circle size={10} className="text-text-dim/30 hover:text-accent/60 transition-colors" />
          )}
          
          {/* Hover tooltip */}
          <div className="absolute left-full ml-3 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 
                          pointer-events-none transition-opacity bg-surface-2 border border-border-bright 
                          rounded-lg px-2.5 py-1.5 text-xs text-text max-w-xs shadow-xl whitespace-nowrap z-50">
            {pair.promptContent}{pair.promptContent.length >= 50 ? '...' : ''}
          </div>
        </button>
      ))}
    </div>
  );
}
