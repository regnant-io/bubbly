import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
// Bundled, not fetched: the desktop app is local-first and must look the same
// offline. Loading these from Google Fonts meant a cold start without network
// quietly fell back to the OS UI font.
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
