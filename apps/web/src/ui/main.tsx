import './styles/fonts.css';
import './styles/base.css';
import './styles/looks.css';
import { lookStyles } from '@comictoons/core';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { StudioSessionProvider } from './data/StudioSession';
import {ServerAdapter} from './data/server';
import { App } from './App';
import {WatchProvider} from './data/watch';

// The four Look recipes, injected once here so every view (overlay and readers included,
// which may never mount a LookPicker) has the rules without its own <style> tag.
const looks = document.createElement('style');
looks.textContent = lookStyles;
document.head.append(looks);

const adapter = new ServerAdapter();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WatchProvider><StudioSessionProvider adapter={adapter}><App/></StudioSessionProvider></WatchProvider>
  </StrictMode>,
);
