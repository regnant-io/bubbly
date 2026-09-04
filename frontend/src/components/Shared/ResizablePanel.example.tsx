import React, { useState } from 'react';
import { ResizablePanel } from './ResizablePanel';

/**
 * ResizablePanel Examples
 * 
 * This file demonstrates various use cases for the ResizablePanel component.
 * These examples are for documentation and testing purposes.
 */

// Example 1: Basic Sidebar
export function BasicSidebarExample() {
  return (
    <div className="flex h-screen">
      <ResizablePanel 
        defaultWidth={250} 
        storageKey="example-sidebar"
        className="bg-surface-1 border-r border-border"
      >
        <div className="p-4">
          <h2 className="text-lg font-semibold mb-4">Sidebar</h2>
          <ul className="space-y-2">
            <li>Item 1</li>
            <li>Item 2</li>
            <li>Item 3</li>
          </ul>
        </div>
      </ResizablePanel>
      
      <div className="flex-1 p-4 bg-surface-0">
        <h1>Main Content</h1>
        <p>Drag the sidebar edge to resize it.</p>
      </div>
    </div>
  );
}

// Example 2: File Explorer with Custom Constraints
export function FileExplorerExample() {
  return (
    <div className="flex h-screen">
      <ResizablePanel
        defaultWidth={300}
        minWidth={200}
        maxWidthPercent={50}
        storageKey="file-explorer-width"
        className="bg-surface-1 border-r border-border overflow-auto"
      >
        <div className="p-4">
          <h2 className="text-lg font-semibold mb-4">Files</h2>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span>📁</span>
              <span>src/</span>
            </div>
            <div className="flex items-center gap-2 pl-4">
              <span>📄</span>
              <span>index.ts</span>
            </div>
            <div className="flex items-center gap-2 pl-4">
              <span>📄</span>
              <span>App.tsx</span>
            </div>
          </div>
        </div>
      </ResizablePanel>
      
      <div className="flex-1 p-4 bg-surface-0">
        <h1>Editor</h1>
        <pre className="bg-surface-2 p-4 rounded">
          {`function example() {
  console.log('Hello, World!');
}`}
        </pre>
      </div>
    </div>
  );
}

// Example 3: Three-Panel Layout
export function ThreePanelExample() {
  return (
    <div className="flex h-screen">
      {/* Left Panel */}
      <ResizablePanel
        defaultWidth={200}
        storageKey="left-panel"
        className="bg-surface-1 border-r border-border"
      >
        <div className="p-4">
          <h3 className="font-semibold mb-2">Navigation</h3>
          <ul className="space-y-1 text-sm">
            <li>Dashboard</li>
            <li>Projects</li>
            <li>Settings</li>
          </ul>
        </div>
      </ResizablePanel>
      
      {/* Center Panel */}
      <div className="flex-1 p-4 bg-surface-0">
        <h1>Main Content</h1>
        <p>This panel takes up remaining space.</p>
      </div>
      
      {/* Right Panel */}
      <ResizablePanel
        defaultWidth={300}
        storageKey="right-panel"
        position="left"
        className="bg-surface-1 border-l border-border"
      >
        <div className="p-4">
          <h3 className="font-semibold mb-2">Details</h3>
          <p className="text-sm text-text-muted">
            Additional information appears here.
          </p>
        </div>
      </ResizablePanel>
    </div>
  );
}

// Example 4: With Resize Callback
export function ResizeCallbackExample() {
  const [width, setWidth] = useState(300);
  const [resizeCount, setResizeCount] = useState(0);

  return (
    <div className="flex h-screen">
      <ResizablePanel
        defaultWidth={300}
        onResize={(newWidth) => {
          setWidth(newWidth);
          setResizeCount(prev => prev + 1);
        }}
        className="bg-surface-1 border-r border-border"
      >
        <div className="p-4">
          <h3 className="font-semibold mb-4">Resizable Panel</h3>
          <div className="space-y-2 text-sm">
            <p>Current Width: <strong>{width}px</strong></p>
            <p>Resize Count: <strong>{resizeCount}</strong></p>
          </div>
        </div>
      </ResizablePanel>
      
      <div className="flex-1 p-4 bg-surface-0">
        <h1>Resize Tracking</h1>
        <p>The panel reports its width as you resize it.</p>
      </div>
    </div>
  );
}

// Example 5: Chat Layout with Multiple Resizable Panels
export function ChatLayoutExample() {
  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <ResizablePanel
        defaultWidth={250}
        minWidth={200}
        maxWidthPercent={30}
        storageKey="chat-sidebar"
        className="bg-surface-1 border-r border-border"
      >
        <div className="p-4">
          <h3 className="font-semibold mb-4">Channels</h3>
          <ul className="space-y-2 text-sm">
            <li className="p-2 bg-surface-2 rounded"># general</li>
            <li className="p-2 hover:bg-surface-2 rounded"># random</li>
            <li className="p-2 hover:bg-surface-2 rounded"># dev</li>
          </ul>
        </div>
      </ResizablePanel>
      
      {/* Chat Area */}
      <div className="flex-1 flex flex-col bg-surface-0">
        <div className="flex-1 p-4">
          <h2 className="text-lg font-semibold mb-4"># general</h2>
          <div className="space-y-2">
            <div className="p-2 bg-surface-1 rounded">
              <strong>User1:</strong> Hello!
            </div>
            <div className="p-2 bg-surface-1 rounded">
              <strong>User2:</strong> Hi there!
            </div>
          </div>
        </div>
        <div className="p-4 border-t border-border">
          <input 
            type="text" 
            placeholder="Type a message..." 
            className="w-full p-2 bg-surface-1 rounded"
          />
        </div>
      </div>
      
      {/* Details Panel */}
      <ResizablePanel
        defaultWidth={300}
        minWidth={250}
        maxWidthPercent={40}
        storageKey="chat-details"
        position="left"
        className="bg-surface-1 border-l border-border"
      >
        <div className="p-4">
          <h3 className="font-semibold mb-4">Thread Details</h3>
          <div className="space-y-2 text-sm">
            <p><strong>Created:</strong> 2 hours ago</p>
            <p><strong>Members:</strong> 5</p>
            <p><strong>Messages:</strong> 42</p>
          </div>
        </div>
      </ResizablePanel>
    </div>
  );
}

// Example 6: Minimal Width Panel
export function MinimalPanelExample() {
  return (
    <div className="flex h-screen">
      <ResizablePanel
        defaultWidth={180}
        minWidth={150}
        maxWidthPercent={25}
        storageKey="minimal-panel"
        className="bg-surface-1 border-r border-border"
      >
        <div className="p-2">
          <h4 className="text-sm font-semibold mb-2">Tools</h4>
          <div className="space-y-1">
            <button className="w-full p-2 text-left text-sm hover:bg-surface-2 rounded">
              🔍 Search
            </button>
            <button className="w-full p-2 text-left text-sm hover:bg-surface-2 rounded">
              ⚙️ Settings
            </button>
            <button className="w-full p-2 text-left text-sm hover:bg-surface-2 rounded">
              📊 Stats
            </button>
          </div>
        </div>
      </ResizablePanel>
      
      <div className="flex-1 p-4 bg-surface-0">
        <h1>Workspace</h1>
        <p>Compact tool panel on the left.</p>
      </div>
    </div>
  );
}

// Example 7: No Persistence (Session Only)
export function SessionOnlyExample() {
  return (
    <div className="flex h-screen">
      <ResizablePanel
        defaultWidth={300}
        className="bg-surface-1 border-r border-border"
        // No storageKey - width resets on page reload
      >
        <div className="p-4">
          <h3 className="font-semibold mb-2">Temporary Panel</h3>
          <p className="text-sm text-text-muted">
            This panel's width is not saved. It will reset to 300px on page reload.
          </p>
        </div>
      </ResizablePanel>
      
      <div className="flex-1 p-4 bg-surface-0">
        <h1>Main Content</h1>
        <p>Resize the panel and refresh the page to see it reset.</p>
      </div>
    </div>
  );
}

// Example 8: Integrated with Existing Components
export function IntegratedExample() {
  return (
    <div className="flex h-screen bg-surface-0">
      {/* Sidebar with Navigation */}
      <div className="w-16 bg-surface-1 border-r border-border flex flex-col items-center py-4 gap-4">
        <button className="p-2 hover:bg-surface-2 rounded">💬</button>
        <button className="p-2 hover:bg-surface-2 rounded">📁</button>
        <button className="p-2 hover:bg-surface-2 rounded">⚙️</button>
      </div>
      
      {/* Resizable File Explorer */}
      <ResizablePanel
        defaultWidth={280}
        minWidth={200}
        maxWidthPercent={50}
        storageKey="integrated-files"
        className="bg-surface-1 border-r border-border overflow-auto"
      >
        <div className="p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold">Explorer</h3>
            <button className="text-xs hover:bg-surface-2 p-1 rounded">+</button>
          </div>
          <div className="space-y-1 text-sm">
            <div>📁 components/</div>
            <div className="pl-4">📄 App.tsx</div>
            <div className="pl-4">📄 index.tsx</div>
            <div>📁 utils/</div>
            <div>📄 README.md</div>
          </div>
        </div>
      </ResizablePanel>
      
      {/* Main Editor Area */}
      <div className="flex-1 flex flex-col">
        <div className="h-10 bg-surface-1 border-b border-border flex items-center px-4 text-sm">
          <span>App.tsx</span>
        </div>
        <div className="flex-1 p-4 font-mono text-sm">
          <pre>{`import React from 'react';

function App() {
  return (
    <div>Hello, World!</div>
  );
}

export default App;`}</pre>
        </div>
      </div>
      
      {/* Resizable Right Panel */}
      <ResizablePanel
        defaultWidth={350}
        minWidth={250}
        maxWidthPercent={40}
        storageKey="integrated-details"
        position="left"
        className="bg-surface-1 border-l border-border overflow-auto"
      >
        <div className="p-4">
          <h3 className="font-semibold mb-4">Properties</h3>
          <div className="space-y-3 text-sm">
            <div>
              <label className="text-text-muted">Name</label>
              <input 
                type="text" 
                value="App.tsx" 
                className="w-full mt-1 p-2 bg-surface-2 rounded"
                readOnly
              />
            </div>
            <div>
              <label className="text-text-muted">Size</label>
              <input 
                type="text" 
                value="1.2 KB" 
                className="w-full mt-1 p-2 bg-surface-2 rounded"
                readOnly
              />
            </div>
            <div>
              <label className="text-text-muted">Modified</label>
              <input 
                type="text" 
                value="2 hours ago" 
                className="w-full mt-1 p-2 bg-surface-2 rounded"
                readOnly
              />
            </div>
          </div>
        </div>
      </ResizablePanel>
    </div>
  );
}

// Export all examples
export const examples = {
  BasicSidebarExample,
  FileExplorerExample,
  ThreePanelExample,
  ResizeCallbackExample,
  ChatLayoutExample,
  MinimalPanelExample,
  SessionOnlyExample,
  IntegratedExample,
};
