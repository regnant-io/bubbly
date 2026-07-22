/**
 * ToolIndicator Component - Visual Examples
 * 
 * This file demonstrates the ToolIndicator component in various states
 * and with different tool types.
 */

import React from 'react';
import { ToolIndicator } from './ToolIndicator';

export function ToolIndicatorExamples() {
  return (
    <div className="p-8 space-y-8 bg-surface-0 min-h-screen">
      <div>
        <h1 className="text-2xl font-bold text-text mb-2">Tool-Specific Activity Indicators</h1>
        <p className="text-text-muted mb-6">
          Visual examples of the ToolIndicator component showing different tool types and states.
        </p>
      </div>

      {/* Executing State Examples */}
      <section>
        <h2 className="text-xl font-semibold text-text mb-4">Executing State (with pulse animation)</h2>
        <div className="space-y-2">
          <ToolIndicator tool="read_file" status="executing" />
          <ToolIndicator tool="write_file" status="executing" />
          <ToolIndicator tool="delete_file" status="executing" />
          <ToolIndicator tool="list_directory" status="executing" />
          <ToolIndicator tool="run_command" status="executing" />
          <ToolIndicator tool="git_commit" status="executing" />
          <ToolIndicator tool="search_files" status="executing" />
          <ToolIndicator tool="gather_context" status="executing" />
          <ToolIndicator tool="create_spec" status="executing" />
        </div>
      </section>

      {/* Complete State Examples */}
      <section>
        <h2 className="text-xl font-semibold text-text mb-4">Complete State (with duration)</h2>
        <div className="space-y-2">
          <ToolIndicator tool="read_file" status="complete" duration={123} />
          <ToolIndicator tool="write_file" status="complete" duration={456} />
          <ToolIndicator tool="delete_file" status="complete" duration={89} />
          <ToolIndicator tool="run_command" status="complete" duration={2345} />
          <ToolIndicator tool="git_commit" status="complete" duration={1567} />
          <ToolIndicator tool="search_files" status="complete" duration={3421} />
          <ToolIndicator tool="gather_context" status="complete" duration={5678} />
          <ToolIndicator tool="create_spec" status="complete" duration={890} />
        </div>
      </section>

      {/* Preparing State Examples */}
      <section>
        <h2 className="text-xl font-semibold text-text mb-4">Preparing State</h2>
        <div className="space-y-2">
          <ToolIndicator tool="read_file" status="preparing" />
          <ToolIndicator tool="write_file" status="preparing" />
          <ToolIndicator tool="run_command" status="preparing" />
        </div>
      </section>

      {/* Git Operations */}
      <section>
        <h2 className="text-xl font-semibold text-text mb-4">Git Operations</h2>
        <div className="space-y-2">
          <ToolIndicator tool="git_status" status="executing" />
          <ToolIndicator tool="git_diff" status="executing" />
          <ToolIndicator tool="git_commit" status="executing" />
          <ToolIndicator tool="git_push" status="complete" duration={2100} />
        </div>
      </section>

      {/* Config Operations */}
      <section>
        <h2 className="text-xl font-semibold text-text mb-4">Config Operations</h2>
        <div className="space-y-2">
          <ToolIndicator tool="read_config" status="executing" />
          <ToolIndicator tool="write_config" status="complete" duration={234} />
        </div>
      </section>

      {/* Unknown Tool Fallback */}
      <section>
        <h2 className="text-xl font-semibold text-text mb-4">Unknown Tool (Fallback)</h2>
        <div className="space-y-2">
          <ToolIndicator tool="unknown_tool" status="executing" />
          <ToolIndicator tool="custom_operation" status="complete" duration={1000} />
        </div>
      </section>

      {/* Duration Formatting Examples */}
      <section>
        <h2 className="text-xl font-semibold text-text mb-4">Duration Formatting</h2>
        <div className="space-y-2">
          <div className="text-text-muted text-sm mb-2">Milliseconds (under 1 second):</div>
          <ToolIndicator tool="read_file" status="complete" duration={50} />
          <ToolIndicator tool="read_file" status="complete" duration={250} />
          <ToolIndicator tool="read_file" status="complete" duration={999} />
          
          <div className="text-text-muted text-sm mb-2 mt-4">Seconds (1 second and above):</div>
          <ToolIndicator tool="run_command" status="complete" duration={1000} />
          <ToolIndicator tool="run_command" status="complete" duration={1500} />
          <ToolIndicator tool="run_command" status="complete" duration={5234} />
          <ToolIndicator tool="run_command" status="complete" duration={10000} />
        </div>
      </section>

      {/* Real-world Scenario */}
      <section>
        <h2 className="text-xl font-semibold text-text mb-4">Real-world Scenario</h2>
        <p className="text-text-muted text-sm mb-4">
          Simulating a typical agent workflow:
        </p>
        <div className="space-y-2">
          <ToolIndicator tool="gather_context" status="complete" duration={3456} />
          <ToolIndicator tool="read_file" status="complete" duration={123} />
          <ToolIndicator tool="read_file" status="complete" duration={98} />
          <ToolIndicator tool="write_file" status="executing" />
          <ToolIndicator tool="run_command" status="preparing" />
        </div>
      </section>

      {/* Color Palette Reference */}
      <section>
        <h2 className="text-xl font-semibold text-text mb-4">Color Palette</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-text-muted text-sm mb-2">File Operations:</div>
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 rounded bg-blue-agent"></div>
                <span className="text-sm text-text-muted">Read (Blue)</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 rounded bg-green-agent"></div>
                <span className="text-sm text-text-muted">Write (Green)</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 rounded bg-red-agent"></div>
                <span className="text-sm text-text-muted">Delete (Red)</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 rounded bg-cyan-agent"></div>
                <span className="text-sm text-text-muted">List (Cyan)</span>
              </div>
            </div>
          </div>
          <div>
            <div className="text-text-muted text-sm mb-2">Other Operations:</div>
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 rounded bg-amber-agent"></div>
                <span className="text-sm text-text-muted">Shell (Amber)</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 rounded bg-violet-agent"></div>
                <span className="text-sm text-text-muted">Git (Violet)</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 rounded bg-orange-agent"></div>
                <span className="text-sm text-text-muted">Search (Orange)</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 rounded bg-brown-agent"></div>
                <span className="text-sm text-text-muted">Context (Brown)</span>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

// Example usage in a story or demo page:
export default ToolIndicatorExamples;
