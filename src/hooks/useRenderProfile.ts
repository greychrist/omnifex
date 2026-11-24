import { renderProfiler } from '@/lib/renderProfiler';

/** Not an effect: it counts renders, including the ones React throws away. */
export function useRenderProfile(name: string): void {
  renderProfiler.recordRender(name);
}
