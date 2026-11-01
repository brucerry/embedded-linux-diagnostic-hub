import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './app/App';
import './styles/workspace.css';
import { initializeRendererLaunchTiming } from './launch-timing';

initializeRendererLaunchTiming();

createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>,
);
