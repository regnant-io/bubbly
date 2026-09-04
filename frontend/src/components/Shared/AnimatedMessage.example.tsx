/**
 * AnimatedMessage Component Usage Examples
 * 
 * This file demonstrates how to use the AnimatedMessage component
 * in various scenarios within the Bubbly application.
 */

import React from 'react';
import { AnimatedMessage } from './AnimatedMessage';

/**
 * Example 1: Basic usage with a simple message
 */
export function BasicExample() {
  return (
    <AnimatedMessage>
      <div className="p-4 bg-surface-2 rounded-lg">
        <p className="text-text">This message will slide in from below with a fade effect.</p>
      </div>
    </AnimatedMessage>
  );
}

/**
 * Example 2: Message with custom delay
 * Useful for staggered animations when rendering multiple messages
 */
export function DelayedExample() {
  return (
    <div className="space-y-2">
      <AnimatedMessage delay={0}>
        <div className="p-4 bg-surface-2 rounded-lg">
          <p className="text-text">First message (no delay)</p>
        </div>
      </AnimatedMessage>
      
      <AnimatedMessage delay={100}>
        <div className="p-4 bg-surface-2 rounded-lg">
          <p className="text-text">Second message (100ms delay)</p>
        </div>
      </AnimatedMessage>
      
      <AnimatedMessage delay={200}>
        <div className="p-4 bg-surface-2 rounded-lg">
          <p className="text-text">Third message (200ms delay)</p>
        </div>
      </AnimatedMessage>
    </div>
  );
}

/**
 * Example 3: Wrapping chat messages
 * This is the primary use case in the ChatPanel component
 */
export function ChatMessageExample() {
  const messages = [
    { id: '1', type: 'user', content: 'Hello, can you help me?', timestamp: Date.now() },
    { id: '2', type: 'assistant', content: 'Of course! What do you need help with?', timestamp: Date.now() + 1000 },
  ];

  return (
    <div className="space-y-4">
      {messages.map((message, index) => (
        <AnimatedMessage key={message.id} delay={index * 50}>
          <div className={`p-4 rounded-lg ${
            message.type === 'user' 
              ? 'bg-accent/10 border border-accent/30' 
              : 'bg-surface-2 border border-border'
          }`}>
            <p className="text-text">{message.content}</p>
          </div>
        </AnimatedMessage>
      ))}
    </div>
  );
}

/**
 * Example 4: With custom className for additional styling
 */
export function CustomStyledExample() {
  return (
    <AnimatedMessage className="shadow-lg">
      <div className="p-4 bg-gradient-to-r from-accent/20 to-accent/10 rounded-lg border border-accent/40">
        <p className="text-text font-medium">This message has custom styling applied!</p>
      </div>
    </AnimatedMessage>
  );
}

/**
 * Example 5: Integration with MessageList component
 * Shows how to use AnimatedMessage in the actual chat interface
 */
export function MessageListIntegrationExample() {
  const chatMessages = [
    { id: '1', type: 'user' as const, content: 'Write a function to calculate fibonacci', timestamp: Date.now() },
    { id: '2', type: 'assistant' as const, content: 'Here\'s a fibonacci function...', timestamp: Date.now() + 1000 },
    { id: '3', type: 'tool_call' as const, tool: 'write_file', args: { path: 'fib.ts' }, callId: 'call-1', timestamp: Date.now() + 2000 },
  ];

  return (
    <div className="space-y-3 p-4">
      {chatMessages.map((message, index) => (
        <AnimatedMessage key={message.id} delay={index * 75}>
          {message.type === 'user' && (
            <div className="flex justify-end">
              <div className="max-w-[80%] p-3 bg-accent/10 border border-accent/30 rounded-lg">
                <p className="text-text">{message.content}</p>
              </div>
            </div>
          )}
          
          {message.type === 'assistant' && (
            <div className="flex justify-start">
              <div className="max-w-[80%] p-3 bg-surface-2 border border-border rounded-lg">
                <p className="text-text">{message.content}</p>
              </div>
            </div>
          )}
          
          {message.type === 'tool_call' && (
            <div className="flex justify-start">
              <div className="p-2 bg-surface-3 border border-border rounded-lg text-sm">
                <span className="text-text-muted">🔧 {message.tool}</span>
              </div>
            </div>
          )}
        </AnimatedMessage>
      ))}
    </div>
  );
}

/**
 * Performance Note:
 * The AnimatedMessage component uses GPU-accelerated transforms (translate3d)
 * as defined in animations.css, ensuring smooth 60fps animations even with
 * many messages on screen.
 * 
 * Accessibility Note:
 * The animations automatically respect the user's prefers-reduced-motion
 * setting, as configured in animations.css.
 */
