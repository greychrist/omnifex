import { describe, it, expect } from "vitest";
import {
  createDefaultConfig,
  mergeConfig,
  parseConfig,
  serializeConfig,
  resolveKind,
  resolveMessageStyle,
  DEFAULT_PALETTE,
  DEFAULT_TYPOGRAPHY,
  DEFAULT_CATEGORIES,
  DEFAULT_OVERRIDES,
  CATEGORIES,
  KNOWN_KIND_IDS,
  originOf,
  type MessageRenderingConfig,
  type Override,
} from "../messageRenderingConfig";
import { classifyStandaloneKind } from "../messageKind";
import type { JsonlNode } from "@/types/jsonl";

// In v4 overrides are message-matched, not id-keyed. The default overrides are
// `$kind eq <id>` rules, so resolving a kind's *effective* style means cascading
// against a message whose `$kind` is that id. A bare `{ raw: {} }` message is
// enough for the synthetic `$kind` path to fire.
function styleForKind(cfg: MessageRenderingConfig, id: string) {
  return resolveMessageStyle(cfg, { raw: {} } as unknown as JsonlNode, id);
}
function findOverride(cfg: MessageRenderingConfig, id: string): Override | undefined {
  return cfg.overrides.find((o) => o.id === id);
}

describe("messageRenderingConfig", () => {
  describe("createDefaultConfig (v4)", () => {
    it("is version 4 with categories + an override-rule array", () => {
      const cfg = createDefaultConfig();
      expect(cfg.version).toBe(4);
      expect(Object.keys(cfg.categories).sort())
        .toEqual(["agent", "attachment", "bookkeeping", "system", "user"]);
      expect(Array.isArray(cfg.overrides)).toBe(true);
      expect(findOverride(cfg, "assistant.text.endTurn")).toBeDefined();
      // The flat catalog is gone.
      expect((cfg as unknown as { kinds?: unknown }).kinds).toBeUndefined();
    });

    it("includes every category and keeps overrides sparse", () => {
      const cfg = createDefaultConfig();
      for (const c of CATEGORIES) {
        expect(cfg.categories[c].presentation).toBeDefined();
      }
      expect(cfg.overrides.length).toBeLessThan(25);
    });

    it("every default override is a $kind matcher scoped to its origin category", () => {
      const cfg = createDefaultConfig();
      for (const o of cfg.overrides) {
        expect(o.category).toBe(originOf(o.id));
        expect(o.match).toEqual([{ path: "$kind", op: "eq", value: o.id }]);
      }
    });

    it("defaults user.systemContext to the collapsible presentation with raw-payload metadata", () => {
      const cfg = createDefaultConfig();
      const s = styleForKind(cfg, "user.systemContext");
      expect(s.presentation).toBe("collapsible");
      expect(s.showRawPayload).toBe(true);
    });

    it("returns independent copies on each call", () => {
      const a = createDefaultConfig();
      const b = createDefaultConfig();
      a.categories.user.headerLabel = "MUTATED";
      expect(b.categories.user.headerLabel).toBe("You");
    });
  });

  describe("resolveKind (category base only)", () => {
    const cfg = createDefaultConfig();
    it("returns the category default for the kind's origin", () => {
      const s = resolveKind(cfg, "user.prompt");
      expect(s.alignment).toBe("right");
      expect(s.headerLabel).toBe("You");
      expect(s.presentation).toBe("card");
    });
    it("ignores overrides — it is the pure base, not the cascade", () => {
      // assistant.text.endTurn has a default override (green / CheckCircle2),
      // but resolveKind returns only the agent category base.
      const s = resolveKind(cfg, "assistant.text.endTurn");
      expect(s.headerLabel).toBe("Claude");
      expect(s.accentColor).toBe("primary"); // agent base, NOT the override's green
      expect(s.icon).toBe("Bot");
    });
    it("resolves an unseen kind to its category (no unknown)", () => {
      const s = resolveKind(cfg, "attachment.workflow_keyword_request");
      expect(s.presentation).toBe("collapsible"); // attachment default
    });
  });

  describe("resolveMessageStyle (full cascade)", () => {
    const cfg = createDefaultConfig();
    it("applies the matching $kind override over its category, per-field", () => {
      const s = styleForKind(cfg, "assistant.text.endTurn");
      expect(s.headerLabel).toBe("Claude");   // inherited from agent
      expect(s.accentColor).toBe("green");     // from override
      expect(s.icon).toBe("CheckCircle2");     // from override
    });
  });

  describe("mergeConfig v2->v4 migration", () => {
    it("carries a user-customized v2 kind into a $kind override rule", () => {
      const v2 = { version: 2, kinds: {
        "user.prompt": { id: "user.prompt", presentation: "side-line", accentColor: "pink" },
      } };
      const cfg = mergeConfig(v2);
      expect(cfg.version).toBe(4);
      const ov = findOverride(cfg, "user.prompt");
      expect(ov?.match).toEqual([{ path: "$kind", op: "eq", value: "user.prompt" }]);
      expect(ov?.style).toMatchObject({ presentation: "side-line", accentColor: "pink" });
    });
    it("does not create an override for a v2 kind left at its defaults", () => {
      // assistant.text has no default override and its sole field matches the
      // agent category, so no rule is produced for it.
      const v2 = { version: 2, kinds: { "assistant.text": { id: "assistant.text" } } };
      const cfg = mergeConfig(v2);
      expect(findOverride(cfg, "assistant.text")).toBeUndefined();
    });
  });

  describe("mergeConfig v3->v4 migration", () => {
    it("converts each v3 record override 1:1 into a $kind rule, dropping none", () => {
      const v3 = {
        version: 3,
        overrides: {
          "assistant.tool-use": { label: "Tool call", accentColor: "info", icon: "Terminal" },
          "pr-link": { accentColor: "teal" },
        },
      };
      const cfg = mergeConfig(v3);
      expect(cfg.version).toBe(4);

      const tool = findOverride(cfg, "assistant.tool-use");
      expect(tool).toBeDefined();
      expect(tool?.label).toBe("Tool call");
      expect(tool?.category).toBe("agent");
      expect(tool?.match).toEqual([{ path: "$kind", op: "eq", value: "assistant.tool-use" }]);
      expect(tool?.style).toMatchObject({ accentColor: "info", icon: "Terminal" });

      const pr = findOverride(cfg, "pr-link");
      expect(pr?.category).toBe("bookkeeping");
      expect(pr?.style).toMatchObject({ accentColor: "teal" });
      expect(pr?.label).toBe("pr-link"); // falls back to id when no label saved

      // One rule per original override — nothing lost, nothing duplicated.
      expect(cfg.overrides).toHaveLength(2);
      // Behaviour is identical: the $kind rule reproduces the old exact-id match.
      expect(styleForKind(cfg, "assistant.tool-use").accentColor).toBe("info");
    });

    it("accepts a v4 config unchanged (round-trips its override array)", () => {
      const v4 = createDefaultConfig();
      v4.overrides.push({
        id: "custom-1", label: "Custom", category: "system",
        match: [{ path: "subtype", op: "eq", value: "notification" }],
        style: { accentColor: "teal" },
      });
      const merged = mergeConfig(v4);
      const custom = findOverride(merged, "custom-1");
      expect(custom?.match).toEqual([{ path: "subtype", op: "eq", value: "notification" }]);
      expect(custom?.style).toMatchObject({ accentColor: "teal" });
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

    it("merges a partial v2 kind override into a $kind rule (resolves correctly)", () => {
      const cfg = mergeConfig({
        version: 2,
        kinds: {
          "user.prompt": { headerLabel: "Me", accentColor: "amber" },
        },
      });
      const s = styleForKind(cfg, "user.prompt");
      expect(s.headerLabel).toBe("Me");
      expect(s.accentColor).toBe("amber");
      // untouched fields keep category defaults
      expect(s.icon).toBe("User");
      expect(s.alignment).toBe("right");
    });

    it("rejects icon values not in the allow-list (v2 migration)", () => {
      const cfg = mergeConfig({
        version: 2,
        kinds: { "user.prompt": { icon: "NotARealIcon" } },
      });
      expect(styleForKind(cfg, "user.prompt").icon).toBe("User");
    });

    it("rejects accentColor strings that are neither palette names nor hex", () => {
      const cfg = mergeConfig({
        version: 2,
        kinds: { "user.prompt": { accentColor: "neon" } },
      });
      expect(styleForKind(cfg, "user.prompt").accentColor).toBe("blue");
    });

    it("accepts hex accentColor strings (picker-driven configs)", () => {
      for (const hex of ["#a855f7", "#abc", "#aabbccdd"]) {
        const cfg = mergeConfig({
          version: 2,
          kinds: { "user.prompt": { accentColor: hex } },
        });
        expect(styleForKind(cfg, "user.prompt").accentColor).toBe(hex);
      }
    });

    it("seeds the always-visible boundary-locked kinds by default", () => {
      // user.prompt (turn opener), assistant.text.endTurn (turn closer), and
      // unknown (diagnostic catch-all) resolve to compactBoundaryLocked via
      // their seeded overrides.
      const cfg = createDefaultConfig();
      const locked = KNOWN_KIND_IDS
        .filter((id) => styleForKind(cfg, id).compactBoundaryLocked)
        .sort();
      expect(locked).toEqual([
        "assistant.text.endTurn",
        "summary.compaction",
        "unknown",
        "user.prompt",
      ]);
    });

    it("honors hiddenInCompact toggles on non-boundary kinds (v2 migration)", () => {
      const cfg = mergeConfig({
        version: 2,
        kinds: { "assistant.thinking": { hiddenInCompact: false } },
      });
      expect(styleForKind(cfg, "assistant.thinking").hiddenInCompact).toBe(false);
    });

    it("persists presentation, borderStyle, and showRawPayload through v2 migration", () => {
      const persisted = {
        version: 2,
        kinds: {
          "user.prompt": { presentation: "side-line", borderStyle: "dashed" },
          "system.away_summary": { showRawPayload: true },
        },
      };
      const merged = mergeConfig(persisted);
      expect(styleForKind(merged, "user.prompt").presentation).toBe("side-line");
      expect(styleForKind(merged, "user.prompt").borderStyle).toBe("dashed");
      expect(styleForKind(merged, "system.away_summary").showRawPayload).toBe(true);
    });

    it("rejects invalid presentation and borderStyle values (v2 migration)", () => {
      const cfg = mergeConfig({
        version: 2,
        kinds: {
          "user.prompt": { presentation: "balloon", borderStyle: "dotted" },
        },
      });
      // Invalid values are dropped; resolves to category defaults.
      expect(styleForKind(cfg, "user.prompt").presentation).toBe("card");
      expect(styleForKind(cfg, "user.prompt").borderStyle).toBe("solid");
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

  describe("parse/serialize round-trip", () => {
    it("round-trips a config through JSON", () => {
      const original = createDefaultConfig();
      original.defaultViewMode = "compact";
      const promptOverride = findOverride(original, "user.prompt");
      promptOverride!.style = { ...promptOverride!.style, headerLabel: "Greg" };
      const raw = serializeConfig(original);
      const restored = parseConfig(raw);
      expect(restored.defaultViewMode).toBe("compact");
      expect(styleForKind(restored, "user.prompt").headerLabel).toBe("Greg");
    });

    it("returns defaults for null/empty/invalid JSON", () => {
      expect(parseConfig(null).defaultViewMode).toBe("verbose");
      expect(parseConfig("").defaultViewMode).toBe("verbose");
      expect(parseConfig("{not json").defaultViewMode).toBe("verbose");
    });
  });

  describe("catalog coverage — every classifyStandaloneKind output resolves to a category style", () => {
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

    it('every classifier kind id resolves to a category style', () => {
      const cfg = createDefaultConfig();
      for (const id of produced) {
        const s = resolveKind(cfg, id);
        expect(s.presentation, `no presentation for "${id}"`).toBeDefined();
        expect(originOf(id), `no origin for "${id}"`).toBeDefined();
      }
    });

    it('resolves summary.compaction, system.unknown, user.systemContext to styles', () => {
      const cfg = createDefaultConfig();
      for (const id of ['summary.compaction', 'system.userPromptSubmit', 'system.unknown', 'user.systemContext']) {
        expect(resolveKind(cfg, id).presentation).toBeDefined();
      }
    });
  });

  describe("v3 category catalog", () => {
    it("defines exactly the five categories, each a complete style", () => {
      expect([...CATEGORIES].sort()).toEqual(
        ["agent", "attachment", "bookkeeping", "system", "user"]);
      for (const c of CATEGORIES) {
        const s = DEFAULT_CATEGORIES[c];
        expect(typeof s.presentation).toBe("string");
        expect(typeof s.accentColor).toBe("string");
        expect(typeof s.icon).toBe("string");
        expect(typeof s.borderStyle).toBe("string");
      }
    });

    it("keeps overrides sparse (partial styles, ~a dozen, not 60+)", () => {
      const ids = DEFAULT_OVERRIDES.map((o) => o.id);
      expect(ids).toContain("assistant.text.endTurn");
      expect(ids).toContain("user.systemContext");
      expect(ids).toContain("permission.askUserQuestion");
      expect(ids.length).toBeLessThan(25);
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

  describe("originOf", () => {
    it("maps dotted prefixes to categories", () => {
      expect(originOf("user.prompt")).toBe("user");
      expect(originOf("assistant.text.endTurn")).toBe("agent");
      expect(originOf("system.notification.error")).toBe("system");
      expect(originOf("attachment.todo_reminder")).toBe("attachment");
    });
    it("maps standalone bookkeeping ids", () => {
      expect(originOf("pr-link")).toBe("bookkeeping");
      expect(originOf("last-prompt")).toBe("bookkeeping");
      expect(originOf("queue-operation")).toBe("bookkeeping");
    });
    it("maps cli envelopes + summary to system, permission to system", () => {
      expect(originOf("cli-stream-init")).toBe("system");
      expect(originOf("cli-stream-result")).toBe("system");
      expect(originOf("permission.request")).toBe("system");
    });
    it("defaults unknown ids to system (never throws)", () => {
      expect(originOf("totally.new.kind")).toBe("system");
    });
  });
});
