import { createRoot } from 'react-dom/client';
import './styles/app.css';

function Placeholder() {
  const gl = document.createElement('canvas').getContext('webgl2');
  return <div style={{ color: '#ddd', padding: 40, fontFamily: 'Segoe UI, sans-serif' }}>
    <h1>Compositor</h1>
    <p>WebGL2: {gl ? 'yes' : 'no'} · isolated: {String(self.crossOriginIsolated)}</p>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Placeholder />);
window.compositor?.rendererReady();
