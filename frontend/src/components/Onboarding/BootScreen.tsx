import React from 'react';
import { BubblyMark } from '../Shared/BubblyMark';
import { Bar } from '../Shared/SkeletonLoader';

/**
 * The first paint: the app's own shell, drawn in outline.
 *
 * Not a splash. Every block below sits at the exact geometry of the real one —
 * the 40px title strip, the 256px sidebar with its nav rows and thread list,
 * the inset canvas with its 48px header, the welcome block and the composer —
 * so when the app arrives it fills in instead of rearranging. If you change the
 * shell (workspace.css), change this with it: a skeleton of a layout that no
 * longer exists is a flash of the wrong app on every cold start.
 *
 * Nothing claims progress it does not have. The only moving part is an
 * indeterminate rail, and the words "Starting Bubbly" appear only once the
 * wait is long enough for them to be news.
 */
export function BootScreen({ message = 'Starting Bubbly' }: { message?: string }) {
  const [phase, setPhase] = React.useState<0 | 1 | 2>(0);
  React.useEffect(() => {
    const a = setTimeout(() => setPhase(1), 700);
    const b = setTimeout(() => setPhase(2), 4000);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, []);

  return (
    <div
      className="ide-root flex flex-col h-screen text-text select-none"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={message}
    >
      {/* Title strip */}
      <div className="browser-titlebar">
        <div className="flex items-center gap-2">
          {[0, 1, 2].map((i) => <Bar key={i} w={16} h={16} />)}
        </div>
        <div className="flex-1 flex justify-center"><Bar w={132} h={24} /></div>
        <Bar w={16} h={16} />
      </div>

      <div className="workspace-body flex flex-1 min-h-0">
        {/* Sidebar */}
        <div className="sb skeleton-wave" aria-hidden="true">
          <div className="sb-top">
            <div className="sb-brand"><BubblyMark size={18} animation="breathe" /><span>bubbly</span></div>
          </div>
          <div className="sb-actions">
            {[92, 64, 48, 52, 86, 70].map((w, i) => (
              <div key={i} className="sb-item">
                <Bar w={15} h={15} />
                <Bar w={w} h={8} />
              </div>
            ))}
          </div>
          <div className="sb-section"><Bar w={52} h={7} /></div>
          <div className="sb-threads">
            {[78, 62, 70, 54, 66, 58, 74].map((w, i) => (
              <div key={i} className="sb-thread" style={{ opacity: Math.max(0.35, 1 - i * 0.1) }}>
                <Bar w={`${w}%`} h={8} />
              </div>
            ))}
          </div>
        </div>

        {/* Canvas */}
        <div className="workspace-content flex flex-1 min-w-0 min-h-0">
          <div className="workspace-main flex-1 min-h-0 overflow-hidden flex flex-col">
            <div className="chat-heading"><Bar w={120} h={10} /></div>

            <div className="welcome-screen">
              <div className="welcome-content">
                <div className="welcome-mark"><BubblyMark size={26} animation="breathe" /></div>
                <div className="mb-2"><Bar w={110} h={8} /></div>
                <div className="h-[36px] flex items-center"><Bar w={340} h={18} /></div>
                <div className="suggestion-heading"><Bar w={90} h={8} /></div>
                <div className="suggestion-grid skeleton-wave">
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="suggestion-item" style={{ height: 58, opacity: Math.max(0.4, 1 - i * 0.15) }}>
                      <Bar w={16} h={16} />
                      <span className="flex flex-col gap-2"><Bar w={120} h={8} /><Bar w={84} h={6} /></span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="chat-composer">
              <div className="mx-auto w-full">
                <div className="composer-box">
                  <div className="px-[14px] pt-[16px] pb-[10px]"><Bar w="38%" h={9} /></div>
                  <div className="composer-bar">
                    <div className="composer-bar-left gap-3 pl-1">
                      <Bar w={16} h={16} /><Bar w={84} h={9} /><Bar w={48} h={9} />
                    </div>
                    <div className="skeleton shrink-0" style={{ width: 30, height: 30, borderRadius: 999 }} />
                  </div>
                </div>
                {/* Reserved height in every phase, so its arrival cannot nudge
                    the composer above it. */}
                <div className="composer-foot justify-center">
                  <div className="h-px w-24 overflow-hidden rounded-full bg-hairline/15">
                    {phase >= 1 && <span className="motion-rail block h-full w-1/3 rounded-full bg-accent/70" />}
                  </div>
                  <span className={`text-[11px] text-text-dim transition-opacity duration-300 ${phase >= 2 ? 'opacity-100' : 'opacity-0'}`}>
                    {message}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
