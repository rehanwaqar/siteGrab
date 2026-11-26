import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from '../client/components/ErrorBoundary';
import App from './App.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
