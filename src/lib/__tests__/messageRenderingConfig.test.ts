import { describe, it, expect } from "vitest";
import {
  createDefaultConfig,
  mergeConfig,
  parseConfig,
  serializeConfig,
  resolveKind,
  DEFAULT_PALETTE,
  DEFAULT_TYPOGRAPHY,
  DEFAULT_CATEGORIES,
  CATEGORIES,
  KIND_REGISTRY,
  categoryOf,
} from "../messageRenderingConfig";

// ─── config v5 ──────────────────────────────────────────────────────────────

describe("config v5", () => {
  it("default config is version 5 with an empty kinds map", () => {
    const cfg = createDefaultConfig();
    expect(cfg.version).toBe(5);
    expect(cfg.kinds).toEqual({});
  });

  it("round-trips a v5 config with user kind patches", () => {
    const cfg = createDefaultConfig();
    cfg.kinds["user.prompt"] = { accentColor: "teal" };
    const back = parseConfig(serializeConfig(cfg));
    expect(back.kinds["user.prompt"]).toEqual({ accentColor: "teal" });
  });

  it("resets to defaults when the saved version is not 5", () => {
    const merged = mergeConfig({ version: 4, overrides: [{ id: "x", category: "system", match: [], style: {} }] });
    expect(merged.version).toBe(5);
    expect(merged.kinds).toEqual({});
  });

  it("drops junk fields in a saved kinds patch", () => {
    const merged = mergeConfig({ version: 5, kinds: { "user.prompt": { accentColor: "teal", icon: "NotARealIcon", bogus: 1 } } });
    expect(merged.kinds["user.prompt"]).toEqual({ accentColor: "teal" });
  });
});

// ─── resolveKind (three-layer merge) ────────────────────────────────────────

describe("resolveKind (three-layer merge)", () => {
  it("layers category -> registry default -> user patch", () => {
    const cfg = createDefaultConfig();
    expect(resolveKind(cfg, "assistant.text").icon).toBe("Bot"); // agent category icon (no registry override)
    expect(resolveKind(cfg, "permission.request").accentColor).toBe("amber"); // registry default
    expect(resolveKind(cfg, "permission.request").icon).toBe("ShieldQuestion");
    cfg.kinds["permission.request"] = { accentColor: "teal" }; // user patch wins
    expect(resolveKind(cfg, "permission.request").accentColor).toBe("teal");
    expect(resolveKind(cfg, "permission.request").icon).toBe("ShieldQuestion"); // unpatched field falls through
  });

  it("an unregistered id resolves to the system category base", () => {
    const cfg = createDefaultConfig();
    expect(resolveKind(cfg, "future.kind").accentColor).toBe("muted");
  });

  it("returns the category default for the kind's category", () => {
    const cfg = createDefaultConfig();
    const s = resolveKind(cfg, "user.prompt");
    expect(s.alignment).toBe("right");
    expect(s.headerLabel).toBe("You");
    expect(s.presentation).toBe("card");
  });

  it("registry default overrides category base, user patch wins over both", () => {
    const cfg = createDefaultConfig();
    // assistant.text.endTurn has registry default: green/CheckCircle2
    const s = resolveKind(cfg, "assistant.text.endTurn");
    expect(s.accentColor).toBe("green");    // registry default
    expect(s.icon).toBe("CheckCircle2");    // registry default
    expect(s.headerLabel).toBe("Claude");   // inherited from agent category
    // now add a user patch
    cfg.kinds["assistant.text.endTurn"] = { accentColor: "pink" };
    expect(resolveKind(cfg, "assistant.text.endTurn").accentColor).toBe("pink"); // user wins
    expect(resolveKind(cfg, "assistant.text.endTurn").icon).toBe("CheckCircle2"); // unpatched still from registry
  });
});

// ─── createDefaultConfig ─────────────────────────────────────────────────────

describe("createDefaultConfig", () => {
  it("is version 5 with categories and an empty kinds map", () => {
    const cfg = createDefaultConfig();
    expect(cfg.version).toBe(5);
    expect(Object.keys(cfg.categories).sort()).toEqual(["agent", "system", "user"]);
    expect(cfg.kinds).toEqual({});
  });

  it("includes every category and their presentations", () => {
    const cfg = createDefaultConfig();
    for (const c of CATEGORIES) {
      expect(cfg.categories[c].presentation).toBeDefined();
    }
  });

  it("defaults user.systemContext to the collapsible presentation with raw-payload metadata", () => {
    const cfg = createDefaultConfig();
    const s = resolveKind(cfg, "user.systemContext");
    expect(s.presentation).toBe("collapsible");
    expect(s.showRawPayload).toBe(true);
  });

  it("returns independent copies on each call", () => {
    const a = createDefaultConfig();
    const b = createDefaultConfig();
    a.categories.user.headerLabel = "MUTATED";
    expect(b.categories.user.headerLabel).toBe("You");
  });

  it("compactBoundaryLocked kinds are set via registry defaults", () => {
    const cfg = createDefaultConfig();
    // These kinds carry compactBoundaryLocked in their registry default
    const locked = Object.keys(KIND_REGISTRY)
      .filter((id) => resolveKind(cfg, id).compactBoundaryLocked)
      .sort();
    expect(locked).toEqual([
      "assistant.text.endTurn",
      "summary.compaction",
      "unknown",
      "user.prompt",
    ]);
  });
});

// ─── mergeConfig ─────────────────────────────────────────────────────────────

describe("mergeConfig", () => {
  it("returns defaults for non-object input", () => {
    expect(mergeConfig(null).defaultViewMode).toBe("verbose");
    expect(mergeConfig("nope").defaultViewMode).toBe("verbose");
    expect(mergeConfig(42).defaultViewMode).toBe("verbose");
  });

  it("resets to defaults when saved version is not 5 (v4)", () => {
    const merged = mergeConfig({ version: 4, categories: {}, overrides: [] });
    expect(merged.version).toBe(5);
    expect(merged.kinds).toEqual({});
  });

  it("resets to defaults when saved version is not 5 (v2)", () => {
    const merged = mergeConfig({ version: 2, kinds: { "user.prompt": { accentColor: "pink" } } });
    expect(merged.version).toBe(5);
    // The v2 kinds are NOT migrated — full reset
    expect(merged.kinds).toEqual({});
  });

  it("resets to defaults when saved version is not 5 (v3)", () => {
    const merged = mergeConfig({ version: 3, overrides: { "assistant.tool-use": { accentColor: "info" } } });
    expect(merged.version).toBe(5);
    expect(merged.kinds).toEqual({});
  });

  it("applies valid view-mode override", () => {
    expect(mergeConfig({ version: 5, defaultViewMode: "compact" }).defaultViewMode).toBe("compact");
  });

  it("ignores invalid view-mode values", () => {
    expect(mergeConfig({ version: 5, defaultViewMode: "weird" }).defaultViewMode).toBe("verbose");
  });

  it("merges a valid kinds patch onto a v5 config", () => {
    const cfg = mergeConfig({
      version: 5,
      kinds: {
        "user.prompt": { headerLabel: "Me", accentColor: "amber" },
      },
    });
    expect(cfg.kinds["user.prompt"]).toEqual({ headerLabel: "Me", accentColor: "amber" });
    const s = resolveKind(cfg, "user.prompt");
    expect(s.headerLabel).toBe("Me");
    expect(s.accentColor).toBe("amber");
    // untouched fields keep defaults
    expect(s.icon).toBe("User");
    expect(s.alignment).toBe("right");
  });

  it("rejects icon values not in the allow-list", () => {
    const cfg = mergeConfig({
      version: 5,
      kinds: { "user.prompt": { icon: "NotARealIcon" } },
    });
    expect(cfg.kinds["user.prompt"]).toBeUndefined();
    expect(resolveKind(cfg, "user.prompt").icon).toBe("User");
  });

  it("rejects accentColor strings that are neither palette names nor hex", () => {
    const cfg = mergeConfig({
      version: 5,
      kinds: { "user.prompt": { accentColor: "neon" } },
    });
    expect(cfg.kinds["user.prompt"]).toBeUndefined();
    expect(resolveKind(cfg, "user.prompt").accentColor).toBe("blue");
  });

  it("accepts hex accentColor strings (picker-driven configs)", () => {
    for (const hex of ["#a855f7", "#abc", "#aabbccdd"]) {
      const cfg = mergeConfig({
        version: 5,
        kinds: { "user.prompt": { accentColor: hex } },
      });
      expect(resolveKind(cfg, "user.prompt").accentColor).toBe(hex);
    }
  });

  it("persists presentation, borderStyle, and showRawPayload through kinds merge", () => {
    const persisted = {
      version: 5,
      kinds: {
        "user.prompt": { presentation: "side-line", borderStyle: "dashed" },
        "system.unknown": { showRawPayload: false },
      },
    };
    const merged = mergeConfig(persisted);
    expect(resolveKind(merged, "user.prompt").presentation).toBe("side-line");
    expect(resolveKind(merged, "user.prompt").borderStyle).toBe("dashed");
    expect(resolveKind(merged, "system.unknown").showRawPayload).toBe(false);
  });

  it("rejects invalid presentation and borderStyle values", () => {
    const cfg = mergeConfig({
      version: 5,
      kinds: {
        "user.prompt": { presentation: "balloon", borderStyle: "dotted" },
      },
    });
    // Invalid values are dropped; resolves to category defaults.
    expect(resolveKind(cfg, "user.prompt").presentation).toBe("card");
    expect(resolveKind(cfg, "user.prompt").borderStyle).toBe("solid");
  });

  it("merges palette entries by name", () => {
    const cfg = mergeConfig({
      version: 5,
      palette: {
        blue: { border: "blue-500/50", bg: "blue-500/10", swatch: "#1234ab" },
      },
    });
    expect(cfg.palette.blue.border).toBe("blue-500/50");
    expect(cfg.palette.blue.swatch).toBe("#1234ab");
    // other palette entries untouched
    expect(cfg.palette.primary.border).toBe("primary/20");
  });

  it("merges live-overlay hard-filter toggles", () => {
    const cfg = mergeConfig({ version: 5, hardFilters: { hidePartialStreaming: true } });
    expect(cfg.hardFilters.hidePartialStreaming).toBe(true);
    // Other fields keep their defaults
    expect(cfg.hardFilters.hideSubagentLifecycle).toBe(false);
    expect(cfg.hardFilters.hideHookLifecycle).toBe(false);
    expect(cfg.hardFilters.hideRateLimitNotices).toBe(false);
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
      version: 5,
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
      version: 5,
      typography: {
        header: { typeface: "comic-sans", size: "huge", weight: "ultra", italic: "sometimes" },
      },
    });
    expect(cfg.typography.header).toEqual(DEFAULT_TYPOGRAPHY.header);
  });

  it("returns defaults when typography is entirely absent", () => {
    const cfg = mergeConfig({ version: 5 });
    expect(cfg.typography).toEqual(DEFAULT_TYPOGRAPHY);
  });
});

// ─── typeface migration ───────────────────────────────────────────────────────

describe("typeface migration", () => {
  it("migrates legacy family: 'sans' to typeface: 'inter'", () => {
    const legacy = {
      ...JSON.parse(serializeConfig(createDefaultConfig())),
      typography: {
        header: { family: "sans", size: "sm", weight: "semibold", italic: false },
        content: { family: "sans", size: "sm", weight: "normal", italic: false },
        icon: { bordered: true, bgOpacity: 100 },
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
        icon: { bordered: true, bgOpacity: 100 },
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
        icon: { bordered: true, bgOpacity: 100 },
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
        icon: { bordered: true, bgOpacity: 100 },
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
        icon: { bordered: true, bgOpacity: 100 },
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
          icon: { bordered: true, bgOpacity: 100 },
        },
      };
      const cfg = parseConfig(JSON.stringify(legacy));
      expect(cfg.typography.header.typeface, `family=${JSON.stringify(garbage)}`).toBe("inter");
      expect(cfg.typography.content.typeface, `family=${JSON.stringify(garbage)}`).toBe("inter");
    }
  });
});

// ─── parse/serialize round-trip ───────────────────────────────────────────────

describe("parse/serialize round-trip", () => {
  it("round-trips a v5 config through JSON", () => {
    const original = createDefaultConfig();
    original.defaultViewMode = "compact";
    original.kinds["user.prompt"] = { headerLabel: "Greg" };
    const raw = serializeConfig(original);
    const restored = parseConfig(raw);
    expect(restored.defaultViewMode).toBe("compact");
    expect(restored.kinds["user.prompt"]).toEqual({ headerLabel: "Greg" });
    expect(resolveKind(restored, "user.prompt").headerLabel).toBe("Greg");
  });

  it("returns defaults for null/empty/invalid JSON", () => {
    expect(parseConfig(null).defaultViewMode).toBe("verbose");
    expect(parseConfig("").defaultViewMode).toBe("verbose");
    expect(parseConfig("{not json").defaultViewMode).toBe("verbose");
  });

  it("returns defaults (v5 reset) for a serialized v4 config", () => {
    // Simulate a v4 blob coming from localStorage
    const v4blob = JSON.stringify({ version: 4, overrides: [], categories: {} });
    const restored = parseConfig(v4blob);
    expect(restored.version).toBe(5);
    expect(restored.kinds).toEqual({});
  });
});

// ─── catalog coverage — every registered kind resolves to a style ─────────────

describe("kind registry", () => {
  it("has exactly the three real categories", () => {
    expect([...CATEGORIES]).toEqual(["user", "agent", "system"]);
  });

  it("registers every catalog kind under a real category", () => {
    for (const [id, def] of Object.entries(KIND_REGISTRY)) {
      expect(def.id).toBe(id);
      expect(CATEGORIES).toContain(def.category);
    }
  });

  it("categoryOf returns the registry category, falling back to system", () => {
    expect(categoryOf("permission.request")).toBe("system");
    expect(categoryOf("assistant.text")).toBe("agent");
    expect(categoryOf("user.prompt")).toBe("user");
    expect(categoryOf("totally.unknown.future.id")).toBe("system");
  });

  it("every kind in KIND_REGISTRY resolves to a category style with a presentation", () => {
    const cfg = createDefaultConfig();
    for (const id of Object.keys(KIND_REGISTRY)) {
      const s = resolveKind(cfg, id);
      expect(s.presentation, `no presentation for "${id}"`).toBeDefined();
    }
  });
});

// ─── category catalog ─────────────────────────────────────────────────────────

describe("category catalog (v5)", () => {
  it("defines exactly the three categories, each a complete style", () => {
    expect([...CATEGORIES].sort()).toEqual(["agent", "system", "user"]);
    for (const c of CATEGORIES) {
      const s = DEFAULT_CATEGORIES[c];
      expect(typeof s.presentation).toBe("string");
      expect(typeof s.accentColor).toBe("string");
      expect(typeof s.icon).toBe("string");
      expect(typeof s.borderStyle).toBe("string");
    }
  });

  it("system category defaults to hiddenInCompact: true", () => {
    expect(DEFAULT_CATEGORIES.system.hiddenInCompact).toBe(true);
  });

  it("user and agent categories default to hiddenInCompact: false", () => {
    expect(DEFAULT_CATEGORIES.user.hiddenInCompact).toBe(false);
    expect(DEFAULT_CATEGORIES.agent.hiddenInCompact).toBe(false);
  });
});

// ─── terminal ─────────────────────────────────────────────────────────────────

describe("terminal", () => {
  it("createDefaultConfig includes a terminal section with a mono typeface", () => {
    const cfg = createDefaultConfig();
    expect(cfg.terminal).toBeDefined();
    expect(typeof cfg.terminal.typeface).toBe("string");
  });

  it("returns independent terminal copies (no shared reference)", () => {
    const a = createDefaultConfig();
    const b = createDefaultConfig();
    a.terminal.typeface = "geist-mono";
    expect(b.terminal.typeface).not.toBe("geist-mono");
  });

  it("merges a saved terminal.typeface", () => {
    const cfg = mergeConfig({ version: 5, terminal: { typeface: "jetbrains-mono" } });
    expect(cfg.terminal.typeface).toBe("jetbrains-mono");
  });

  it("falls back to default when saved terminal.typeface is unknown", () => {
    const def = createDefaultConfig();
    const cfg = mergeConfig({ version: 5, terminal: { typeface: "not-a-real-font" } });
    expect(cfg.terminal.typeface).toBe(def.terminal.typeface);
  });

  it("falls back to default when terminal section is absent", () => {
    const def = createDefaultConfig();
    const cfg = mergeConfig({ version: 5 });
    expect(cfg.terminal.typeface).toBe(def.terminal.typeface);
  });

  it("round-trips terminal.typeface through serialize/parse", () => {
    const original = createDefaultConfig();
    original.terminal.typeface = "plex-mono";
    const restored = parseConfig(serializeConfig(original));
    expect(restored.terminal.typeface).toBe("plex-mono");
  });

  it("createDefaultConfig has a sane terminal fontSize and cursorStyle", () => {
    const cfg = createDefaultConfig();
    expect(typeof cfg.terminal.fontSize).toBe("number");
    expect(cfg.terminal.fontSize).toBeGreaterThanOrEqual(8);
    expect(cfg.terminal.fontSize).toBeLessThanOrEqual(32);
    expect(["block", "underline", "bar"]).toContain(cfg.terminal.cursorStyle);
  });

  it("merges a saved terminal.fontSize within the allowed range", () => {
    const cfg = mergeConfig({ version: 5, terminal: { fontSize: 16 } });
    expect(cfg.terminal.fontSize).toBe(16);
  });

  it("clamps an out-of-range terminal.fontSize", () => {
    // Way too small -> clamp up.
    expect(mergeConfig({ version: 5, terminal: { fontSize: 4 } }).terminal.fontSize)
      .toBeGreaterThanOrEqual(8);
    // Way too large -> clamp down.
    expect(mergeConfig({ version: 5, terminal: { fontSize: 200 } }).terminal.fontSize)
      .toBeLessThanOrEqual(32);
  });

  it("falls back to default when terminal.fontSize is not a number", () => {
    const def = createDefaultConfig();
    const cfg = mergeConfig({ version: 5, terminal: { fontSize: "thirteen" } });
    expect(cfg.terminal.fontSize).toBe(def.terminal.fontSize);
  });

  it("merges a saved terminal.cursorStyle", () => {
    expect(mergeConfig({ version: 5, terminal: { cursorStyle: "bar" } }).terminal.cursorStyle).toBe("bar");
    expect(mergeConfig({ version: 5, terminal: { cursorStyle: "underline" } }).terminal.cursorStyle).toBe("underline");
    expect(mergeConfig({ version: 5, terminal: { cursorStyle: "block" } }).terminal.cursorStyle).toBe("block");
  });

  it("falls back to default when terminal.cursorStyle is unknown", () => {
    const def = createDefaultConfig();
    const cfg = mergeConfig({ version: 5, terminal: { cursorStyle: "rainbow" } });
    expect(cfg.terminal.cursorStyle).toBe(def.terminal.cursorStyle);
  });

  it("round-trips fontSize and cursorStyle through serialize/parse", () => {
    const original = createDefaultConfig();
    original.terminal.fontSize = 15;
    original.terminal.cursorStyle = "bar";
    const restored = parseConfig(serializeConfig(original));
    expect(restored.terminal.fontSize).toBe(15);
    expect(restored.terminal.cursorStyle).toBe("bar");
  });
});

// ─── validateStyleField (via mergeConfig kinds path) ─────────────────────────

describe("validateStyleField (via kinds merge)", () => {
  it("accepts all valid icon names", () => {
    const cfg = mergeConfig({ version: 5, kinds: { "user.prompt": { icon: "Bot" } } });
    expect(resolveKind(cfg, "user.prompt").icon).toBe("Bot");
  });

  it("accepts headerLabel null (hides the header)", () => {
    const cfg = mergeConfig({ version: 5, kinds: { "user.prompt": { headerLabel: null } } });
    expect(resolveKind(cfg, "user.prompt").headerLabel).toBeNull();
  });

  it("accepts headerLabel string", () => {
    const cfg = mergeConfig({ version: 5, kinds: { "user.prompt": { headerLabel: "Greg" } } });
    expect(resolveKind(cfg, "user.prompt").headerLabel).toBe("Greg");
  });

  it("accepts hiddenInCompact boolean", () => {
    const cfg = mergeConfig({ version: 5, kinds: { "assistant.thinking": { hiddenInCompact: false } } });
    expect(resolveKind(cfg, "assistant.thinking").hiddenInCompact).toBe(false);
  });

  it("clamps iconBgOpacity to 0-100", () => {
    const cfg = mergeConfig({ version: 5, kinds: { "user.prompt": { iconBgOpacity: 150 } } });
    expect(cfg.kinds["user.prompt"]?.iconBgOpacity).toBe(100);
    const cfg2 = mergeConfig({ version: 5, kinds: { "user.prompt": { iconBgOpacity: -10 } } });
    expect(cfg2.kinds["user.prompt"]?.iconBgOpacity).toBe(0);
  });
});

// ─── tool-result kind id unification ─────────────────────────────────────────

it("registers user.tool-result and not the old duplicate id", () => {
  expect(KIND_REGISTRY["user.tool-result"]).toBeDefined();
  expect(KIND_REGISTRY["tool.result.generic"]).toBeUndefined();
});

// ─── resolveKind — special cases from the classifier ──────────────────────────

describe("resolveKind — classifier output coverage", () => {
  it("resolves summary.compaction, system.unknown, user.systemContext to styles", () => {
    const cfg = createDefaultConfig();
    for (const id of ["summary.compaction", "system.userPromptSubmit", "system.unknown", "user.systemContext"]) {
      expect(resolveKind(cfg, id).presentation).toBeDefined();
    }
  });

  it("resolves all system notification subtypes", () => {
    const cfg = createDefaultConfig();
    for (const id of [
      "system.notification.info",
      "system.notification.warn",
      "system.notification.error",
      "system.notification.stop",
    ]) {
      const s = resolveKind(cfg, id);
      expect(s.presentation).toBe("card");
    }
  });

  it("resolves permission kinds correctly", () => {
    const cfg = createDefaultConfig();
    expect(resolveKind(cfg, "permission.request").icon).toBe("ShieldQuestion");
    expect(resolveKind(cfg, "permission.askUserQuestion").icon).toBe("MessageCircleQuestion");
    expect(resolveKind(cfg, "permission.request").accentColor).toBe("amber");
    expect(resolveKind(cfg, "permission.askUserQuestion").accentColor).toBe("indigo");
  });

  it("future/unknown kind ids fall back to system category base", () => {
    const cfg = createDefaultConfig();
    const s = resolveKind(cfg, "totally.new.kind.in.future.version");
    expect(s.accentColor).toBe("muted");
    expect(s.alignment).toBe("left");
  });
});
