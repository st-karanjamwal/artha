import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import wasmUrl from 'sql.js/dist/sql-wasm-browser.wasm?url';
import { configureWasm } from '@/db/database';
import { App } from '@/app/App';
import { applyTheme } from '@/app/theme';
import './index.css';

configureWasm(wasmUrl);
applyTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
