import { describe, it, expect } from "vitest";
import {
  createDefaultConfig,
  mergeConfig,
  parseConfig,
  serializeConfig,
  DEFAULT_KINDS,
} from "../messageRenderingConfig";

describe("messageRenderingConfig", () => {
  describe("createDefaultConfig", () => {
    it("includes every default kind keyed by id", () => {
      const cfg = createDefaultConfig();
      for (const k of DEFAULT_KINDS) {
        expect(cfg.kinds[k.id]).toBeDefined();
        expect(cfg.kinds[k.id].id).toBe(k.id);
      }
    });

    it("returns independent copies on each call", () => {
      const a = createDefaultConfig();
      const b = createDefaultConfig();
      a.kinds["user.prompt"].headerLabel = "MUTATED";
      expect(b.kinds["user.prompt"].headerLabel).toBe("You");
    });
  });

  describe("mergeConfig", () => {
    it("returns defaults for non-object input", () => {
      expect(mergeConfig(null).defaultViewMode).toBe("verbose");
      expect(mergeConfig("nope").defaultViewMode).toBe("verbose");
      expect(mergeConfig(42).defaultViewMode).toBe("verbose");
    });

    it("applies valid view-mode override", () => {
      expect(mergeConfig({ defaultViewMode: "compact" }).defaultViewMode).toBe("compact");
    });

    it("ignores invalid view-mode values", () => {
      expect(mergeConfig({ defaultViewMode: "weird" }).defaultViewMode).toBe("verbose");
    });

    it("merges partial kind overrides onto defaults", () => {
      const cfg = mergeConfig({
        kinds: {
          "user.prompt": { headerLabel: "Me", accentColor: "amber" },
        },
      });
      expect(cfg.kinds["user.prompt"].headerLabel).toBe("Me");
      expect(cfg.kinds["user.prompt"].accentColor).toBe("amber");
      // untouched fields keep defaults
      expect(cfg.kinds["user.prompt"].icon).toBe("User");
      expect(cfg.kinds["user.prompt"].alignment).toBe("right");
    });

    it("silently drops unknown kind ids (schema drift)", () => {
      const cfg = mergeConfig({
        kinds: { "nonexistent.kind": { icon: "Bot" } },
      });
      expect(cfg.kinds["nonexistent.kind"]).toBeUndefined();
    });

    it("rejects icon values not in the allow-list", () => {
      const cfg = mergeConfig({
        kinds: { "user.prompt": { icon: "NotARealIcon" } },
      });
      expect(cfg.kinds["user.prompt"].icon).toBe("User");
    });

    it("rejects accentColor names not in the palette", () => {
      const cfg = mergeConfig({
        kinds: { "user.prompt": { accentColor: "neon" } },
      });
      expect(cfg.kinds["user.prompt"].accentColor).toBe("blue");
    });

    it("forces hiddenInCompact=false for compact-boundary-locked kinds", () => {
      // user.prompt is compactBoundaryLocked; even if saved config says hidden,
      // merge must override back to visible.
      const cfg = mergeConfig({
        kinds: { "user.prompt": { hiddenInCompact: true } },
      });
      expect(cfg.kinds["user.prompt"].hiddenInCompact).toBe(false);
    });

    it("honors hiddenInCompact toggles on non-boundary kinds", () => {
      const cfg = mergeConfig({
        kinds: { "assistant.thinking": { hiddenInCompact: false } },
      });
      expect(cfg.kinds["assistant.thinking"].hiddenInCompact).toBe(false);
    });

    it("merges palette entries by name", () => {
      const cfg = mergeConfig({
        palette: {
          blue: { border: "blue-500/50", bg: "blue-500/10", swatch: "#1234ab" },
        },
      });
      expect(cfg.palette.blue.border).toBe("blue-500/50");
      expect(cfg.palette.blue.swatch).toBe("#1234ab");
      // other palette entries untouched
      expect(cfg.palette.primary.border).toBe("primary/20");
    });

    it("merges hard-filter toggles", () => {
      const cfg = mergeConfig({ hardFilters: { dropMeta: false } });
      expect(cfg.hardFilters.dropMeta).toBe(false);
      expect(cfg.hardFilters.dropTaskLifecycle).toBe(true);
    });
  });

  describe("parse/serialize round-trip", () => {
    it("round-trips a config through JSON", () => {
      const original = createDefaultConfig();
      original.defaultViewMode = "compact";
      original.kinds["user.prompt"].headerLabel = "Greg";
      const raw = serializeConfig(original);
      const restored = parseConfig(raw);
      expect(restored.defaultViewMode).toBe("compact");
      expect(restored.kinds["user.prompt"].headerLabel).toBe("Greg");
    });

    it("returns defaults for null/empty/invalid JSON", () => {
      expect(parseConfig(null).defaultViewMode).toBe("verbose");
      expect(parseConfig("").defaultViewMode).toBe("verbose");
      expect(parseConfig("{not json").defaultViewMode).toBe("verbose");
    });
  });
});
