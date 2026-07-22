/**
 * Unit tests for AnimatedMessage component
 * 
 * Note: These tests require vitest and @testing-library/react to be installed.
 * To run tests, first install dependencies:
 *   npm install -D vitest @testing-library/react @testing-library/jest-dom jsdom
 * 
 * Then add test script to package.json:
 *   "test": "vitest"
 * 
 * And configure vitest in vite.config.ts:
 *   import { defineConfig } from 'vite';
 *   export default defineConfig({
 *     test: {
 *       globals: true,
 *       environment: 'jsdom',
 *       setupFiles: './src/test/setup.ts',
 *     },
 *   });
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { AnimatedMessage } from './AnimatedMessage';

describe('AnimatedMessage', () => {
  it('renders children correctly', () => {
    const { getByText } = render(
      <AnimatedMessage>
        <div>Test Message</div>
      </AnimatedMessage>
    );
    
    expect(getByText('Test Message')).toBeInTheDocument();
  });

  it('applies message-enter animation class', () => {
    const { container } = render(
      <AnimatedMessage>
        <div>Test Message</div>
      </AnimatedMessage>
    );
    
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper).toHaveClass('message-enter');
  });

  it('applies custom className when provided', () => {
    const { container } = render(
      <AnimatedMessage className="custom-class">
        <div>Test Message</div>
      </AnimatedMessage>
    );
    
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper).toHaveClass('message-enter');
    expect(wrapper).toHaveClass('custom-class');
  });

  it('applies animation delay when provided', () => {
    const { container } = render(
      <AnimatedMessage delay={200}>
        <div>Test Message</div>
      </AnimatedMessage>
    );
    
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.style.animationDelay).toBe('200ms');
  });

  it('does not apply animation delay when delay is 0', () => {
    const { container } = render(
      <AnimatedMessage delay={0}>
        <div>Test Message</div>
      </AnimatedMessage>
    );
    
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.style.animationDelay).toBe('');
  });

  it('does not apply animation delay when delay is not provided', () => {
    const { container } = render(
      <AnimatedMessage>
        <div>Test Message</div>
      </AnimatedMessage>
    );
    
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.style.animationDelay).toBe('');
  });
});
