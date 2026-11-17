import type { Project } from '@/lib/api';

// The last `listProjects` answer, shared by every projects tab. A tab shows
// it straight away and refreshes behind it, so only the very first visit of a
// page load waits on the daemon's walk of every account's projects folder.
let cached: Project[] | null = null;

export function getCachedProjects(): Project[] | null {
  return cached;
}

export function setCachedProjects(projects: Project[]): void {
  cached = projects;
}

export function __resetProjectsCacheForTests(): void {
  cached = null;
}
