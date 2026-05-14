import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Bot, FolderCode } from "lucide-react";
import { api, type Project, type Session } from "@/lib/api";
import { TabProvider, useTabContext } from "@/contexts/TabContext";
import { AccountsProvider } from "@/contexts/AccountsContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { AppFontProvider } from "@/contexts/AppFontContext";
import { MessageRenderingProvider } from "@/contexts/MessageRenderingContext";
import { useNotifications } from "@/hooks/useNotifications";
import { Card } from "@/components/ui/card";
import { ProjectList } from "@/components/ProjectList";
import { FilePicker } from "@/components/FilePicker";
import { SessionList } from "@/components/SessionList";
import { CustomTitlebar } from "@/components/CustomTitlebar";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { Settings } from "@/components/Settings";
import { MCPManager } from "@/components/MCPManager";
import { ClaudeBinaryDialog } from "@/components/ClaudeBinaryDialog";
import { AccountPickerDialog } from "@/components/AccountPickerDialog";
import { Toast, ToastContainer } from "@/components/ui/toast";
import { ProjectSettings } from '@/components/ProjectSettings';
import { TabManager } from "@/components/TabManager";
import { TabContent } from "@/components/TabContent";
import { useTabState } from "@/hooks/useTabState";
import { StartupIntro } from "@/components/StartupIntro";
import { fireAndLog } from "@/lib/fireAndLog";

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
  | "project-settings"
  | "tabs"; // New view for tab-based interface

/**
 * AppContent component - Contains the main app logic, wrapped by providers
 */
function AppContent() {
  const [view, setView] = useState<View>("tabs");
  const { createSettingsTab, createLimaTab, createUsageTab } = useTabState();
  const { activeTabId, setActiveTab, updateTab } = useTabContext();
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
  const [projectForSettings, setProjectForSettings] = useState<Project | null>(null);
  const [previousView] = useState<View>("welcome");

  // Load projects on mount when in projects view
  useEffect(() => {
    if (view === "projects") {
      loadProjects();
    } else if (view === "welcome") {
      // Reset loading state for welcome view
      setLoading(false);
    }
  }, [view]);

  // Subscribe to error-level log entries from the main process so the user
  // can correlate "the app just flashed an error" with whatever they were
  // doing. Suppression is handled main-side via `log_error_toast_enabled`;
  // we additionally dedupe here so repeated identical errors within a short
  // window only flash one toast instead of stacking.
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
      // Trim long lines — single-line preview keeps the toast compact.
      const preview = e.message.split('\n')[0].slice(0, 120);
      setToast({
        type: 'error',
        message: `[${e.source}] ${preview}`,
        // 6s gives time to read + reach the action button.
        duration: 6000,
        action: {
          label: 'View in Log',
          onClick: () => {
            setToast(null);
            createSettingsTab();
            // Settings + LogTab both listen for this and switch their
            // inner state in unison. Dispatched asynchronously so the
            // Settings tab has mounted by the time the listeners fire.
            setTimeout(() => {
              window.dispatchEvent(new CustomEvent('log:focus-error-view'));
            }, 0);
          },
        },
      });
    });
    return unsubscribe;
  }, [createSettingsTab]);

  // Keyboard shortcuts for tab navigation
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
          case 'Tab':
            e.preventDefault();
            if (e.shiftKey) {
              window.dispatchEvent(new CustomEvent('switch-to-previous-tab'));
            } else {
              window.dispatchEvent(new CustomEvent('switch-to-next-tab'));
            }
            break;
          default:
            // Handle number keys 1-9
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

  // Listen for Claude not found events
  useEffect(() => {
    const handleClaudeNotFound = () => {
      setShowClaudeBinaryDialog(true);
    };

    window.addEventListener('claude-not-found', handleClaudeNotFound);
    return () => {
      window.removeEventListener('claude-not-found', handleClaudeNotFound);
    };
  }, []);

  // Legacy entry point — anything still dispatching this event opens the
  // usage dashboard as a tab (singleton, like Settings / Lima) so the tab
  // strip stays visible and the user has an obvious way back. The dedicated
  // `view = 'usage-dashboard'` mode is gone; everything goes through tabs.
  useEffect(() => {
    const handler = () => {
      setView('tabs');
      createUsageTab();
    };
    window.addEventListener('navigate-to-usage-dashboard', handler);
    return () => { window.removeEventListener('navigate-to-usage-dashboard', handler); };
  }, [createUsageTab]);

  /**
   * Loads all projects from the ~/.claude/projects directory
   */
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

  /**
   * Handles project selection and loads its sessions
   */
  const handleProjectClick = async (project: Project) => {
    try {
      setLoading(true);
      setError(null);
      const sessionList = await api.getProjectSessions(project.id, project.path);
      setSessions(sessionList);
      setSelectedProject(project);
    } catch (err) {
      console.error("Failed to load sessions:", err);
      // NO_ACCOUNT_FOR_PROJECT is a structured signal from the main process
      // that no path rule / project override binds this folder to a Claude
      // account. Surface a prominent, actionable banner — never fall back to
      // a "default" account. See electron/services/claude.ts (NoAccountError).
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

  /**
   * Optimistically remove the project from the on-screen list and call
   * the IPC. On failure we restore the row + reload from disk so the UI
   * matches reality. ProjectList's confirm dialog has already gated the
   * call, so by the time we get here the user has actively chosen this.
   */
  const handleDeleteProject = async (project: Project) => {
    if (project.account_id === undefined) {
      setToast({
        type: 'error',
        message: 'Cannot delete: this project has no account binding.',
      });
      return;
    }
    const previous = projects;
    setProjects((prev) => prev.filter((p) => p.id !== project.id));
    try {
      await api.deleteClaudeProject({
        accountId: project.account_id,
        projectId: project.id,
      });
      setToast({
        type: 'success',
        message: `Deleted ${project.path}`,
      });
    } catch (err) {
      console.error('Failed to delete project:', err);
      setProjects(previous);
      const msg = err instanceof Error ? err.message : String(err);
      setToast({ type: 'error', message: `Failed to delete project: ${msg}` });
      // Refetch so we don't leave the optimistic snapshot in place if
      // something else changed in the meantime.
      void loadProjects();
    }
  };

  /**
   * Re-fetch the session list for the currently-selected project. Triggered
   * by the SessionList refresh button when the user wants to pick up new
   * sessions that were created in a different tab / since the page rendered.
   */
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

  /**
   * Opens the project directory picker
   */
  const handleOpenProject = async () => {
    // Get home directory before showing picker
    const homeDir = await api.getHomeDirectory();
    setHomeDirectory(homeDir);
    setShowProjectPicker(true);
  };

  /**
   * Opens a new Claude Code session in the interactive UI
   */
  // New session creation is handled by the tab system via titlebar actions

  /**
   * Handles view changes with navigation protection
   */
  const handleViewChange = (newView: View) => {
    // No need for navigation protection with tabs since sessions stay open
    setView(newView);
  };

  /**
   * Handles navigating to hooks configuration
   */
  // Project settings navigation handled via `projectForSettings` state when needed


  const renderContent = () => {
    switch (view) {
      case "welcome":
        return (
          <div className="flex items-center justify-center p-4" style={{ height: "100%" }}>
            <div className="w-full max-w-4xl">
              {/* Welcome Header */}
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

              {/* Navigation Cards */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-2xl mx-auto">
                {/* CC Agents Card */}
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

                {/* Projects Card */}
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
            onDeleteProject={handleDeleteProject}
            loading={loading}
          />
        );
      
      case "tabs":
        return (
          <div className="h-full flex flex-col">
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
      
      case "project-settings":
        if (projectForSettings) {
          return (
            <ProjectSettings
              project={projectForSettings}
              onBack={() => {
                setProjectForSettings(null);
                handleViewChange(previousView || "projects");
              }}
            />
          );
        }
        break;
      
      default:
        return null;
    }
  };

  return (
    <div className="h-screen flex flex-col">
      {/* Custom Titlebar */}
      <CustomTitlebar
        onLimaClick={() => createLimaTab()}
        onSettingsClick={() => createSettingsTab()}
      />

      {/* Main Content */}
      <div className="flex-1 overflow-hidden">
        {renderContent()}
      </div>


      {/* Claude Binary Dialog */}
      <ClaudeBinaryDialog
        open={showClaudeBinaryDialog}
        onOpenChange={setShowClaudeBinaryDialog}
        onSuccess={() => {
          setToast({ message: "Claude binary path saved successfully", type: "success" });
          // Trigger a refresh of the Claude version check
          window.location.reload();
        }}
        onError={(message) => { setToast({ message, type: "error" }); }}
      />

      {/* File picker modal for selecting project directory */}
      {showProjectPicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="w-full max-w-2xl h-[600px] bg-background border rounded-lg shadow-lg">
            <FilePicker
              basePath={homeDirectory}
              onSelect={fireAndLog('app:select', async (entry) => {
                if (entry.is_directory) {
                  try {
                    // Check if account can be resolved for this path
                    const account = await api.resolveAccountForProject(entry.path);
                    if (account === null) {
                      // No matching rule — prompt user to pick account
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
      
      {/* Toast Container */}
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

/**
 * Main App component - Wraps the app with providers
 */
function App() {
  const [showIntro, setShowIntro] = useState(() => {
    // Read cached preference synchronously to avoid any initial flash
    try {
      const cached = typeof window !== 'undefined'
        ? window.localStorage.getItem('app_setting:startup_intro_enabled')
        : null;
      if (cached === 'true') return true;
      if (cached === 'false') return false;
    // eslint-disable-next-line no-empty -- empty block intentional (no-op cleanup / placeholder).
    } catch (_ignore) {}
    return true; // default if no cache
  });

  useEffect(() => {
    let timer: number | undefined;
    (async () => {
      try {
        const pref = await api.getSetting('startup_intro_enabled');
        const enabled = pref === null ? true : pref === 'true';
        if (enabled) {
          // keep intro visible and hide after duration
          timer = window.setTimeout(() => { setShowIntro(false); }, 2000);
        } else {
          // user disabled intro: hide immediately to avoid any overlay delay
          setShowIntro(false);
        }
      } catch {
        // On failure, show intro once to keep UX consistent
        timer = window.setTimeout(() => { setShowIntro(false); }, 2000);
      }
    })();
    return () => {
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  return (
    <AppFontProvider>
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
    </AppFontProvider>
  );
}

export default App;
