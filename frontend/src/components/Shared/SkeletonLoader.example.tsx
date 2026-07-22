import React from 'react';
import { SkeletonLoader, SkeletonApprovalBlock } from './SkeletonLoader';

/**
 * SkeletonLoader Examples
 * 
 * This file demonstrates various use cases for the SkeletonLoader component.
 */

export function SkeletonLoaderExamples() {
  return (
    <div className="p-8 space-y-8 bg-surface-0">
      <section>
        <h2 className="text-xl font-bold mb-4 text-text">Basic Skeleton</h2>
        <div className="bg-surface-1 p-4 rounded-lg">
          <SkeletonLoader />
        </div>
      </section>

      <section>
        <h2 className="text-xl font-bold mb-4 text-text">Multiple Lines</h2>
        <div className="bg-surface-1 p-4 rounded-lg">
          <SkeletonLoader count={3} />
        </div>
      </section>

      <section>
        <h2 className="text-xl font-bold mb-4 text-text">Custom Dimensions</h2>
        <div className="bg-surface-1 p-4 rounded-lg space-y-4">
          <SkeletonLoader width="50%" height={24} />
          <SkeletonLoader width={200} height={16} />
          <SkeletonLoader width="80%" height={32} />
        </div>
      </section>

      <section>
        <h2 className="text-xl font-bold mb-4 text-text">Variants</h2>
        <div className="bg-surface-1 p-4 rounded-lg space-y-4">
          <div>
            <p className="text-sm text-text-muted mb-2">Text (default)</p>
            <SkeletonLoader variant="text" width="70%" />
          </div>
          <div>
            <p className="text-sm text-text-muted mb-2">Rectangular</p>
            <SkeletonLoader variant="rectangular" width={150} height={100} />
          </div>
          <div>
            <p className="text-sm text-text-muted mb-2">Circular</p>
            <SkeletonLoader variant="circular" width={64} height={64} />
          </div>
        </div>
      </section>

      <section>
        <h2 className="text-xl font-bold mb-4 text-text">User Profile Card Skeleton</h2>
        <div className="bg-surface-1 p-4 rounded-lg">
          <div className="flex items-center gap-4 mb-4">
            <SkeletonLoader variant="circular" width={48} height={48} />
            <div className="flex-1">
              <SkeletonLoader width="40%" height={20} className="mb-2" />
              <SkeletonLoader width="60%" height={14} />
            </div>
          </div>
          <SkeletonLoader count={3} />
        </div>
      </section>

      <section>
        <h2 className="text-xl font-bold mb-4 text-text">Approval Block Skeleton</h2>
        <SkeletonApprovalBlock />
      </section>

      <section>
        <h2 className="text-xl font-bold mb-4 text-text">Message List Skeleton</h2>
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="bg-surface-1 p-4 rounded-lg">
              <div className="flex items-start gap-3 mb-3">
                <SkeletonLoader variant="circular" width={32} height={32} />
                <div className="flex-1">
                  <SkeletonLoader width="30%" height={16} className="mb-2" />
                  <SkeletonLoader count={2} />
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-xl font-bold mb-4 text-text">File List Skeleton</h2>
        <div className="bg-surface-1 p-4 rounded-lg space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <SkeletonLoader variant="rectangular" width={20} height={20} />
              <SkeletonLoader width="60%" height={16} />
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-xl font-bold mb-4 text-text">Button Skeleton</h2>
        <div className="bg-surface-1 p-4 rounded-lg flex gap-2">
          <SkeletonLoader variant="rectangular" width={100} height={36} />
          <SkeletonLoader variant="rectangular" width={100} height={36} />
          <SkeletonLoader variant="rectangular" width={120} height={36} />
        </div>
      </section>
    </div>
  );
}

export default SkeletonLoaderExamples;
