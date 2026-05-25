import React, { Suspense, lazy, useEffect } from 'react';
import { motion } from 'framer-motion';
import { useTabState } from '@/hooks/useTabState';
import { Tab } from '@/contexts/TabContext';
import { Plus, ArrowLeft } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { api, type Project, type Session, type SessionMode } from '@/lib/api';
import { ProjectList } from '@/components/ProjectList';
import { SessionList } from '@/components/SessionList';
import { AccountPickerDialog } from '@/components/AccountPickerDialog';
import { OpenSessionByIdDialog } from '@/components/OpenSessionByIdDialog';
import { AccountBadge } from '@/components/AccountBadge';
import { Button } from '@/components/ui/button';
import { NewSessionForm, type NewSessionFormAccountResolution } from '@/components/NewSessionForm';
import type { EffortLevel, ThinkingConfig } from '@/components/FloatingPromptInput';
import { normalizeThinkingConfig } from '@/lib/thinkingConfig';
import { useClaudeSessionStore } from '@/stores/claudeSessionStore';
import { BranchColorsCard } from '@/components/BranchColorsCard';
import { fireAndLog, logAndForget } from "@/lib/fireAndLog";

// Lazy load heavy components
const ClaudeCodeSession = lazy(() => import('@/components/ClaudeCodeSession').then(m => ({ default: m.ClaudeCodeSession })));
const UsageDashboard = lazy(() => import('@/components/UsageDashboard').then(m => ({ default: m.UsageDashboard })));
const MCPManager = lazy(() => import('@/components/MCPManager').then(m => ({ default: m.MCPManager })));
const Settings = lazy(() => import('@/components/Settings').then(m => ({ default: m.Settings })));
const MarkdownEditor = lazy(() => import('@/components/MarkdownEditor').then(m => ({ default: m.MarkdownEditor })));
const LimaViewer = lazy(() => import('@/components/LimaViewer').then(m => ({ default: m.LimaViewer })));
// const ClaudeFileEditor = lazy(() => import('@/components/ClaudeFileEditor').then(m => ({ default: m.ClaudeFileEditor })));

// Import non-lazy components for projects view

interface TabPanelProps {
  tab: Tab;
  isActive: boolean;
}

const TabPanel: React.FC<TabPanelProps> = ({ tab, isActive }) => {
  const { updateTab } = useTabState();
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = React.useState<Project | null>(null);
  const [sessions, setSessions] = React.useState<Session[]>([]);
  const [loading, setLoading] = React.useState(false);
  
  const [error, setError] = React.useState<string | null>(null);
  const [showAccountPicker, setShowAccountPicker] = React.useState(false);
  const [showChangeAccountDialog, setShowChangeAccountDialog] = React.useState(false);
  const [showOpenByIdDialog, setShowOpenByIdDialog] = React.useState(false);
  const [pendingProjectPath, setPendingProjectPath] = React.useState<string>('');
  const [projectAccountName, setProjectAccountName] = React.useState<string | null>(null);
  // Inline new-session form state for the project view. Lives here (not in
  // ClaudeCodeSession) so the user can pick model/effort/permissions before
  // a chat tab even exists. On Start, these get baked into initialSessionConfig
  // and ClaudeCodeSession seeds its state from them.
  const [formModel, setFormModel] = React.useState<string>('opus[1m]');
  const [formEffort, setFormEffort] = React.useState<EffortLevel>('high');
  const [formThinkingConfig, setFormThinkingConfig] = React.useState<ThinkingConfig>('adaptive');
  const [formPermissionMode, setFormPermissionMode] = React.useState<string>('acceptEdits');
  const [formSessionStartMode, setFormSessionStartMode] = React.useState<SessionMode>('sdk');
  const [projectAccountResolution, setProjectAccountResolution] = React.useState<NewSessionFormAccountResolution | null>(null);

  const [projectBranches, setProjectBranches] = React.useState<string[]>([]);
  const [projectMainBranch, setProjectMainBranch] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!selectedProject?.path) {
      setProjectBranches([]);
      setProjectMainBranch(null);
      return;
    }
    let cancelled = false;
    api.listGitBranches(selectedProject.path).then((branches) => {
      if (cancelled) return;
      setProjectBranches(branches);
      const candidates = ['main', 'master', 'develop'];
      setProjectMainBranch(branches.find((b) => candidates.includes(b)) ?? branches[0] ?? null);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [selectedProject?.path]);

  // Load projects when tab becomes active and is of type 'projects'
  useEffect(() => {
    if (isActive && tab.type === 'projects') {
      logAndForget('tab-content:load-projects', loadProjects());
    }
  }, [isActive, tab.type]);
  
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
   * Optimistically remove the project from the on-screen list and call the
   * IPC. On failure we restore the row + reload from disk so the UI matches
   * reality. ProjectList's confirm dialog has already gated the call.
   * Tab-content has no toast surface, so success is silent (the row vanishing
   * is the feedback) and failure shows the inline error banner.
   */
  const handleDeleteProject = async (project: Project) => {
    if (project.account_id === undefined) {
      setError('Cannot delete: this project has no account binding.');
      return;
    }
    const previous = projects;
    setProjects((prev) => prev.filter((p) => p.id !== project.id));
    try {
      await api.deleteClaudeProject({
        accountId: project.account_id,
        projectId: project.id,
      });
    } catch (err) {
      console.error('Failed to delete project:', err);
      setProjects(previous);
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Failed to delete project: ${msg}`);
      void loadProjects();
    }
  };

  const handleProjectClick = async (project: Project) => {
    try {
      setLoading(true);
      setError(null);
      const sessionList = await api.getProjectSessions(project.id, project.path);
      setSessions(sessionList);
      setSelectedProject(project);

      // Resolve full account info (name + color + icon) for the tab badge.
      // project.account_name is a fast hint but lacks color/icon, so always
      // resolve the full Account object so the chip renders correctly.
      api.resolveAccountForProject(project.path).then((account) => {
        setProjectAccountName(account?.name ?? project.account_name ?? null);
        if (account) updateTab(tab.id, { accountName: account.name, accountColor: account.color, accountIcon: account.icon });
        else if (project.account_name) setProjectAccountName(project.account_name);
      }).catch(() => { setProjectAccountName(project.account_name ?? null); });

      // Resolve full account info (with match_type / match_detail) so the
      // inline new-session form can show the same Account/Config/Matched-by
      // block that ClaudeCodeSession's panel shows. Also seeds form defaults
      // from the account's session_defaults if set.
      api.explainAccountResolution(project.path).then((res) => {
        setProjectAccountResolution(res ?? null);
        const d = res?.account?.session_defaults;
        if (d) {
          if (d.model) setFormModel(d.model);
          if (d.effort) setFormEffort(d.effort);
          // Stored session_defaults may carry the legacy `'budget'`
          // value for accounts last edited before v0.4.21. Normalize at
          // the read boundary so the form always lands on a valid
          // current-schema state.
          if (d.thinkingConfig) setFormThinkingConfig(normalizeThinkingConfig(d.thinkingConfig));
          if (d.permissionMode) setFormPermissionMode(d.permissionMode);
        }
      }).catch(() => { setProjectAccountResolution(null); });

      // Update tab title to "<ProjectName>: Sessions" and flip the
      // tab icon from Folder → List so the strip reflects that the
      // projects tab is now showing a session list, not the project
      // browser. Both reset on the back button below.
      const projectName = project.path.split('/').pop() || 'Project';
      updateTab(tab.id, {
        title: `${projectName}: Sessions`,
        icon: 'list',
      });
    } catch (err) {
      console.error("Failed to load sessions:", err, "project:", JSON.stringify(project));
      // NO_ACCOUNT_FOR_PROJECT: structured signal that no path rule / project
      // override binds this folder to a Claude account. Surface the actionable
      // message verbatim — no silent fallback to a "default" account.
      const code = (err as { code?: string } | null)?.code;
      const msg = err instanceof Error ? err.message : String(err);
      if (code === 'NO_ACCOUNT_FOR_PROJECT') {
        setError(
          `No Claude account is configured for "${project.path}". ` +
          `Open Account Settings to add a path rule or project override, ` +
          `then reopen the project.`,
        );
      } else {
        setError(`Failed to load sessions: ${msg}`);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleOpenProject = async () => {
    try {
      const paths = await window.electronAPI.showOpenDialog({
        properties: ['openDirectory'],
        title: 'Select Project Folder',
        defaultPath: await api.getHomeDirectory(),
      }) as string[] | null;

      const selected = paths?.[0] ?? null;

      if (selected) {
        // Check if account can be resolved for this path
        const account = await api.resolveAccountForProject(selected);
        if (account === null) {
          // No matching rule — prompt user to pick account
          setPendingProjectPath(selected);
          setShowAccountPicker(true);
          return;
        }
        const project = await api.createProject(selected);
        await loadProjects();
        await handleProjectClick(project);
      }
    } catch (err) {
      console.error('Failed to open folder picker:', err);
      setError('Failed to open folder picker');
    }
  };
  
  const openSessionInTab = (session: Session) => {
    // Wipe any leftover slice state for this tabId before flipping the
    // tab to a chat view. The slice (messages / claudeSessionId /
    // extractedSessionInfo / inflightAssistant) is keyed by tabId, so a
    // tab that previously hosted a different chat — or the same chat
    // before a back-out — would feed stale data into the freshly
    // mounted ClaudeCodeSession. Specifically, `effectiveSession`
    // (ClaudeCodeSession.tsx:444) synthesizes a Session from the slice
    // when no `session` prop is given and `extractedSessionInfo` is
    // populated, which is what made "Start Session" warp back into the
    // last-opened session. Resetting up front means the new mount
    // starts from a guaranteed-blank slate.
    useClaudeSessionStore.getState().resetTab(tab.id);
    updateTab(tab.id, {
      type: 'chat',
      title: session.project_path.split('/').pop() || 'Session',
      sessionId: session.id,
      sessionData: session,
      initialProjectPath: session.project_path,
      // Clear the projects-tab "list" icon override so the chat type's
      // default MessageSquare wins for this tab going forward.
      icon: undefined,
    });
    api.resolveAccountForProject(session.project_path).then((account) => {
      if (account) updateTab(tab.id, { accountName: account.name, accountColor: account.color, accountIcon: account.icon });
    }).catch(() => {});
  };

  const handleStartNewSession = () => {
    if (!selectedProject) return;
    // Same reset rationale as openSessionInTab — without this, a
    // previous chat's `extractedSessionInfo` leaks into ClaudeCodeSession's
    // `effectiveSession` memo and the user lands back in the session
    // they just backed out of, even though the SDK side has spawned a
    // fresh subprocess.
    useClaudeSessionStore.getState().resetTab(tab.id);
    const projectName = selectedProject.path.split('/').pop() || 'Session';
    updateTab(tab.id, {
      type: 'chat',
      title: projectName,
      sessionId: undefined,
      sessionData: undefined,
      initialProjectPath: selectedProject.path,
      // Clear the projects-tab "list" icon override; chat's default wins.
      icon: undefined,
      initialSessionConfig: {
        model: formModel,
        effort: formEffort,
        thinkingConfig: formThinkingConfig,
        permissionMode: formPermissionMode,
        sessionStartMode: formSessionStartMode,
        accountResolution: projectAccountResolution ?? undefined,
      },
    });
    // Resolve account name for the tab badge. Prefer the manually-overridden
    // account when the user changed it on the landing page; otherwise fall
    // back to the auto-resolved one.
    if (projectAccountResolution) {
      updateTab(tab.id, {
        accountName: projectAccountResolution.account.name,
      });
    } else {
      api.resolveAccountForProject(selectedProject.path).then((account) => {
        if (account) updateTab(tab.id, { accountName: account.name, accountColor: account.color, accountIcon: account.icon });
      }).catch(() => {});
    }
  };
  
  // Resolve account badge for chat tabs on mount
  useEffect(() => {
    if (tab.type === 'chat' && !tab.accountName && tab.initialProjectPath) {
      api.resolveAccountForProject(tab.initialProjectPath).then((account) => {
        updateTab(tab.id, {
          accountName: account ? account.name : 'no account',
          accountColor: account?.color,
          accountIcon: account?.icon,
        });
      }).catch(() => {
        updateTab(tab.id, { accountName: 'no account' });
      });
    }
  }, [tab.type, tab.initialProjectPath, tab.accountName, tab.id, updateTab]);

  // Panel visibility - hide when not active
  const panelVisibilityClass = isActive ? "" : "hidden";
  
  const renderContent = () => {
    switch (tab.type) {
      case 'projects':
        return (
          <div className="h-full">
              {/* Content based on selection */}
              {selectedProject ? (
                // Flex-column layout so the session-list table can fill
                // the remaining height and scroll internally — no
                // page-level scrollbar. Header + new-session form stay
                // at natural height; SessionList claims the rest.
                <div className="h-full flex flex-col overflow-hidden">
                  <div className="max-w-6xl mx-auto p-6 w-full flex flex-col flex-1 min-h-0">
                    <div className="mb-6 flex-none">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <motion.div
                            whileTap={{ scale: 0.97 }}
                            transition={{ duration: 0.15 }}
                          >
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => {
                                setSelectedProject(null);
                                setSessions([]);
                                // Restore tab title to "Projects" and
                                // clear the per-tab icon override so the
                                // type default (Folder) wins again.
                                updateTab(tab.id, {
                                  title: 'Projects',
                                  icon: undefined,
                                });
                              }}
                              className="h-8 w-8 -ml-2"
                              title="Back to Projects"
                            >
                              <ArrowLeft className="h-4 w-4" />
                            </Button>
                          </motion.div>
                          <div>
                            <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
                              {selectedProject.path.split('/').pop()}
                              {projectAccountName && <AccountBadge name={projectAccountName} />}
                            </h1>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* New-session form + Branch Colors share the top row,
                        session list (with errors/loading) flows full-width
                        below. The list region is `flex-1 min-h-0` so the
                        SessionList table fills the remaining viewport
                        height and scrolls internally. */}
                    <div className="flex flex-col gap-6 items-stretch flex-1 min-h-0">
                      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 items-stretch flex-none">
                        <div className="lg:col-span-3">
                          <NewSessionForm
                            accountResolution={projectAccountResolution}
                            selectedModel={formModel}
                            setSelectedModel={setFormModel}
                            effort={formEffort}
                            setEffort={setFormEffort}
                            thinkingConfig={formThinkingConfig}
                            setThinkingConfig={setFormThinkingConfig}
                            permissionMode={formPermissionMode}
                            setPermissionMode={setFormPermissionMode}
                            sessionStartMode={formSessionStartMode}
                            setSessionStartMode={setFormSessionStartMode}
                            onStart={handleStartNewSession}
                            onChangeAccount={() => { setShowChangeAccountDialog(true); }}
                          />
                        </div>
                        {selectedProject && (
                          <div className="lg:col-span-1">
                            <BranchColorsCard
                              projectPath={selectedProject.path}
                              availableBranches={projectBranches}
                              mainFolderBranch={projectMainBranch}
                            />
                          </div>
                        )}
                      </div>

                      <div className="w-full flex flex-col flex-1 min-h-0">
                        {/* Error display */}
                        {error && (
                          <motion.div
                            initial={{ opacity: 0, y: 4 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.15 }}
                            className="mb-4 rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive flex-none"
                          >
                            {error}
                          </motion.div>
                        )}

                        {/* Loading state */}
                        {loading && (
                          <div className="flex items-center justify-center py-8 flex-none">
                            <Spinner className="size-6 text-muted-foreground" />
                          </div>
                        )}

                        {/* Session List */}
                        {!loading && (
                          <SessionList
                            sessions={sessions}
                            projectPath={selectedProject.path}
                            onSessionClick={openSessionInTab}
                            onOpenById={() => { setShowOpenByIdDialog(true); }}
                            onRefresh={async () => {
                              try {
                                const fresh = await api.getProjectSessions(
                                  selectedProject.id,
                                  selectedProject.path,
                                );
                                setSessions(fresh);
                              } catch (err) {
                                console.error('Failed to refresh sessions:', err);
                              }
                            }}
                          />
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                /* Projects List View */
                <div className="h-full flex flex-col">
                  {error && (
                    <motion.div
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.15 }}
                      className="mx-6 mt-4 rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive shrink-0"
                    >
                      {error}
                    </motion.div>
                  )}
                  <div className="flex-1 min-h-0">
                    <ProjectList
                      projects={projects}
                      onProjectClick={fireAndLog('tab-content:project-click', handleProjectClick)}
                      onOpenProject={handleOpenProject}
                      onDeleteProject={handleDeleteProject}
                      loading={loading}
                    />
                  </div>
                </div>
              )}
              {selectedProject && (
                <OpenSessionByIdDialog
                  open={showOpenByIdDialog}
                  onOpenChange={setShowOpenByIdDialog}
                  projectId={selectedProject.id}
                  projectPath={selectedProject.path}
                  onSessionResolved={openSessionInTab}
                />
              )}
              <AccountPickerDialog
                open={showAccountPicker}
                onOpenChange={setShowAccountPicker}
                projectPath={pendingProjectPath}
                onAccountSelected={fireAndLog('tab-content:account-selected', async () => {
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
              {selectedProject && (
                <AccountPickerDialog
                  open={showChangeAccountDialog}
                  onOpenChange={setShowChangeAccountDialog}
                  projectPath={selectedProject.path}
                  title="Choose an account for this session"
                  onAccountSelected={(account) => {
                    setProjectAccountResolution({
                      account: {
                        name: account.name,
                        account_type: account.account_type,
                        config_dir: account.config_dir,
                        session_defaults: account.session_defaults,
                      },
                      match_type: 'manual_override',
                      match_detail: 'Selected from session form',
                    });
                    setProjectAccountName(account.name);
                    updateTab(tab.id, {
                      accountName: account.name,
                      accountColor: account.color,
                      accountIcon: account.icon,
                    });
                  }}
                />
              )}
          </div>
        );
      
      case 'chat':
        return (
          <div className="h-full">
            <ClaudeCodeSession
              session={tab.sessionData} // Pass the full session object if available
              initialProjectPath={tab.initialProjectPath || ''}
              tabId={tab.id}
              initialSessionConfig={tab.initialSessionConfig}
              isActive={isActive}
              onStreamingChange={(isStreaming, sessionId) => {
                // Persist the SDK session ID to the tab so it survives app restart
                if (sessionId) {
                  updateTab(tab.id, { sessionId, status: isStreaming ? 'running' : 'idle' });
                } else {
                  updateTab(tab.id, { status: isStreaming ? 'running' : 'idle' });
                }
              }}
              onProjectPathChange={(path: string) => {
                // Update tab title, project path, and account badge
                const dirName = path.split('/').pop() || path.split('\\').pop() || 'Session';
                updateTab(tab.id, { title: dirName, initialProjectPath: path });
                // Resolve account for tab badge
                api.resolveAccountForProject(path).then((account) => {
                  if (account) updateTab(tab.id, { accountName: account.name, accountColor: account.color, accountIcon: account.icon });
                }).catch(() => {});
              }}
            />
          </div>
        );
      
      case 'usage':
        return (
          <div className="h-full">
            <UsageDashboard onBack={() => {}} />
          </div>
        );
      
      case 'mcp':
        return (
          <div className="h-full">
            <MCPManager onBack={() => {}} />
          </div>
        );

      case 'lima':
        return (
          <div className="h-full">
            <LimaViewer />
          </div>
        );
      
      case 'settings':
        return (
          <div className="h-full">
            <Settings onBack={() => {}} />
          </div>
        );
      
      case 'claude-md':
        return (
          <div className="h-full">
            <MarkdownEditor onBack={() => {}} />
          </div>
        );
      
      case 'claude-file':
        if (!tab.claudeFileId) {
          return <div className="p-4">No Claude file ID specified</div>;
        }
        // Note: We need to get the actual file object for ClaudeFileEditor
        // For now, returning a placeholder
        return <div className="p-4">Claude file editor not yet implemented in tabs</div>;
      
      default:
        return (
          <div className="h-full">
            <div className="p-4">Unknown tab type: {tab.type}</div>
          </div>
        );
    }
  };

  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.15 }}
        className={`h-full w-full ${panelVisibilityClass}`}
      >
        <Suspense
          fallback={
            <div className="flex items-center justify-center h-full">
              <Spinner className="size-8 text-muted-foreground" />
            </div>
          }
        >
          {renderContent()}
        </Suspense>
      </motion.div>

    </>
  );
};

export const TabContent: React.FC = () => {
  const { tabs, activeTabId, createChatTab, createProjectsTab, findTabBySessionId, closeTab, updateTab } = useTabState();
  
  // Listen for events to open sessions in tabs
  useEffect(() => {
    const handleOpenSessionInTab = (event: CustomEvent) => {
      const { session } = event.detail;
      
      // Check if tab already exists for this session
      const existingTab = findTabBySessionId(session.id);
      if (existingTab) {
        // Update existing tab with session data and switch to it
        updateTab(existingTab.id, {
          sessionData: session,
          title: session.project_path.split('/').pop() || 'Session'
        });
        window.dispatchEvent(new CustomEvent('switch-to-tab', { detail: { tabId: existingTab.id } }));
      } else {
        // Create new tab for this session
        const projectName = session.project_path.split('/').pop() || 'Session';
        const newTabId = createChatTab(session.id, projectName, session.project_path);
        // Update the new tab with session data and resolve account
        updateTab(newTabId, {
          sessionData: session,
          initialProjectPath: session.project_path
        });
        // Resolve account name for the tab badge
        api.resolveAccountForProject(session.project_path).then((account) => {
          if (account) {
            updateTab(newTabId, { accountName: account.name, accountColor: account.color, accountIcon: account.icon });
          }
        }).catch(() => {});
      }
    };

    const handleCloseTab = (event: CustomEvent) => {
      const { tabId } = event.detail;
      logAndForget('tab-content:close-tab', closeTab(tabId));
    };

    const handleClaudeSessionSelected = (event: CustomEvent) => {
      const { session } = event.detail;
      // Check if there's an existing tab for this session
      const existingTab = findTabBySessionId(session.id);
      if (existingTab) {
        // If tab exists, just switch to it
        updateTab(existingTab.id, {
          sessionData: session,
          title: session.project_path.split('/').pop() || 'Session',
        });
        window.dispatchEvent(new CustomEvent('switch-to-tab', { detail: { tabId: existingTab.id } }));
      } else {
        // If we're in a projects tab, update it to show the session
        // Otherwise create a new tab (for compatibility with other parts of the app)
        const currentTab = tabs.find(t => t.id === activeTabId);
        if (currentTab?.type === 'projects') {
          updateTab(currentTab.id, {
            type: 'chat',
            title: session.project_path.split('/').pop() || 'Session',
            sessionId: session.id,
            sessionData: session,
            initialProjectPath: session.project_path
          });
          api.resolveAccountForProject(session.project_path).then((account) => {
            if (account) updateTab(currentTab.id, { accountName: account.name, accountColor: account.color, accountIcon: account.icon });
          }).catch(() => {});
        } else {
          const projectName = session.project_path.split('/').pop() || 'Session';
          const newTabId = createChatTab(session.id, projectName, session.project_path);
          updateTab(newTabId, {
            sessionData: session,
            initialProjectPath: session.project_path,
          });
        }
      }
    };

    // When ClaudeCodeSession fires back-to-project, revert the current
    // chat tab to a projects tab. Mirrors the mutation that happens in
    // handleClaudeSessionSelected — except in reverse. The user ends up
    // on the session list for the same project, preserving their
    // navigation flow instead of having to close and reopen the tab.
    const handleBackToProject = () => {
      const currentTab = tabs.find((t) => t.id === activeTabId);
      if (currentTab?.type === 'chat') {
        updateTab(currentTab.id, {
          type: 'projects',
          title: 'Projects',
          icon: 'folder',
          status: 'idle',
          sessionId: undefined,
          sessionData: undefined,
          initialProjectPath: undefined,
        });
      }
    };

    window.addEventListener('open-session-in-tab', handleOpenSessionInTab as EventListener);
    window.addEventListener('close-tab', handleCloseTab as EventListener);
    window.addEventListener('claude-session-selected', handleClaudeSessionSelected as EventListener);
    window.addEventListener('back-to-project', handleBackToProject);
    return () => {
      window.removeEventListener('open-session-in-tab', handleOpenSessionInTab as EventListener);
      window.removeEventListener('close-tab', handleCloseTab as EventListener);
      window.removeEventListener('claude-session-selected', handleClaudeSessionSelected as EventListener);
      window.removeEventListener('back-to-project', handleBackToProject);
    };
  }, [createChatTab, findTabBySessionId, closeTab, updateTab, activeTabId, tabs]);
  
  return (
    <div className="flex-1 h-full relative">
      {tabs.map((tab) => (
        <TabPanel
          key={tab.id}
          tab={tab}
          isActive={tab.id === activeTabId}
        />
      ))}
      
      {tabs.length === 0 && (
        <div className="flex items-center justify-center h-full text-muted-foreground">
          <div className="text-center">
            <p className="text-lg mb-2">No projects open</p>
            <p className="text-sm mb-4">Click to start a new project</p>
            <Button
              onClick={() => createProjectsTab()}
              size="default"
            >
              <Plus className="w-4 h-4 mr-2" />
              New Project
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

export default TabContent;
