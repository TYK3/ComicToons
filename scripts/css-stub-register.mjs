// Test-only: lets Node import front-end modules that pull in stylesheets (import '../styles/x.css').
// The styles are irrelevant to server-side rendering in tests, so each .css import becomes an empty module.
import { register } from 'node:module';
register('./css-stub-hooks.mjs', import.meta.url);
