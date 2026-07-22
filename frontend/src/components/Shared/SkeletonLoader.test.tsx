/**
 * Unit tests for SkeletonLoader component
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
import { render, screen } from '@testing-library/react';
import { SkeletonLoader, SkeletonApprovalBlock } from './SkeletonLoader';

describe('SkeletonLoader', () => {
  it('renders a single skeleton by default', () => {
    const { container } = render(<SkeletonLoader />);
    const skeletons = container.querySelectorAll('.skeleton');
    expect(skeletons).toHaveLength(1);
  });

  it('renders multiple skeletons when count is specified', () => {
    const { container } = render(<SkeletonLoader count={3} />);
    const skeletons = container.querySelectorAll('.skeleton');
    expect(skeletons).toHaveLength(3);
  });

  it('applies custom width and height', () => {
    const { container } = render(<SkeletonLoader width="200px" height="40px" />);
    const skeleton = container.querySelector('.skeleton') as HTMLElement;
    expect(skeleton.style.width).toBe('200px');
    expect(skeleton.style.height).toBe('40px');
  });

  it('converts numeric width and height to px', () => {
    const { container } = render(<SkeletonLoader width={150} height={30} />);
    const skeleton = container.querySelector('.skeleton') as HTMLElement;
    expect(skeleton.style.width).toBe('150px');
    expect(skeleton.style.height).toBe('30px');
  });

  it('applies text variant class by default', () => {
    const { container } = render(<SkeletonLoader />);
    const skeleton = container.querySelector('.skeleton');
    expect(skeleton).toHaveClass('rounded');
  });

  it('applies rectangular variant class', () => {
    const { container } = render(<SkeletonLoader variant="rectangular" />);
    const skeleton = container.querySelector('.skeleton');
    expect(skeleton).toHaveClass('rounded-md');
  });

  it('applies circular variant class', () => {
    const { container } = render(<SkeletonLoader variant="circular" />);
    const skeleton = container.querySelector('.skeleton');
    expect(skeleton).toHaveClass('rounded-full');
  });

  it('applies custom className', () => {
    const { container } = render(<SkeletonLoader className="custom-class" />);
    const skeleton = container.querySelector('.skeleton');
    expect(skeleton).toHaveClass('custom-class');
  });

  it('has proper accessibility attributes', () => {
    const { container } = render(<SkeletonLoader />);
    const skeleton = container.querySelector('[role="status"]');
    expect(skeleton).toHaveAttribute('aria-label', 'Loading...');
  });

  it('varies width for last line in multi-line text variant', () => {
    const { container } = render(<SkeletonLoader count={3} variant="text" />);
    const skeletons = container.querySelectorAll('.skeleton') as NodeListOf<HTMLElement>;
    const lastSkeleton = skeletons[skeletons.length - 1];
    
    // Last line should have a percentage width (not 100%)
    expect(lastSkeleton.style.width).toMatch(/%$/);
    expect(lastSkeleton.style.width).not.toBe('100%');
  });
});

describe('SkeletonApprovalBlock', () => {
  it('renders approval block skeleton structure', () => {
    const { container } = render(<SkeletonApprovalBlock />);
    
    // Should have the main container
    const approvalBlock = container.querySelector('.skeleton-approval-block');
    expect(approvalBlock).toBeTruthy();
    
    // Should have multiple skeleton elements
    const skeletons = container.querySelectorAll('.skeleton');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('has fade-enter animation class', () => {
    const { container } = render(<SkeletonApprovalBlock />);
    const approvalBlock = container.querySelector('.skeleton-approval-block');
    expect(approvalBlock).toHaveClass('fade-enter');
  });

  it('includes circular skeleton for icon', () => {
    const { container } = render(<SkeletonApprovalBlock />);
    const circularSkeleton = container.querySelector('.rounded-full');
    expect(circularSkeleton).toBeTruthy();
  });

  it('includes rectangular skeletons for buttons', () => {
    const { container } = render(<SkeletonApprovalBlock />);
    const rectangularSkeletons = container.querySelectorAll('.rounded-md');
    expect(rectangularSkeletons.length).toBeGreaterThanOrEqual(2);
  });
});
