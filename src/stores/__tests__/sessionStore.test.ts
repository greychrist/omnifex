import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  api: {
    listProjects: vi.fn(),
    getProjectSessions: vi.fn(),
    getClaudeSessionOutput: vi.fn(),
  },
}));

import { useSessionStore } from "../sessionStore";
import { api } from "@/lib/api";
import type { Session, Project } from "@/lib/api";

const project = (id: string): Project => ({
  id,
  path: `/p/${id}`,
  sessions: [],
  created_at: 0,
});

const session = (id: string, projectId: string): Session => ({
  id,
  project_id: projectId,
  project_path: `/p/${projectId}`,
  todo_data: null,
  created_at: 0,
});

beforeEach(() => {
  vi.clearAllMocks();
  useSessionStore.setState({
    projects: [],
    sessions: {},
    currentSessionId: null,
    currentSession: null,
    sessionOutputs: {},
    isLoadingProjects: false,
    isLoadingSessions: false,
    isLoadingOutputs: false,
    error: null,
  });
});

describe("sessionStore.fetchProjects", () => {
  it("loads projects on success and clears loading", async () => {
    const projects = [project("a"), project("b")];
    (api.listProjects as ReturnType<typeof vi.fn>).mockResolvedValueOnce(projects);
    await useSessionStore.getState().fetchProjects();
    const s = useSessionStore.getState();
    expect(s.projects).toEqual(projects);
    expect(s.isLoadingProjects).toBe(false);
    expect(s.error).toBeNull();
  });

  it("captures error message on failure", async () => {
    (api.listProjects as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
    await useSessionStore.getState().fetchProjects();
    const s = useSessionStore.getState();
    expect(s.error).toBe("boom");
    expect(s.isLoadingProjects).toBe(false);
  });

  it("uses fallback message when error is non-Error", async () => {
    (api.listProjects as ReturnType<typeof vi.fn>).mockRejectedValueOnce("nope");
    await useSessionStore.getState().fetchProjects();
    expect(useSessionStore.getState().error).toBe("Failed to fetch projects");
  });
});

describe("sessionStore.fetchProjectSessions", () => {
  it("stores sessions keyed by projectId", async () => {
    const sessions = [session("s1", "p1"), session("s2", "p1")];
    (api.getProjectSessions as ReturnType<typeof vi.fn>).mockResolvedValueOnce(sessions);
    await useSessionStore.getState().fetchProjectSessions("p1");
    const s = useSessionStore.getState();
    expect(s.sessions.p1).toEqual(sessions);
    expect(s.isLoadingSessions).toBe(false);
  });

  it("captures error on failure", async () => {
    (api.getProjectSessions as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("xx"));
    await useSessionStore.getState().fetchProjectSessions("p1");
    expect(useSessionStore.getState().error).toBe("xx");
  });

  it("uses fallback message on non-Error rejection", async () => {
    (api.getProjectSessions as ReturnType<typeof vi.fn>).mockRejectedValueOnce("bad");
    await useSessionStore.getState().fetchProjectSessions("p1");
    expect(useSessionStore.getState().error).toBe("Failed to fetch sessions");
  });
});

describe("sessionStore.setCurrentSession", () => {
  it("looks up session across all projects and sets currentSession", () => {
    const sA = session("sA", "p1");
    const sB = session("sB", "p2");
    useSessionStore.setState({ sessions: { p1: [sA], p2: [sB] } });
    useSessionStore.getState().setCurrentSession("sB");
    expect(useSessionStore.getState().currentSession).toEqual(sB);
    expect(useSessionStore.getState().currentSessionId).toBe("sB");
  });

  it("clears currentSession when given null", () => {
    const sA = session("sA", "p1");
    useSessionStore.setState({ sessions: { p1: [sA] }, currentSession: sA, currentSessionId: "sA" });
    useSessionStore.getState().setCurrentSession(null);
    const s = useSessionStore.getState();
    expect(s.currentSession).toBeNull();
    expect(s.currentSessionId).toBeNull();
  });

  it("sets currentSession to null when sessionId not found", () => {
    useSessionStore.setState({ sessions: { p1: [session("sA", "p1")] } });
    useSessionStore.getState().setCurrentSession("missing");
    expect(useSessionStore.getState().currentSession).toBeNull();
    expect(useSessionStore.getState().currentSessionId).toBe("missing");
  });
});

describe("sessionStore.fetchSessionOutput", () => {
  it("stores fetched output keyed by sessionId", async () => {
    (api.getClaudeSessionOutput as ReturnType<typeof vi.fn>).mockResolvedValueOnce("hello");
    await useSessionStore.getState().fetchSessionOutput("s1");
    expect(useSessionStore.getState().sessionOutputs.s1).toBe("hello");
    expect(useSessionStore.getState().isLoadingOutputs).toBe(false);
  });

  it("captures error on failure", async () => {
    (api.getClaudeSessionOutput as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("oops"));
    await useSessionStore.getState().fetchSessionOutput("s1");
    expect(useSessionStore.getState().error).toBe("oops");
  });

  it("uses fallback message on non-Error rejection", async () => {
    (api.getClaudeSessionOutput as ReturnType<typeof vi.fn>).mockRejectedValueOnce(123);
    await useSessionStore.getState().fetchSessionOutput("s1");
    expect(useSessionStore.getState().error).toBe("Failed to fetch session output");
  });
});

describe("sessionStore.deleteSession", () => {
  it("removes session from sessions map", async () => {
    const s1 = session("s1", "p1");
    const s2 = session("s2", "p1");
    useSessionStore.setState({ sessions: { p1: [s1, s2] } });
    await useSessionStore.getState().deleteSession("s1", "p1");
    expect(useSessionStore.getState().sessions.p1).toEqual([s2]);
  });

  it("clears currentSession when deleting the active session", async () => {
    const s1 = session("s1", "p1");
    useSessionStore.setState({
      sessions: { p1: [s1] },
      currentSession: s1,
      currentSessionId: "s1",
    });
    await useSessionStore.getState().deleteSession("s1", "p1");
    const s = useSessionStore.getState();
    expect(s.currentSession).toBeNull();
    expect(s.currentSessionId).toBeNull();
  });

  it("preserves currentSession when deleting a different session", async () => {
    const s1 = session("s1", "p1");
    const s2 = session("s2", "p1");
    useSessionStore.setState({
      sessions: { p1: [s1, s2] },
      currentSession: s1,
      currentSessionId: "s1",
    });
    await useSessionStore.getState().deleteSession("s2", "p1");
    expect(useSessionStore.getState().currentSession).toEqual(s1);
  });

  it("removes sessionOutputs entry for deleted session", async () => {
    useSessionStore.setState({
      sessions: { p1: [session("s1", "p1")] },
      sessionOutputs: { s1: "out1", s2: "out2" },
    });
    await useSessionStore.getState().deleteSession("s1", "p1");
    expect(useSessionStore.getState().sessionOutputs).toEqual({ s2: "out2" });
  });

  it("handles missing project gracefully", async () => {
    await useSessionStore.getState().deleteSession("s1", "missing");
    expect(useSessionStore.getState().sessions.missing).toEqual([]);
  });
});

describe("sessionStore.clearError", () => {
  it("clears error state", () => {
    useSessionStore.setState({ error: "something" });
    useSessionStore.getState().clearError();
    expect(useSessionStore.getState().error).toBeNull();
  });
});

describe("sessionStore.handleSessionUpdate", () => {
  it("appends a new session at the front of the project list", () => {
    const existing = session("s1", "p1");
    useSessionStore.setState({ sessions: { p1: [existing] } });
    const incoming = session("s2", "p1");
    useSessionStore.getState().handleSessionUpdate(incoming);
    expect(useSessionStore.getState().sessions.p1).toEqual([incoming, existing]);
  });

  it("updates an existing session in place", () => {
    const existing = session("s1", "p1");
    useSessionStore.setState({ sessions: { p1: [existing] } });
    const updated = { ...existing, todo_data: { foo: 1 } } as unknown as Session;
    useSessionStore.getState().handleSessionUpdate(updated);
    expect(useSessionStore.getState().sessions.p1).toEqual([updated]);
  });

  it("starts a new project list when project has no prior sessions", () => {
    const incoming = session("s1", "p_new");
    useSessionStore.getState().handleSessionUpdate(incoming);
    expect(useSessionStore.getState().sessions.p_new).toEqual([incoming]);
  });

  it("updates currentSession when the active session is updated", () => {
    const original = session("s1", "p1");
    useSessionStore.setState({
      sessions: { p1: [original] },
      currentSession: original,
      currentSessionId: "s1",
    });
    const updated = { ...original, todo_data: { foo: 1 } } as unknown as Session;
    useSessionStore.getState().handleSessionUpdate(updated);
    expect(useSessionStore.getState().currentSession).toEqual(updated);
  });

  it("leaves currentSession alone for a non-active session update", () => {
    const active = session("s1", "p1");
    useSessionStore.setState({
      sessions: { p1: [active] },
      currentSession: active,
      currentSessionId: "s1",
    });
    useSessionStore.getState().handleSessionUpdate(session("s2", "p1"));
    expect(useSessionStore.getState().currentSession).toEqual(active);
  });
});

describe("sessionStore.handleOutputUpdate", () => {
  it("merges output into sessionOutputs", () => {
    useSessionStore.setState({ sessionOutputs: { a: "1" } });
    useSessionStore.getState().handleOutputUpdate("b", "2");
    expect(useSessionStore.getState().sessionOutputs).toEqual({ a: "1", b: "2" });
  });

  it("overwrites existing entry for same sessionId", () => {
    useSessionStore.setState({ sessionOutputs: { a: "1" } });
    useSessionStore.getState().handleOutputUpdate("a", "new");
    expect(useSessionStore.getState().sessionOutputs).toEqual({ a: "new" });
  });
});
