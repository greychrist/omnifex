import { useState, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import { Bot, FolderCode } from "lucide-react";
import { api, type Project, type Session } from "@/lib/api";
import { TabProvider, useTabContext } from "@/contexts/TabContext";
import { AccountsProvider } from "@/contexts/AccountsContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { AppFontProvider } from "@/contexts/AppFontContext";
import { AutoScrollProvider } from "@/contexts/AutoScrollContext";
import { SessionGaugesProvider } from "@/contexts/SessionGaugesContext";
import { MessageRenderingProvider } from "@/contexts/MessageRenderingContext";
import { useNotifications } from "@/hooks/useNotifications";
import { Card } from "@/components/ui/card";
import { ProjectList } from "@/components/ProjectList";
import { FilePicker } from "@/components/FilePicker";
import { SessionList } from "@/components/SessionList";
import { CustomTitlebar, type CliReviewLaunchRequest } from "@/components/CustomTitlebar";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { Settings } from "@/components/Settings";
import { MCPManager } from "@/components/MCPManager";
import { ClaudeBinaryDialog } from "@/components/ClaudeBinaryDialog";
import { AccountPickerDialog } from "@/components/AccountPickerDialog";
import { Toast, ToastContainer } from "@/components/ui/toast";
import { TabManager } from "@/components/TabManager";
import { TabContent } from "@/components/TabContent";
import { RemoteConnectionBanner, PushEnableBar } from "@/components/RemoteConnectionBanner";
import { useLayoutMode } from "@/hooks/useLayoutMode";
import { useKeyboardInset } from "@/hooks/useKeyboardInset";
import { deepLinkedSessionId } from "@/lib/remote/push";
import { useTabState } from "@/hooks/useTabState";
import { StartupIntro } from "@/components/StartupIntro";
import { fireAndLog, logAndForget } from "@/lib/fireAndLog";
import { buildCliReviewLaunch } from "@/lib/cliReviewLaunch";
import { seedInitialSettingsTab } from '@/lib/settingsInitialTab';
import { APP_ROOT_HEIGHT } from '@/lib/viewport';

type View = 
  | "welcome" 
  | "projects" 
  | "editor"
  | "settings"
  | "cc-agents"
  | "create-agent"
  | "github-agents"
  | "agent-execution"
  | "agent-run-view"
  | "mcp"
  | "tabs";

function AppContent() {
  const [view, setView] = useState<View>("tabs");
  const { createSettingsTab, createLimaTab, createBrainTab, createCostReportTab } = useTabState();
  const { tabs, activeTabId, setActiveTab, updateTab, addTab } = useTabContext();
  // Called for the subscription: the root starts the store that mirrors `omnifex-narrow`/`-touch`/`-web` onto <html>.
  useLayoutMode();
  useKeyboardInset();
  useNotifications(activeTabId, setActiveTab, updateTab);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [_error, setError] = useState<string | null>(null);
  const [showClaudeBinaryDialog, setShowClaudeBinaryDialog] = useState(false);
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [homeDirectory, setHomeDirectory] = useState<string>('/');
  const [showAccountPicker, setShowAccountPicker] = useState(false);
  const [pendingProjectPath, setPendingProjectPath] = useState<string>("");
  const [toast, setToast] = useState<{
    message: string;
    type: "success" | "error" | "info";
    action?: { label: string; onClick: () => void };
    duration?: number;
  } | null>(null);

  useEffect(() => {
    if (view === "projects") {
      logAndForget('app:load-projects', loadProjects());
    } else if (view === "welcome") {
      setLoading(false);
    }
  }, [view]);

  useEffect(() => {
    const lastShown = { key: '', at: 0 };
    const DEDUPE_MS = 2000;
    const unsubscribe = window.electronAPI.onEvent('log-error', (payload: unknown) => {
      const e = payload as { source: string; message: string; category?: string | null };
      if (!e || typeof e.message !== 'string') return;
      const key = `${e.source}::${e.message}`;
      const now = Date.now();
      if (key === lastShown.key && now - lastShown.at < DEDUPE_MS) return;
      lastShown.key = key;
      lastShown.at = now;
      const preview = e.message.split('\n')[0].slice(0, 120);
      setToast({
        type: 'error',
        message: `[${e.source}] ${preview}`,
        duration: 6000,
        action: {
          label: 'View in Log',
          onClick: () => {
            setToast(null);
            // The seed carries a cold open (lazy Settings is not listening yet); the event only reaches a mounted Settings.
            seedInitialSettingsTab('log');
            createSettingsTab();
            setTimeout(() => {
              window.dispatchEvent(new CustomEvent('log:focus-error-view'));
            }, 0);
          },
        },
      });
    });
    return unsubscribe;
  }, [createSettingsTab]);

  useEffect(() => {
    if (view !== "tabs") return;
    
    const handleKeyDown = (e: KeyboardEvent) => {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- navigator.userAgentData is not yet universally available; navigator.platform is the reliable cross-browser fallback for macOS detection.
      const isMac = navigator.platform.toUpperCase().includes('MAC');
      const modKey = isMac ? e.metaKey : e.ctrlKey;
      
      if (modKey) {
        switch (e.key) {
          case 't':
            e.preventDefault();
            window.dispatchEvent(new CustomEvent('create-chat-tab'));
            break;
          case 'w':
            e.preventDefault();
            window.dispatchEvent(new CustomEvent('close-current-tab'));
            break;
          case '[':
            e.preventDefault();
            window.dispatchEvent(new CustomEvent('switch-to-previous-tab'));
            break;
          case ']':
            e.preventDefault();
            window.dispatchEvent(new CustomEvent('switch-to-next-tab'));
            break;
          case 'Tab':
            e.preventDefault();
            if (e.shiftKey) {
              window.dispatchEvent(new CustomEvent('switch-to-previous-tab'));
            } else {
              window.dispatchEvent(new CustomEvent('switch-to-next-tab'));
            }
            break;
          default:
            if (e.key >= '1' && e.key <= '9') {
              e.preventDefault();
              const index = parseInt(e.key) - 1;
              window.dispatchEvent(new CustomEvent('switch-to-tab-by-index', { detail: { index } }));
            }
            break;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => { window.removeEventListener('keydown', handleKeyDown); };
  }, [view]);

  // A Web Push notification tap lands on `/#session=<id>`.
  useEffect(() => {
    const client = window.__omnifexRemote?.client;
    if (!client) return;
    let cancelled = false;
    const open = async () => {
      const id = deepLinkedSessionId();
      if (!id) return;
      const existing = tabs.find((t) => t.type === 'chat' && t.sessionId === id);
      if (existing) {
        setActiveTab(existing.id);
        setView('tabs');
        return;
      }
      try {
        const [sessions, projects] = await Promise.all([
          client.request('session.list', {}),
          client.request('project.list', {}),
        ]);
        if (cancelled) return;
        const summary = sessions.find((s) => s.sessionId === id);
        const project = summary ? projects.find((p) => p.projectId === summary.projectId) : undefined;
        if (!summary || !project) return;
        const tabId = addTab({
          type: 'chat',
          title: summary.title ?? project.title ?? 'Session',
          agent: summary.agent,
          sessionId: id,
          initialProjectPath: project.path,
          status: 'idle',
          hasUnsavedChanges: false,
          icon: 'message-square',
        });
        setActiveTab(tabId);
        setView('tabs');
      } catch (err) {
        console.warn('[remote] deep link failed:', err);
      } finally {
        if (location.hash.includes('session=')) history.replaceState(null, '', location.pathname + location.search);
      }
    };
    void open();
    const onHash = () => { void open(); };
    window.addEventListener('hashchange', onHash);
    return () => { cancelled = true; window.removeEventListener('hashchange', onHash); };
    // Runs once per hash change; `tabs` is read fresh inside via closure at call time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handleClaudeNotFound = () => {
      setShowClaudeBinaryDialog(true);
    };

    window.addEventListener('claude-not-found', handleClaudeNotFound);
    return () => {
      window.removeEventListener('claude-not-found', handleClaudeNotFound);
    };
  }, []);


  const loadProjects = async () => {
    try {
      setLoading(true);
      setError(null);
      const projectList = await api.listProjects();
      setProjects(projectList);
    } catch (err) {
      console.error("Failed to load projects:", err);
      setError("Failed to load projects. Please ensure ~/.claude directory exists.");
    } finally {
      setLoading(false);
    }
  };

  const handleProjectClick = async (project: Project) => {
    try {
      setLoading(true);
      setError(null);
      const sessionList = await api.getProjectSessions(project.id, project.path);
      setSessions(sessionList);
      setSelectedProject(project);
    } catch (err) {
      console.error("Failed to load sessions:", err);
      const code = (err as { code?: string } | null)?.code;
      const msg = err instanceof Error ? err.message : String(err);
      if (code === 'NO_ACCOUNT_FOR_PROJECT') {
        setError(
          `No Claude account is configured for "${project.path}". ` +
          `Open Account Settings to add a path rule or project override, ` +
          `then reopen the project.`,
        );
        setToast({ type: 'error', message: 'No Claude account for this project — open Account Settings to bind one.' });
      } else {
        setError(`Failed to load sessions: ${msg}`);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleTogglePin = async (project: Project, pinned: boolean) => {
    const previous = projects;
    setProjects((prev) =>
      prev.map((p) => (p.id === project.id ? { ...p, pinned } : p)),
    );
    try {
      await api.setProjectPinned(project.path, pinned);
    } catch (err) {
      console.error('Failed to toggle project pin:', err);
      setProjects(previous);
      const msg = err instanceof Error ? err.message : String(err);
      setToast({ type: 'error', message: `Failed to ${pinned ? 'pin' : 'unpin'} project: ${msg}` });
      void loadProjects();
    }
  };

  const handleRefreshSessions = async () => {
    if (!selectedProject) return;
    try {
      const sessionList = await api.getProjectSessions(
        selectedProject.id,
        selectedProject.path,
      );
      setSessions(sessionList);
    } catch (err) {
      console.error("Failed to refresh sessions:", err);
    }
  };

  const handleOpenProject = async () => {
    const homeDir = await api.getHomeDirectory();
    setHomeDirectory(homeDir);
    setShowProjectPicker(true);
  };

  // Unrouted: the tab opens without auto-start, never on a default account.
  const handleCliReviewLaunch = useCallback(
    (request: CliReviewLaunchRequest) => {
      logAndForget('app:cli-review-launch', (async () => {
        const pair = await api.resolveAccountForProject(request.repoDir).catch(() => ({
          claude: null,
          codex: null,
        }));
        const { tab } = buildCliReviewLaunch({
          repoDir: request.repoDir,
          reviewedVersion: request.reviewedVersion,
          installedVersion: request.installedVersion,
          pair,
        });
        setView('tabs');
        setActiveTab(addTab(tab));
      })());
    },
    [addTab, setActiveTab],
  );

  const handleViewChange = (newView: View) => {
    setView(newView);
  };


  const renderContent = () => {
    switch (view) {
      case "welcome":
        return (
          <div className="flex items-center justify-center p-4" style={{ height: "100%" }}>
            <div className="w-full max-w-4xl">
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.15 }}
                className="mb-12 text-center"
              >
                <h1 className="text-4xl font-bold tracking-tight">
                  <span className="rotating-symbol"></span>
                  Welcome to OmniFex
                </h1>
              </motion.div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-2xl mx-auto">
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.15, delay: 0.05 }}
                >
                  <Card 
                    className="h-64 cursor-pointer transition-all duration-200 hover:scale-105 hover:shadow-lg border border-border/50 shimmer-hover trailing-border"
                    onClick={() => { handleViewChange("cc-agents"); }}
                  >
                    <div className="h-full flex flex-col items-center justify-center p-8">
                      <Bot className="h-16 w-16 mb-4 text-primary" />
                      <h2 className="text-xl font-semibold">CC Agents</h2>
                    </div>
                  </Card>
                </motion.div>

                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.15, delay: 0.1 }}
                >
                  <Card 
                    className="h-64 cursor-pointer transition-all duration-200 hover:scale-105 hover:shadow-lg border border-border/50 shimmer-hover trailing-border"
                    onClick={() => { handleViewChange("projects"); }}
                  >
                    <div className="h-full flex flex-col items-center justify-center p-8">
                      <FolderCode className="h-16 w-16 mb-4 text-primary" />
                      <h2 className="text-xl font-semibold">Projects</h2>
                    </div>
                  </Card>
                </motion.div>

              </div>
            </div>
          </div>
        );

      case "editor":
        return (
          <div className="flex-1 overflow-hidden">
            <MarkdownEditor onBack={() => { handleViewChange("welcome"); }} />
          </div>
        );
      
      case "settings":
        return <Settings onBack={() => { handleViewChange("welcome"); }} />;
      
      case "projects":
        if (selectedProject) {
          return (
            <SessionList
              sessions={sessions}
              projectPath={selectedProject.path}
              onRefresh={handleRefreshSessions}
            />
          );
        }
        return (
          <ProjectList
            projects={projects}
            onProjectClick={fireAndLog('app:project-click', handleProjectClick)}
            onOpenProject={handleOpenProject}
            onTogglePin={handleTogglePin}
            loading={loading}
          />
        );
      
      case "tabs":
        return (
          <div className="h-full flex flex-col">
            {/* Present at every width: hiding it when narrow strands every other open tab. */}
            <TabManager className="flex-shrink-0" />
            <div className="flex-1 overflow-hidden">
              <TabContent />
            </div>
          </div>
        );
      
      case "mcp":
        return (
          <MCPManager onBack={() => { handleViewChange("welcome"); }} />
        );
      
      default:
        return null;
    }
  };

  return (
    <div className={`${APP_ROOT_HEIGHT} flex flex-col`}>
      <CustomTitlebar
        onLimaClick={() => createLimaTab()}
        onBrainClick={() => createBrainTab()}
        onCostClick={() => createCostReportTab()}
        onSettingsClick={() => createSettingsTab()}
        onCliReviewClick={handleCliReviewLaunch}
      />
      <RemoteConnectionBanner />
      <PushEnableBar />

      <div className="flex-1 overflow-hidden">
        {renderContent()}
      </div>


      <ClaudeBinaryDialog
        open={showClaudeBinaryDialog}
        onOpenChange={setShowClaudeBinaryDialog}
        onSuccess={() => {
          setToast({ message: "Claude binary path saved successfully", type: "success" });
          window.location.reload();
        }}
        onError={(message) => { setToast({ message, type: "error" }); }}
      />

      {showProjectPicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="w-full max-w-2xl h-[600px] bg-background border rounded-lg shadow-lg">
            <FilePicker
              basePath={homeDirectory}
              onSelect={fireAndLog('app:select', async (entry) => {
                if (entry.is_directory) {
                  try {
                    // All-null pair: ask for an account; never a silent default.
                    const pair = await api.resolveAccountForProject(entry.path);
                    if (pair.claude === null && pair.codex === null) {
                      setPendingProjectPath(entry.path);
                      setShowProjectPicker(false);
                      setShowAccountPicker(true);
                      return;
                    }
                    const project = await api.createProject(entry.path);
                    setShowProjectPicker(false);
                    await loadProjects();
                    await handleProjectClick(project);
                  } catch (err) {
                    console.error('Failed to create project:', err);
                    setError('Failed to create project for the selected directory.');
                  }
                }
              })}
              onClose={() => { setShowProjectPicker(false); }}
            />
          </div>
        </div>
      )}

      <AccountPickerDialog
        open={showAccountPicker}
        onOpenChange={setShowAccountPicker}
        projectPath={pendingProjectPath}
        onAccountSelected={fireAndLog('app:account-selected', async () => {
          try {
            const project = await api.createProject(pendingProjectPath);
            await loadProjects();
            await handleProjectClick(project);
          } catch (err) {
            console.error('Failed to create project after account selection:', err);
            setError('Failed to create project for the selected directory.');
          }
        })}
      />
      
      <ToastContainer>
        {toast && (
          <Toast
            message={toast.message}
            type={toast.type}
            duration={toast.duration}
            action={toast.action}
            onDismiss={() => { setToast(null); }}
          />
        )}
      </ToastContainer>

    </div>
  );
}

function App() {
  const [showIntro, setShowIntro] = useState(() => {
    try {
      const cached = typeof window !== 'undefined'
        ? window.localStorage.getItem('app_setting:startup_intro_enabled')
        : null;
      if (cached === 'true') return true;
      if (cached === 'false') return false;
    // eslint-disable-next-line no-empty -- empty block intentional (no-op cleanup / placeholder).
    } catch (_ignore) {}
    return true;
  });

  useEffect(() => {
    let timer: number | undefined;
    logAndForget('app:iife', (async () => {
      try {
        const pref = await api.getSetting('startup_intro_enabled');
        const enabled = pref === null ? true : pref === 'true';
        if (enabled) {
          timer = window.setTimeout(() => { setShowIntro(false); }, 2000);
        } else {
          setShowIntro(false);
        }
      } catch {
        timer = window.setTimeout(() => { setShowIntro(false); }, 2000);
      }
    })());
    return () => {
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  return (
    <AppFontProvider>
      <AutoScrollProvider>
        <SessionGaugesProvider>
        <ThemeProvider>
          <MessageRenderingProvider>
            <AccountsProvider>
              <TabProvider>
                <AppContent />
                <StartupIntro visible={showIntro} />
              </TabProvider>
            </AccountsProvider>
          </MessageRenderingProvider>
        </ThemeProvider>
        </SessionGaugesProvider>
      </AutoScrollProvider>
    </AppFontProvider>
  );
}

export default App;
