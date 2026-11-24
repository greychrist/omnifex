import type { Project } from '@/lib/api';

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
