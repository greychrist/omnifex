export interface SdkVersionDeps {
  readSdkPackageJson: () => Promise<{ version?: string } | null>;
  fetchLatestVersion: () => Promise<string>;
}

export interface SdkVersionService {
  getReferenced(): Promise<string | null>;
  getLatest(): Promise<string | null>;
}

export function createSdkVersionService(deps: SdkVersionDeps): SdkVersionService {
  return {
    async getReferenced() {
      try {
        const pkg = await deps.readSdkPackageJson();
        const v = pkg?.version;
        return typeof v === 'string' && v.length > 0 ? v : null;
      } catch {
        return null;
      }
    },

    async getLatest() {
      try {
        const v = await deps.fetchLatestVersion();
        return typeof v === 'string' && v.length > 0 ? v : null;
      } catch {
        return null;
      }
    },
  };
}
