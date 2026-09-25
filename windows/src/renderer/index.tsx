// Compositor for Windows: the editor page. Starts the GPU compositor and the worker pool, opens the workspace
// (the window's project tabs) and shows the editor; then wires up files opened from Explorer and closing the window.
import { createRoot } from 'react-dom/client';
import './styles/app.css';
import { Workspace } from './session';
import { gpu as sharedGPU, type GPU } from './gpu/service';
import { Workers } from './workers/pool';
import { App } from './ui/App';
import { setAccent } from './ui/canvas/overlay';

function startGPU(): GPU | null {
  try { return sharedGPU(); } catch (error) { console.error(error); return null; }
}

function Unsupported() {
  return (
    <div className="unsupported">
      <h1>Compositor needs WebGL 2</h1>
      <p>Your graphics driver doesn’t provide WebGL 2, which Compositor draws the canvas with. Update your graphics driver,
        or start Compositor with the environment variable COMPOSITOR_SOFTWARE_GL=1 to use software rendering.</p>
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
const gpu = startGPU();
if (!gpu) {
  root.render(<Unsupported />);
} else {
  const workspace = new Workspace(gpu, new Workers());
  // For tests and debugging from the developer tools.
  (window as unknown as { compositorWorkspace: Workspace }).compositorWorkspace = workspace;
  root.render(<App workspace={workspace} gpu={gpu} />);

  // Windows' accent colour for handles and highlights.
  void window.compositor?.accentColor().then((color) => {
    if (!color) return;
    document.documentElement.style.setProperty('--accent', color);
    setAccent(color);
  });

  // Files opened from Explorer (or passed on the command line): projects open in tabs, images join the current one.
  window.compositor?.onOpenFiles((paths) => {
    void workspace.receive(paths.map((path) => ({ path, name: path })), workspace.current.key);
  });
  // Closing the window asks about every unsaved project first.
  window.compositor?.onCloseRequested(() => {
    void workspace.confirmQuit().then((ok) => { if (ok) window.compositor?.confirmClose(); });
  });
}

// Anything dropped outside a drop target must not make the page navigate to it.
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());
window.compositor?.rendererReady();
