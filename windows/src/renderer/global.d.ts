import type { CompositorBridge } from '../main/preload';
declare global {
  interface Window { compositor?: CompositorBridge }
}
export {};
