import './styles/fonts.css';
import './styles/base.css';
import './styles/looks.css';
import { lookStyles } from '@comictoons/core';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AdapterProvider } from './data/store';
import { ServerAdapter } from './data/server';
import { App } from './App';

// The four Look recipes, injected once here so every view (overlay and readers included,
// which may never mount a LookPicker) has the rules without its own <style> tag.
const looks = document.createElement('style');
looks.textContent = lookStyles;
document.head.append(looks);

// Choose the same-origin API adapter at the entry point.
const adapter = new ServerAdapter();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AdapterProvider adapter={adapter}><App/></AdapterProvider>
  </StrictMode>,
);
