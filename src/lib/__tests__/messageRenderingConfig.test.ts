import { describe, it, expect } from "vitest";
import {
  createDefaultConfig,
  mergeConfig,
  parseConfig,
  serializeConfig,
  DEFAULT_KINDS,
  DEFAULT_PALETTE,
  DEFAULT_TYPOGRAPHY,
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

    it("rejects accentColor strings that are neither palette names nor hex", () => {
      // "neon" isn't in the palette and doesn't look like a hex colour →
      // falls back to the kind's default.
      const cfg = mergeConfig({
        kinds: { "user.prompt": { accentColor: "neon" } },
      });
      expect(cfg.kinds["user.prompt"].accentColor).toBe("blue");
    });

    it("accepts hex accentColor strings (picker-driven configs)", () => {
      // The KindEditor's <input type="color"> emits 7-char `#rrggbb`; the
      // hex text field also accepts `#rgb` and `#rrggbbaa`. mergeConfig
      // must let these through so saved configs round-trip cleanly.
      for (const hex of ["#a855f7", "#abc", "#aabbccdd"]) {
        const cfg = mergeConfig({
          kinds: { "user.prompt": { accentColor: hex } },
        });
        expect(cfg.kinds["user.prompt"].accentColor).toBe(hex);
      }
    });

    it("locks exactly the four turn-boundary kinds", () => {
      // The compact-mode redesign shrinks the lock set to user.prompt and
      // the three terminal result kinds. Everything else must be toggleable.
      const locked = DEFAULT_KINDS.filter((k) => k.compactBoundaryLocked).map((k) => k.id).sort();
      expect(locked).toEqual([
        "result.awaiting_background",
        "result.error",
        "result.success",
        "user.prompt",
      ]);
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
      const cfg = mergeConfig({ hardFilters: { dropBookkeeping: false } });
      expect(cfg.hardFilters.dropBookkeeping).toBe(false);
      // Other new fields keep their defaults
      expect(cfg.hardFilters.dropEmptyUser).toBe(true);
      expect(cfg.hardFilters.hideSubagentLifecycle).toBe(false);
    });

    it("migrates legacy hardFilter keys (dropMeta → dropBookkeeping, dropTaskLifecycle → hideSubagentLifecycle, dropHookLifecycle → hideHookLifecycle)", () => {
      const legacyConfig = {
        version: 1,
        hardFilters: {
          dropMeta: false,
          dropTaskLifecycle: false,
          dropEmptyUser: false,
          dropHookLifecycle: false,
        },
      };
      const merged = mergeConfig(legacyConfig as any);
      expect(merged.hardFilters.dropBookkeeping).toBe(false);
      expect(merged.hardFilters.hideSubagentLifecycle).toBe(false);
      expect(merged.hardFilters.dropEmptyUser).toBe(false);
      expect(merged.hardFilters.hideHookLifecycle).toBe(false);
    });

    it("exposes the new palette entries (brown/chocolate/tan/black)", () => {
      expect(DEFAULT_PALETTE.brown).toBeDefined();
      expect(DEFAULT_PALETTE.chocolate).toBeDefined();
      expect(DEFAULT_PALETTE.tan).toBeDefined();
      expect(DEFAULT_PALETTE.black).toBeDefined();
      const cfg = createDefaultConfig();
      expect(cfg.palette.brown.swatch).toBe("#92400e");
      expect(cfg.palette.black.swatch).toBe("#171717");
    });

    it("merges typography overrides safely", () => {
      const cfg = mergeConfig({
        typography: {
          header: { typeface: "source-serif", size: "lg", weight: "bold", italic: true },
          content: { typeface: "jetbrains-mono" },
        },
      });
      expect(cfg.typography.header).toEqual({
        typeface: "source-serif",
        size: "lg",
        weight: "bold",
        italic: true,
      });
      // partial override preserves defaults for other fields
      expect(cfg.typography.content.typeface).toBe("jetbrains-mono");
      expect(cfg.typography.content.size).toBe(DEFAULT_TYPOGRAPHY.content.size);
    });

    it("rejects invalid typography values", () => {
      const cfg = mergeConfig({
        typography: {
          header: { typeface: "comic-sans", size: "huge", weight: "ultra", italic: "sometimes" },
        },
      });
      expect(cfg.typography.header).toEqual(DEFAULT_TYPOGRAPHY.header);
    });

    it("returns defaults when typography is entirely absent", () => {
      const cfg = mergeConfig({});
      expect(cfg.typography).toEqual(DEFAULT_TYPOGRAPHY);
    });
  });

  describe("typeface migration", () => {
    it("migrates legacy family: 'sans' to typeface: 'inter'", () => {
      const legacy = {
        ...JSON.parse(serializeConfig(createDefaultConfig())),
        typography: {
          header: { family: "sans", size: "sm", weight: "semibold", italic: false },
          content: { family: "sans", size: "sm", weight: "normal", italic: false },
          icon: { size: "base", bordered: true, bgOpacity: 100 },
        },
      };
      const cfg = parseConfig(JSON.stringify(legacy));
      expect(cfg.typography.header.typeface).toBe("inter");
      expect(cfg.typography.content.typeface).toBe("inter");
      // Legacy `family` key is dropped from the result.
      expect((cfg.typography.header as unknown as Record<string, unknown>).family).toBeUndefined();
    });

    it("migrates legacy family: 'serif' to typeface: 'source-serif'", () => {
      const legacy = {
        ...JSON.parse(serializeConfig(createDefaultConfig())),
        typography: {
          header: { family: "serif", size: "sm", weight: "semibold", italic: false },
          content: { family: "serif", size: "sm", weight: "normal", italic: false },
          icon: { size: "base", bordered: true, bgOpacity: 100 },
        },
      };
      const cfg = parseConfig(JSON.stringify(legacy));
      expect(cfg.typography.header.typeface).toBe("source-serif");
      expect(cfg.typography.content.typeface).toBe("source-serif");
    });

    it("migrates legacy family: 'mono' to typeface: 'jetbrains-mono'", () => {
      const legacy = {
        ...JSON.parse(serializeConfig(createDefaultConfig())),
        typography: {
          header: { family: "mono", size: "sm", weight: "semibold", italic: false },
          content: { family: "mono", size: "sm", weight: "normal", italic: false },
          icon: { size: "base", bordered: true, bgOpacity: 100 },
        },
      };
      const cfg = parseConfig(JSON.stringify(legacy));
      expect(cfg.typography.header.typeface).toBe("jetbrains-mono");
      expect(cfg.typography.content.typeface).toBe("jetbrains-mono");
    });

    it("falls back unknown typeface IDs to inter", () => {
      const bad = {
        ...JSON.parse(serializeConfig(createDefaultConfig())),
        typography: {
          header: { typeface: "not-a-real-font", size: "sm", weight: "semibold", italic: false },
          content: { typeface: "geist", size: "sm", weight: "normal", italic: false },
          icon: { size: "base", bordered: true, bgOpacity: 100 },
        },
      };
      const cfg = parseConfig(JSON.stringify(bad));
      expect(cfg.typography.header.typeface).toBe("inter");
      expect(cfg.typography.content.typeface).toBe("geist"); // valid one survives
    });

    it("default config uses typeface: 'inter' for both header and content", () => {
      const cfg = createDefaultConfig();
      expect(cfg.typography.header.typeface).toBe("inter");
      expect(cfg.typography.content.typeface).toBe("inter");
    });

    it("prefers typeface over legacy family when both are present", () => {
      const mixed = {
        ...JSON.parse(serializeConfig(createDefaultConfig())),
        typography: {
          header: {
            typeface: "source-serif",
            family: "mono",
            size: "sm",
            weight: "semibold",
            italic: false,
          },
          content: {
            typeface: "geist",
            family: "serif",
            size: "sm",
            weight: "normal",
            italic: false,
          },
          icon: { size: "base", bordered: true, bgOpacity: 100 },
        },
      };
      const cfg = parseConfig(JSON.stringify(mixed));
      // typeface field wins; legacy family is ignored entirely.
      expect(cfg.typography.header.typeface).toBe("source-serif");
      expect(cfg.typography.content.typeface).toBe("geist");
      expect((cfg.typography.header as unknown as Record<string, unknown>).family).toBeUndefined();
      expect((cfg.typography.content as unknown as Record<string, unknown>).family).toBeUndefined();
    });

    it("maps unrecognized legacy family strings (e.g. 'comic-sans', '') to inter", () => {
      // Cases: empty string, an unknown family name, the literal "monospace"
      // (close to but not equal to "mono"). All collapse to 'inter' rather
      // than retaining the user's malformed value or attempting a fuzzy match.
      const cases = ["", "comic-sans", "monospace"];
      for (const garbage of cases) {
        const legacy = {
          ...JSON.parse(serializeConfig(createDefaultConfig())),
          typography: {
            header: { family: garbage, size: "sm", weight: "semibold", italic: false },
            content: { family: garbage, size: "sm", weight: "normal", italic: false },
            icon: { size: "base", bordered: true, bgOpacity: 100 },
          },
        };
        const cfg = parseConfig(JSON.stringify(legacy));
        expect(cfg.typography.header.typeface, `family=${JSON.stringify(garbage)}`).toBe("inter");
        expect(cfg.typography.content.typeface, `family=${JSON.stringify(garbage)}`).toBe("inter");
      }
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

  describe("terminal", () => {
    it("createDefaultConfig includes a terminal section with a mono typeface", () => {
      const cfg = createDefaultConfig();
      expect(cfg.terminal).toBeDefined();
      // Default must be a real catalog id; the picker validates against the
      // catalog, and TerminalView resolves it via resolveTypeface so an
      // unknown id would silently fall back to Inter (a sans).
      expect(typeof cfg.terminal.typeface).toBe("string");
    });

    it("returns independent terminal copies (no shared reference)", () => {
      const a = createDefaultConfig();
      const b = createDefaultConfig();
      a.terminal.typeface = "geist-mono";
      expect(b.terminal.typeface).not.toBe("geist-mono");
    });

    it("merges a saved terminal.typeface", () => {
      const cfg = mergeConfig({ terminal: { typeface: "jetbrains-mono" } });
      expect(cfg.terminal.typeface).toBe("jetbrains-mono");
    });

    it("falls back to default when saved terminal.typeface is unknown", () => {
      const def = createDefaultConfig();
      const cfg = mergeConfig({ terminal: { typeface: "not-a-real-font" } });
      expect(cfg.terminal.typeface).toBe(def.terminal.typeface);
    });

    it("falls back to default when terminal section is absent", () => {
      const def = createDefaultConfig();
      const cfg = mergeConfig({});
      expect(cfg.terminal.typeface).toBe(def.terminal.typeface);
    });

    it("round-trips terminal.typeface through serialize/parse", () => {
      const original = createDefaultConfig();
      original.terminal.typeface = "plex-mono";
      const restored = parseConfig(serializeConfig(original));
      expect(restored.terminal.typeface).toBe("plex-mono");
    });
  });
});
