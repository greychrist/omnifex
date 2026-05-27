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
import { classifyStandaloneKind } from "../messageKind";
import type { JsonlNode } from "@/types/jsonl";

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

    it("locks exactly the two always-visible kinds (v2 catalog)", () => {
      // v2 catalog: user.prompt (turn opener) and unknown (diagnostic catch-all —
      // if it shows up, we must not hide it) are boundary-locked. The result.*
      // kinds have been removed from the catalog; cli-stream-result is not locked.
      const locked = DEFAULT_KINDS.filter((k) => k.compactBoundaryLocked).map((k) => k.id).sort();
      expect(locked).toEqual([
        "unknown",
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

    it("persists presentation, borderStyle, and showRawPayload through merge", () => {
      const persisted = {
        version: 2,
        kinds: {
          "user.prompt": { presentation: "side-line", borderStyle: "dashed" },
          "unknown": { showRawPayload: false },
        },
      };
      const merged = mergeConfig(persisted);
      expect(merged.kinds["user.prompt"].presentation).toBe("side-line");
      expect(merged.kinds["user.prompt"].borderStyle).toBe("dashed");
      expect(merged.kinds["unknown"].showRawPayload).toBe(false);
    });

    it("rejects invalid presentation and borderStyle values", () => {
      const cfg = mergeConfig({
        kinds: {
          "user.prompt": { presentation: "balloon", borderStyle: "dotted" },
        },
      });
      // Falls back to defaults
      expect(cfg.kinds["user.prompt"].presentation).toBe("card");
      expect(cfg.kinds["user.prompt"].borderStyle).toBe("solid");
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

    it("merges live-overlay hard-filter toggles", () => {
      const cfg = mergeConfig({ hardFilters: { hidePartialStreaming: true } });
      expect(cfg.hardFilters.hidePartialStreaming).toBe(true);
      // Other fields keep their defaults
      expect(cfg.hardFilters.hideSubagentLifecycle).toBe(false);
      expect(cfg.hardFilters.hideHookLifecycle).toBe(false);
      expect(cfg.hardFilters.hideRateLimitNotices).toBe(false);
    });

    it("migrates legacy hardFilter keys (dropTaskLifecycle → hideSubagentLifecycle, dropHookLifecycle → hideHookLifecycle)", () => {
      const legacyConfig = {
        version: 2,
        hardFilters: {
          dropMeta: false,
          dropTaskLifecycle: false,
          dropHookLifecycle: false,
        },
      };
      const merged = mergeConfig(legacyConfig as any);
      expect(merged.hardFilters.hideSubagentLifecycle).toBe(false);
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

  describe("catalog coverage — every classifyStandaloneKind output has a DEFAULT_KINDS entry", () => {
    const kindIds = new Set(DEFAULT_KINDS.map((k) => k.id));

    // Helper factories to exercise classifyStandaloneKind paths
    const sys = (subtype: string): JsonlNode =>
      ({ kind: 'system', subtype, sessionId: '', receivedAt: '', raw: { type: 'system', subtype } }) as unknown as JsonlNode;
    const att = (subtype?: string): JsonlNode =>
      ({ kind: 'attachment', sessionId: '', receivedAt: '', raw: { type: 'attachment', attachment: subtype ? { type: subtype } : {} } }) as unknown as JsonlNode;
    const notif = (notification_type: string): JsonlNode =>
      ({ kind: 'system', subtype: 'notification', sessionId: '', receivedAt: '', raw: { type: 'system', subtype: 'notification', notification_type, body: 'm' } }) as unknown as JsonlNode;
    const permReq = (toolName?: string): JsonlNode =>
      ({ kind: 'unknown', sessionId: '', receivedAt: '', raw: { type: 'permission_request', tool_name: toolName } }) as unknown as JsonlNode;
    const summaryNode = (): JsonlNode =>
      ({ kind: 'unknown', sessionId: '', receivedAt: '', raw: { type: 'summary', leafUuid: 'leaf-1', summary: 'sum' } }) as unknown as JsonlNode;

    // Collect all kind IDs the classifier can actually emit
    const produced: string[] = [
      // system subtypes
      classifyStandaloneKind(sys('hook_started'), [])!,
      classifyStandaloneKind(sys('hook_response'), [])!,
      classifyStandaloneKind(sys('permission_denied'), [])!,
      classifyStandaloneKind(sys('user_prompt_submit'), [])!,
      classifyStandaloneKind(sys('anything_else'), [])!, // system.unknown
      // notification subtypes
      classifyStandaloneKind(notif('error'), [])!,
      classifyStandaloneKind(notif('stop'), [])!,
      classifyStandaloneKind(notif('warn'), [])!,
      classifyStandaloneKind(notif('info'), [])!,
      // attachment subtypes
      classifyStandaloneKind(att('todo_reminder'), [])!,
      classifyStandaloneKind(att('task_reminder'), [])!,
      classifyStandaloneKind(att('diagnostics'), [])!,
      classifyStandaloneKind(att('command_permissions'), [])!,
      classifyStandaloneKind(att('skill_listing'), [])!,
      classifyStandaloneKind(att('deferred_tools_delta'), [])!,
      classifyStandaloneKind(att('mcp_instructions_delta'), [])!,
      classifyStandaloneKind(att('hook_success'), [])!,
      classifyStandaloneKind(att('hook_additional_context'), [])!,
      classifyStandaloneKind(att('edited_text_file'), [])!,
      classifyStandaloneKind(att('nested_memory'), [])!,
      classifyStandaloneKind(att('queued_command'), [])!,
      classifyStandaloneKind(att('auto_mode'), [])!,
      classifyStandaloneKind(att('hook_blocking_error'), [])!,
      classifyStandaloneKind(att('date_change'), [])!,
      classifyStandaloneKind(att('ultrathink_effort'), [])!,
      classifyStandaloneKind(att('plan_mode_exit'), [])!,
      classifyStandaloneKind(att('file'), [])!,
      classifyStandaloneKind(att('compact_file_reference'), [])!,
      classifyStandaloneKind(att('invoked_skills'), [])!,
      classifyStandaloneKind(att(undefined), [])!, // attachment.unknown
      // permission + summary
      classifyStandaloneKind(permReq('Bash'), [])!,
      classifyStandaloneKind(permReq('AskUserQuestion'), [])!,
      classifyStandaloneKind(summaryNode(), [])!,
    ].filter(Boolean);

    it('every kind ID produced by classifyStandaloneKind exists in DEFAULT_KINDS', () => {
      for (const id of produced) {
        expect(kindIds, `Missing catalog entry for kind: "${id}"`).toContain(id);
      }
    });

    it('summary.compaction is in the catalog', () => {
      expect(kindIds).toContain('summary.compaction');
    });

    it('system.userPromptSubmit is in the catalog', () => {
      expect(kindIds).toContain('system.userPromptSubmit');
    });

    it('system.unknown is in the catalog', () => {
      expect(kindIds).toContain('system.unknown');
    });

    it('user.systemContext is in the catalog', () => {
      expect(kindIds).toContain('user.systemContext');
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

    it("createDefaultConfig has a sane terminal fontSize and cursorStyle", () => {
      const cfg = createDefaultConfig();
      expect(typeof cfg.terminal.fontSize).toBe("number");
      expect(cfg.terminal.fontSize).toBeGreaterThanOrEqual(8);
      expect(cfg.terminal.fontSize).toBeLessThanOrEqual(32);
      expect(["block", "underline", "bar"]).toContain(cfg.terminal.cursorStyle);
    });

    it("merges a saved terminal.fontSize within the allowed range", () => {
      const cfg = mergeConfig({ terminal: { fontSize: 16 } });
      expect(cfg.terminal.fontSize).toBe(16);
    });

    it("clamps an out-of-range terminal.fontSize", () => {
      // Way too small → clamp up.
      expect(mergeConfig({ terminal: { fontSize: 4 } }).terminal.fontSize)
        .toBeGreaterThanOrEqual(8);
      // Way too large → clamp down.
      expect(mergeConfig({ terminal: { fontSize: 200 } }).terminal.fontSize)
        .toBeLessThanOrEqual(32);
    });

    it("falls back to default when terminal.fontSize is not a number", () => {
      const def = createDefaultConfig();
      const cfg = mergeConfig({ terminal: { fontSize: "thirteen" } });
      expect(cfg.terminal.fontSize).toBe(def.terminal.fontSize);
    });

    it("merges a saved terminal.cursorStyle", () => {
      expect(mergeConfig({ terminal: { cursorStyle: "bar" } }).terminal.cursorStyle).toBe("bar");
      expect(mergeConfig({ terminal: { cursorStyle: "underline" } }).terminal.cursorStyle).toBe("underline");
      expect(mergeConfig({ terminal: { cursorStyle: "block" } }).terminal.cursorStyle).toBe("block");
    });

    it("falls back to default when terminal.cursorStyle is unknown", () => {
      const def = createDefaultConfig();
      const cfg = mergeConfig({ terminal: { cursorStyle: "rainbow" } });
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
});
