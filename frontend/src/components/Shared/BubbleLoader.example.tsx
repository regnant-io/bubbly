/**
 * BubbleLoader Usage Examples
 * 
 * This file demonstrates how to use the BubbleLoader component in different scenarios.
 */

import { useState, useEffect } from 'react';
import { BubbleLoader } from './BubbleLoader';

// Example 1: Default usage with "Thinking..." text
export function Example1_Default() {
  return <BubbleLoader />;
}

// Example 2: Custom text
export function Example2_CustomText() {
  return <BubbleLoader text="Preparing action..." />;
}

// Example 3: Different sizes
export function Example3_Sizes() {
  return (
    <div className="space-y-4">
      <BubbleLoader size="small" text="Small loader" />
      <BubbleLoader size="medium" text="Medium loader" />
      <BubbleLoader size="large" text="Large loader" />
    </div>
  );
}

// Example 4: No text
export function Example4_NoText() {
  return <BubbleLoader text="" />;
}

// Example 5: In a chat context (typical usage)
export function Example5_ChatContext() {
  return (
    <div className="chat-message-container">
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-white">
          AI
        </div>
        <div className="flex-1">
          <BubbleLoader text="Thinking..." />
        </div>
      </div>
    </div>
  );
}

// Example 6: Conditional rendering based on loading state
export function Example6_ConditionalRendering() {
  const [isLoading, setIsLoading] = useState(true);
  const [response, setResponse] = useState('');

  useEffect(() => {
    // Simulate API call
    setTimeout(() => {
      setIsLoading(false);
      setResponse('Here is the response from the AI model.');
    }, 3000);
  }, []);

  return (
    <div>
      {isLoading ? (
        <BubbleLoader text="Generating response..." />
      ) : (
        <div className="message fade-enter">{response}</div>
      )}
    </div>
  );
}

// Example 7: Multiple loaders for different operations
export function Example7_MultipleOperations() {
  return (
    <div className="space-y-4">
      <BubbleLoader text="Reading files..." size="small" />
      <BubbleLoader text="Analyzing code..." size="small" />
      <BubbleLoader text="Generating response..." size="small" />
    </div>
  );
}

// Example 8: Integration with approval blocks
export function Example8_ApprovalPreparation() {
  const [preparing, setPreparing] = useState(true);

  return (
    <div>
      {preparing ? (
        <BubbleLoader text="Preparing action for approval..." />
      ) : (
        <div className="approval-block approval-block-enter">
          {/* Approval block content */}
          <div className="p-4 border border-border rounded-lg">
            <h3>Approve File Write</h3>
            <p>Write to: src/example.ts</p>
            <div className="flex gap-2 mt-2">
              <button className="btn-primary">Approve</button>
              <button className="btn-secondary">Reject</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
