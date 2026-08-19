import { renderProfiler } from '@/lib/renderProfiler';

/**
 * Count this component's renders into the open profiling interaction.
 *
 * Call it at the top of a component body — it deliberately is NOT an effect,
 * because we want to count *renders*, including the ones React throws away.
 * When profiling is off (the default, and every normal session) this is a
 * boolean check and a return, which is why it is safe to call once per
 * transcript row.
 */
export function useRenderProfile(name: string): void {
  renderProfiler.recordRender(name);
}
