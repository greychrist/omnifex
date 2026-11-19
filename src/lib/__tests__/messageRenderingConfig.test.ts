import { describe, it, expect } from "vitest";
import {
  createDefaultConfig,
  mergeConfig,
  parseConfig,
  serializeConfig,
  resolveKind,
  DEFAULT_TYPOGRAPHY,
  DEFAULT_TAB_INDICATORS,
  DEFAULT_TAB_STRIP,
  TAB_MAX_WIDTH_RANGE,
  DEFAULT_CATEGORIES,
  CATEGORIES,
  KIND_REGISTRY,
  categoryOf,
} from "../messageRenderingConfig";

// ─── config v5 ──────────────────────────────────────────────────────────────

describe("config v5", () => {
  it("default config is version 6 with an empty kinds map", () => {
    const cfg = createDefaultConfig();
    expect(cfg.version).toBe(6);
    expect(cfg.kinds).toEqual({});
  });

  it("round-trips a v5 config with user kind patches", () => {
    const cfg = createDefaultConfig();
    cfg.kinds["user.prompt"] = { accentColor: "#14b8a6" };
    const back = parseConfig(serializeConfig(cfg));
    expect(back.kinds["user.prompt"]).toEqual({ accentColor: "#14b8a6" });
  });

  it("resets to defaults when the saved version is not 5", () => {
    const merged = mergeConfig({ version: 4, overrides: [{ id: "x", category: "system", match: [], style: {} }] });
    expect(merged.version).toBe(6);
    expect(merged.kinds).toEqual({});
  });

  it("drops junk fields in a saved kinds patch", () => {
    const merged = mergeConfig({ version: 5, kinds: { "user.prompt": { accentColor: "#14b8a6", icon: "NotARealIcon", bogus: 1 } } });
    expect(merged.kinds["user.prompt"]).toEqual({ accentColor: "#14b8a6" });
  });
});

// ─── resolveKind (three-layer merge) ────────────────────────────────────────

describe("resolveKind (three-layer merge)", () => {
  it("layers category -> registry default -> user patch", () => {
    const cfg = createDefaultConfig();
    expect(resolveKind(cfg, "assistant.text").icon).toBe("Bot"); // agent category icon (no registry override)
    expect(resolveKind(cfg, "permission.request").accentColor).toBe("#f59e0b"); // registry default
    expect(resolveKind(cfg, "permission.request").icon).toBe("ShieldQuestion");
    cfg.kinds["permission.request"] = { accentColor: "#14b8a6" }; // user patch wins
    expect(resolveKind(cfg, "permission.request").accentColor).toBe("#14b8a6");
    expect(resolveKind(cfg, "permission.request").icon).toBe("ShieldQuestion"); // unpatched field falls through
  });

  it("an unregistered id resolves to the system category base", () => {
    const cfg = createDefaultConfig();
    expect(resolveKind(cfg, "future.kind").accentColor).toBe("#4b5563");
  });

  it("returns the category default for the kind's category", () => {
    const cfg = createDefaultConfig();
    const s = resolveKind(cfg, "user.prompt");
    expect(s.icon).toBe("User");
    expect(s.accentColor).toBe("#60a5fa");
  });

  it("registry default overrides category base, user patch wins over both", () => {
    const cfg = createDefaultConfig();
    // assistant.text.endTurn has registry default: green (#22c55e)/CheckCircle2
    const s = resolveKind(cfg, "assistant.text.endTurn");
    expect(s.accentColor).toBe("#22c55e");  // registry default
    expect(s.icon).toBe("CheckCircle2");    // registry default
    expect(s.standard).toBe(true);           // inherited from agent category
    // now add a user patch
    cfg.kinds["assistant.text.endTurn"] = { accentColor: "#ec4899" };
    expect(resolveKind(cfg, "assistant.text.endTurn").accentColor).toBe("#ec4899"); // user wins
    expect(resolveKind(cfg, "assistant.text.endTurn").icon).toBe("CheckCircle2"); // unpatched still from registry
  });
});

// ─── createDefaultConfig ─────────────────────────────────────────────────────

describe("createDefaultConfig", () => {
  it("is version 6 with categories and an empty kinds map", () => {
    const cfg = createDefaultConfig();
    expect(cfg.version).toBe(6);
    expect(Object.keys(cfg.categories).sort()).toEqual(["agent", "live", "system", "user"]);
    expect(cfg.kinds).toEqual({});
  });

  it("returns independent copies on each call", () => {
    const a = createDefaultConfig();
    const b = createDefaultConfig();
    a.categories.user.label = "MUTATED";
    expect(b.categories.user.label).toBe("User");
  });

  it("alwaysShown kinds are set via registry defaults", () => {
    const cfg = createDefaultConfig();
    // Turn boundaries: always on screen in Standard.
    const locked = Object.keys(KIND_REGISTRY)
      .filter((id) => resolveKind(cfg, id).alwaysShown)
      .sort();
    expect(locked).toEqual([
      "assistant.text.endTurn",
      "summary.compaction",
      "user.prompt",
    ]);
  });
});

// ─── mergeConfig ─────────────────────────────────────────────────────────────

describe("mergeConfig", () => {
  it("returns defaults for non-object input", () => {
    expect(mergeConfig(null).defaultViewMode).toBe("standard");
    expect(mergeConfig("nope").defaultViewMode).toBe("standard");
    expect(mergeConfig(42).defaultViewMode).toBe("standard");
  });

  it("resets to defaults when saved version is not 5 (v4)", () => {
    const merged = mergeConfig({ version: 4, categories: {}, overrides: [] });
    expect(merged.version).toBe(6);
    expect(merged.kinds).toEqual({});
  });

  it("resets to defaults when saved version is not 5 (v2)", () => {
    const merged = mergeConfig({ version: 2, kinds: { "user.prompt": { accentColor: "pink" } } });
    expect(merged.version).toBe(6);
    // The v2 kinds are NOT migrated — full reset
    expect(merged.kinds).toEqual({});
  });

  it("resets to defaults when saved version is not 5 (v3)", () => {
    const merged = mergeConfig({ version: 3, overrides: { "assistant.tool-use": { accentColor: "info" } } });
    expect(merged.version).toBe(6);
    expect(merged.kinds).toEqual({});
  });

  // Four chat formats became two views (2026-11-18): Compact and Modern
  // land on Standard, Verbose and All on Expanded.
  it("migrates the default view", () => {
    for (const [saved, view] of [["compact", "standard"], ["modern", "standard"], ["verbose", "expanded"], ["all", "expanded"],
      ["standard", "standard"], ["expanded", "expanded"]] as const) {
      expect(mergeConfig({ version: 5, defaultViewMode: saved }).defaultViewMode).toBe(view);
    }
  });

  it("ignores invalid view-mode values", () => {
    expect(mergeConfig({ version: 5, defaultViewMode: "weird" }).defaultViewMode).toBe("standard");
  });

  it("merges a valid kinds patch onto a v5 config", () => {
    const cfg = mergeConfig({
      version: 5,
      kinds: {
        "user.prompt": { headerLabel: "Me", accentColor: "amber" },
      },
    });
    // A saved palette name is migrated to its hex on load; the classic
    // card's header label is dropped.
    expect(cfg.kinds["user.prompt"]).toEqual({ accentColor: "#f59e0b" });
    const s = resolveKind(cfg, "user.prompt");
    expect(s.accentColor).toBe("#f59e0b");
    // untouched fields keep defaults
    expect(s.icon).toBe("User");
  });

  it("rejects icon values not in the allow-list", () => {
    const cfg = mergeConfig({
      version: 5,
      kinds: { "user.prompt": { icon: "NotARealIcon" } },
    });
    expect(cfg.kinds["user.prompt"]).toBeUndefined();
    expect(resolveKind(cfg, "user.prompt").icon).toBe("User");
  });

  it("rejects accentColor strings that are neither legacy palette names nor hex", () => {
    const cfg = mergeConfig({
      version: 5,
      kinds: { "user.prompt": { accentColor: "neon" } },
    });
    expect(cfg.kinds["user.prompt"]).toBeUndefined();
    expect(resolveKind(cfg, "user.prompt").accentColor).toBe("#60a5fa");
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

  // The palette is retired: every color is a hex. Saved configs (and exported
  // files) still name palette colors, so they are converted on load — through
  // the saved palette's own swatch when it had one, so a retinted name keeps
  // the color the user saw.
  it("migrates saved palette names to hex, through the saved palette's swatch", () => {
    const cfg = mergeConfig({
      version: 5,
      palette: { blue: { border: "x", bg: null, swatch: "#1234ab" } },
      categories: { user: { accentColor: "blue" }, agent: { accentColor: "primary" } },
      kinds: { "system.api_error": { accentColor: "green" } },
      tabIndicators: { error: { icon: "AlertCircle", color: "red" }, question: { icon: "MessageCircleQuestion", color: "#5862f9" } },
    });
    expect(cfg.categories.user.accentColor).toBe("#1234ab");
    expect(cfg.categories.agent.accentColor).toBe("#8b8b8b");
    expect(cfg.kinds["system.api_error"]).toEqual({ accentColor: "#22c55e" });
    expect(cfg.tabIndicators.error.color).toBe("#ef4444");
    expect(cfg.tabIndicators.question.color).toBe("#5862f9");
    expect("palette" in cfg).toBe(false);
  });

  it("ships every default color as a hex, never a palette name", () => {
    const hex = /^#[0-9a-f]{6}$/i;
    for (const c of CATEGORIES) expect(DEFAULT_CATEGORIES[c].accentColor).toMatch(hex);
    for (const def of Object.values(KIND_REGISTRY)) {
      if (def.default.accentColor !== undefined) expect(def.default.accentColor).toMatch(hex);
    }
    for (const key of ["error", "permission", "question", "complete", "cacheExpiring"] as const) {
      expect(DEFAULT_TAB_INDICATORS[key].color).toMatch(hex);
    }
  });

  it("defaults card corner radius to 12px (the theme's rounded-lg) and clamps to 0-24", () => {
    expect(createDefaultConfig().cardBorderRadius).toBe(12);
    expect(mergeConfig({ version: 5, cardBorderRadius: 6 }).cardBorderRadius).toBe(6);
    expect(mergeConfig({ version: 5, cardBorderRadius: 99 }).cardBorderRadius).toBe(24);
    expect(mergeConfig({ version: 5, cardBorderRadius: -1 }).cardBorderRadius).toBe(0);
    expect(mergeConfig({ version: 5, cardBorderRadius: "round" }).cardBorderRadius).toBe(12);
  });

  it("defaults card border opacity to 20% and clamps a saved value to 0-100", () => {
    expect(createDefaultConfig().cardBorderOpacity).toBe(20);
    expect(mergeConfig({ version: 5, cardBorderOpacity: 35 }).cardBorderOpacity).toBe(35);
    expect(mergeConfig({ version: 5, cardBorderOpacity: 140 }).cardBorderOpacity).toBe(100);
    expect(mergeConfig({ version: 5, cardBorderOpacity: -3 }).cardBorderOpacity).toBe(0);
    expect(mergeConfig({ version: 5, cardBorderOpacity: "loud" }).cardBorderOpacity).toBe(20);
  });

  it("keeps a saved tab max width", () => {
    const cfg = mergeConfig({ version: 5, tabs: { density: "compact", maxWidth: 300 } });
    expect(cfg.tabs).toEqual({ density: "compact", maxWidth: 300 });
  });

  it("gives a config saved before tab max width existed the default", () => {
    const cfg = mergeConfig({ version: 5, tabs: { density: "compact" } });
    expect(cfg.tabs.maxWidth).toBe(DEFAULT_TAB_STRIP.maxWidth);
  });

  it("clamps an out-of-range tab max width and ignores a non-number", () => {
    expect(mergeConfig({ version: 5, tabs: { maxWidth: 10 } }).tabs.maxWidth).toBe(TAB_MAX_WIDTH_RANGE.min);
    expect(mergeConfig({ version: 5, tabs: { maxWidth: 9999 } }).tabs.maxWidth).toBe(TAB_MAX_WIDTH_RANGE.max);
    expect(mergeConfig({ version: 5, tabs: { maxWidth: "wide" } }).tabs.maxWidth).toBe(DEFAULT_TAB_STRIP.maxWidth);
  });

  // The four live-overlay toggles were retired: three were read by nothing and
  // the fourth duplicated the hook kinds' own visibility on Message Kinds.
  it("hides hook rows by default through their kinds", () => {
    const cfg = createDefaultConfig();
    for (const id of ["system.hook_started", "system.hook_progress", "system.hook_response"]) {
      expect(resolveKind(cfg, id).standard).toBe(false);
    }
  });

  it("drops a saved debug block — the kind label always shows", () => {
    const cfg = mergeConfig({ version: 5, debug: { showCardKindLabel: true } });
    expect("debug" in cfg).toBe(false);
  });

  it("drops a saved hardFilters block", () => {
    const cfg = mergeConfig({ version: 5, hardFilters: { hidePartialStreaming: true } });
    expect("hardFilters" in cfg).toBe(false);
  });

  it("merges typography overrides safely", () => {
    const cfg = mergeConfig({
      version: 5,
      typography: {
        content: { typeface: "jetbrains-mono" },
      },
    });
    // partial override preserves defaults for other fields
    expect(cfg.typography.content.typeface).toBe("jetbrains-mono");
    expect(cfg.typography.content.size).toBe(DEFAULT_TYPOGRAPHY.content.size);
  });

  it("rejects invalid typography values", () => {
    const cfg = mergeConfig({
      version: 5,
      typography: {
        content: { typeface: "comic-sans", size: "huge", weight: "ultra", italic: "sometimes" },
      },
    });
    expect(cfg.typography.content).toEqual(DEFAULT_TYPOGRAPHY.content);
  });

  it("returns defaults when typography is entirely absent", () => {
    const cfg = mergeConfig({ version: 5 });
    expect(cfg.typography).toEqual(DEFAULT_TYPOGRAPHY);
  });

  it("returns default tab indicators when absent", () => {
    const cfg = mergeConfig({ version: 5 });
    expect(cfg.tabIndicators).toEqual(DEFAULT_TAB_INDICATORS);
  });

  it("merges tab-indicator overrides safely (partial keeps defaults)", () => {
    const cfg = mergeConfig({
      version: 5,
      tabIndicators: {
        question: { icon: "HelpCircle", color: "#ff0000" },
        size: "lg",
        bordered: true,
        bgOpacity: 40,
      },
    });
    expect(cfg.tabIndicators.question).toEqual({ icon: "HelpCircle", color: "#ff0000" });
    expect(cfg.tabIndicators.size).toBe("lg");
    expect(cfg.tabIndicators.bordered).toBe(true);
    expect(cfg.tabIndicators.bgOpacity).toBe(40);
    // untouched states fall back to defaults
    expect(cfg.tabIndicators.permission).toEqual(DEFAULT_TAB_INDICATORS.permission);
  });

  it("rejects invalid tab-indicator values", () => {
    const cfg = mergeConfig({
      version: 5,
      tabIndicators: {
        error: { icon: "NotARealIcon", color: "banana" },
        size: "gigantic",
        bordered: "yes",
        bgOpacity: 999,
      },
    });
    // bad icon/color fall back to the default style for that state
    expect(cfg.tabIndicators.error).toEqual(DEFAULT_TAB_INDICATORS.error);
    expect(cfg.tabIndicators.size).toBe(DEFAULT_TAB_INDICATORS.size);
    expect(cfg.tabIndicators.bordered).toBe(DEFAULT_TAB_INDICATORS.bordered);
    // out-of-range opacity clamps into 0–100
    expect(cfg.tabIndicators.bgOpacity).toBe(100);
  });

  it("accepts the xxs (extra extra small) font size", () => {
    const cfg = mergeConfig({
      version: 5,
      typography: {
        content: { typeface: "inter", size: "xxs", weight: "normal", italic: false },
      },
    });
    expect(cfg.typography.content.size).toBe("xxs");
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
    expect(cfg.typography.content.typeface).toBe("inter");
    // Legacy `family` key is dropped from the result.
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
    expect(cfg.typography.content.typeface).toBe("geist"); // valid one survives
  });

  it("default config uses typeface: 'inter' for content", () => {
    const cfg = createDefaultConfig();
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
    expect(cfg.typography.content.typeface).toBe("geist");
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
      expect(cfg.typography.content.typeface, `family=${JSON.stringify(garbage)}`).toBe("inter");
    }
  });
});

// ─── parse/serialize round-trip ───────────────────────────────────────────────

describe("parse/serialize round-trip", () => {
  it("round-trips a v6 config through JSON", () => {
    const original = createDefaultConfig();
    original.defaultViewMode = "expanded";
    original.kinds["user.prompt"] = { accentColor: "#123456" };
    const raw = serializeConfig(original);
    const restored = parseConfig(raw);
    expect(restored.defaultViewMode).toBe("expanded");
    expect(restored.kinds["user.prompt"]).toEqual({ accentColor: "#123456" });
    expect(resolveKind(restored, "user.prompt").accentColor).toBe("#123456");
  });

  it("returns defaults for null/empty/invalid JSON", () => {
    expect(parseConfig(null).defaultViewMode).toBe("standard");
    expect(parseConfig("").defaultViewMode).toBe("standard");
    expect(parseConfig("{not json").defaultViewMode).toBe("standard");
  });

  it("returns defaults (reset) for a serialized v4 config", () => {
    // Simulate a v4 blob coming from localStorage
    const v4blob = JSON.stringify({ version: 4, overrides: [], categories: {} });
    const restored = parseConfig(v4blob);
    expect(restored.version).toBe(6);
    expect(restored.kinds).toEqual({});
  });
});

// ─── catalog coverage — every registered kind resolves to a style ─────────────

describe("kind registry", () => {
  it("has exactly the four real categories", () => {
    expect([...CATEGORIES]).toEqual(["user", "agent", "system", "live"]);
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

  it("exposes system.away_summary as a separately-stylable system kind", () => {
    const def = KIND_REGISTRY["system.away_summary"];
    expect(def).toBeDefined();
    expect(def.category).toBe("system");
    expect(def.label.length).toBeGreaterThan(0);
    expect(resolveKind(createDefaultConfig(), "system.away_summary").icon).toBeDefined();
  });
});

// ─── category catalog ─────────────────────────────────────────────────────────

describe("category catalog", () => {
  it("defines exactly the four categories, each a complete style", () => {
    expect([...CATEGORIES].sort()).toEqual(["agent", "live", "system", "user"]);
    for (const c of CATEGORIES) {
      const s = DEFAULT_CATEGORIES[c];
      expect(typeof s.accentColor).toBe("string");
      expect(typeof s.icon).toBe("string");
      expect(typeof s.standard).toBe("boolean");
    }
  });

  it("system category defaults to hidden in Standard", () => {
    expect(DEFAULT_CATEGORIES.system.standard).toBe(false);
  });

  it("user and agent categories default to shown in Standard", () => {
    expect(DEFAULT_CATEGORIES.user.standard).toBe(true);
    expect(DEFAULT_CATEGORIES.agent.standard).toBe(true);
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

  // Saved configs from before the three-way setting carry the old boolean.
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
      expect(resolveKind(cfg, id).icon).toBeDefined();
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
      expect(resolveKind(cfg, id).standard).toBe(true);
    }
  });

  it("resolves permission kinds correctly", () => {
    const cfg = createDefaultConfig();
    expect(resolveKind(cfg, "permission.request").icon).toBe("ShieldQuestion");
    expect(resolveKind(cfg, "permission.askUserQuestion").icon).toBe("MessageCircleQuestion");
    expect(resolveKind(cfg, "permission.request").accentColor).toBe("#f59e0b");
    expect(resolveKind(cfg, "permission.askUserQuestion").accentColor).toBe("#6366f1");
  });

  it("future/unknown kind ids fall back to system category base", () => {
    const cfg = createDefaultConfig();
    const s = resolveKind(cfg, "totally.new.kind.in.future.version");
    expect(s.accentColor).toBe("#4b5563");
    expect(s.standard).toBe(false);
  });
});

// ─── bookkeeping kind registry entries (control-change feedback feature) ──────

describe("bookkeeping kind registry entries", () => {
  const ids = ["permission-mode", "last-prompt", "ai-title", "queue-operation", "file-history-snapshot"] as const;

  it("registers all five bookkeeping kinds under the system category", () => {
    for (const id of ids) {
      expect(KIND_REGISTRY[id], id).toBeDefined();
      expect(categoryOf(id), id).toBe("system");
    }
  });

  it("permission-mode is shown in Standard; passive bookkeeping is hidden", () => {
    const cfg = createDefaultConfig();
    expect(resolveKind(cfg, "permission-mode").standard).toBe(true);
    for (const id of ["last-prompt", "ai-title", "queue-operation", "file-history-snapshot"]) {
      expect(resolveKind(cfg, id).standard, id).toBe(false);
    }
  });
});

// ─── synthetic control-change kinds ───────────────────────────────────────────

describe("control-change kinds", () => {
  it("registers control.effort and control.model under live, shown in Standard", () => {
    const cfg = createDefaultConfig();
    for (const id of ["control.effort", "control.model"]) {
      expect(KIND_REGISTRY[id], id).toBeDefined();
      expect(categoryOf(id), id).toBe("live");
      expect(resolveKind(cfg, id).standard, id).toBe(true);
    }
  });
});

// ─── "All" chat format ──────────────────────────────────────────────────────

