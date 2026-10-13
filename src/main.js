import './demo.css';
import { createCompanion } from './companion.js';

const params = new URLSearchParams(window.location.search);
createCompanion({ theme: 'light', debug: import.meta.env.DEV || params.has('debug') });
