import React, { Suspense, lazy, useEffect } from 'react';
import { useRenderProfile } from '@/hooks/useRenderProfile';
import { motion } from 'framer-motion';
import { useTabState } from '@/hooks/useTabState';
import { Tab } from '@/contexts/TabContext';
import { Spinner } from '@/components/ui/spinner';
import { api, type AgentKind, type Project, type ResolvePair, type Session } from '@/lib/api';
import { ProjectList } from '@/components/ProjectList';
import { ProjectSettings } from '@/components/ProjectSettings';
import { SessionList } from '@/components/SessionList';
import { AccountPickerDialog } from '@/components/AccountPickerDialog';
import { OpenSessionByIdDialog } from '@/components/OpenSessionByIdDialog';
import { AccountBadge } from '@/components/AccountBadge';
import { BackButton } from "@/components/ui/back-button";
import { NewSessionForm } from '@/components/NewSessionForm';
import type { EffortLevel } from '@/components/FloatingPromptInput';
import { useClaudeSessionStore } from '@/stores/claudeSessionStore';
import { ProjectReposCard } from '@/components/ProjectReposDialog';
import { CodexSignInModal } from '@/components/codex/CodexSignInModal';
import { useCodexAuthStatus } from '@/hooks/useCodexAuthStatus';
import { fireAndLog, logAndForget } from "@/lib/fireAndLog";
import { slotToResolution, type FormAccountResolution } from "@/lib/accountResolution";
import { promptForNewProjectFolder } from "@/lib/newProject";
import { platform } from "@/lib/platform";
import { getCachedProjects, setCachedProjects } from "@/lib/projectsCache";
import { Skeleton } from "@/components/ui/skeleton";

const AgentSession = lazy(() => import('@/components/AgentSession').then(m => ({ default: m.AgentSession })));
const MCPManager = lazy(() => import('@/components/MCPManager').then(m => ({ default: m.MCPManager })));
const Settings = lazy(() => import('@/components/Settings').then(m => ({ default: m.Settings })));
const MarkdownEditor = lazy(() => import('@/components/MarkdownEditor').then(m => ({ default: m.MarkdownEditor })));
const LimaViewer = lazy(() => import('@/components/LimaViewer').then(m => ({ default: m.LimaViewer })));
const CostReportView = lazy(() => import('@/components/CostReportView').then(m => ({ default: m.CostReportView })));
const BrainTab = lazy(() => import('@/components/brain/BrainTab').then(m => ({ default: m.BrainTab })));

interface TabPanelProps {
  tab: Tab;
  isActive: boolean;
}

const TabPanelImpl: React.FC<TabPanelProps> = ({ tab, isActive }) => {
  useRenderProfile('TabPanel');
  const { updateTab } = useTabState();
  const [projects, setProjects] = React.useState<Project[]>(() => getCachedProjects() ?? []);
  // Until the first listProjects answers, an empty list means "unknown", not "none".
  const [projectsLoaded, setProjectsLoaded] = React.useState(false);
  const [selectedProject, setSelectedProject] = React.useState<Project | null>(null);
  const [settingsProject, setSettingsProject] = React.useState<Project | null>(null);
  const [sessions, setSessions] = React.useState<Session[]>([]);
  const [sessionsLoading, setSessionsLoading] = React.useState(false);
  const sessionsRequestRef = React.useRef<string | null>(null);
  
  const [error, setError] = React.useState<string | null>(null);
  const [showAccountPicker, setShowAccountPicker] = React.useState(false);
  const [showChangeAccountDialog, setShowChangeAccountDialog] = React.useState(false);
  const [showOpenByIdDialog, setShowOpenByIdDialog] = React.useState(false);
  const [pendingProjectPath, setPendingProjectPath] = React.useState<string>('');
  const [projectAccountName, setProjectAccountName] = React.useState<string | null>(null);
  const [formModel, setFormModel] = React.useState<string>('opus');
  const [formEffort, setFormEffort] = React.useState<EffortLevel>('high');
  const [formPermissionMode, setFormPermissionMode] = React.useState<string>('acceptEdits');
  const [formAgent, setFormAgent] = React.useState<AgentKind>('claude');
  const [projectAccountResolution, setProjectAccountResolution] = React.useState<FormAccountResolution | null>(null);
  const [projectResolvePair, setProjectResolvePair] = React.useState<ResolvePair>({ claude: null, codex: null });

  const codexAuthStatus = useCodexAuthStatus(projectResolvePair.codex?.account.config_dir ?? null);
  const [showCodexSignIn, setShowCodexSignIn] = React.useState(false);

  useEffect(() => {
    if (isActive && tab.type === 'projects') {
      logAndForget('tab-content:load-projects', loadProjects());
    }
  }, [isActive, tab.type]);
  
  const loadProjects = async () => {
    try {
      setError(null);
      const projectList = await api.listProjects();
      setCachedProjects(projectList);
      setProjects(projectList);
    } catch (err) {
      console.error("Failed to load projects:", err);
      setError("Failed to load projects. Please ensure ~/.claude directory exists.");
    } finally {
      setProjectsLoaded(true);
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
      setError(`Failed to ${pinned ? 'pin' : 'unpin'} project: ${msg}`);
      void loadProjects();
    }
  };

  const handleProjectClick = async (project: Project) => {
    sessionsRequestRef.current = project.id;
    setError(null);
    setSessions([]);
    setSessionsLoading(true);
    setSelectedProject(project);
    const projectName = project.path.split('/').pop() || 'Project';
    updateTab(tab.id, { title: `${projectName}: Sessions`, icon: 'list' });
    try {
      const sessionList = await api.getProjectSessions(project.id, project.path);
      if (sessionsRequestRef.current !== project.id) return;
      setSessions(sessionList);

      api.resolveAccountForProject(project.path).then((pair) => {
        setProjectResolvePair(pair);
        const engine: AgentKind = pair.claude ? 'claude' : pair.codex ? 'codex' : 'claude';
        setFormAgent(engine);
        const account = pair.claude?.account ?? pair.codex?.account ?? null;
        setProjectAccountName(account?.name ?? project.account_name ?? null);
        if (account) updateTab(tab.id, { accountName: account.name, accountColor: account.color, accountIcon: account.icon });
        else if (project.account_name) setProjectAccountName(project.account_name);

        // Must be the launching engine's slot, not the longest-prefix rule's engine: that put a Codex account in a Claude session's header.
        const resolution = slotToResolution(pair[engine]);
        setProjectAccountResolution(resolution);

        const d = resolution?.account.session_defaults;
        if (d) {
          if (d.model) setFormModel(d.model);
          if (d.effort) setFormEffort(d.effort);
          if (d.permissionMode) setFormPermissionMode(d.permissionMode);
        }
      }).catch(() => {
        setProjectAccountName(project.account_name ?? null);
        setProjectAccountResolution(null);
      });

    } catch (err) {
      if (sessionsRequestRef.current !== project.id) return;
      console.error("Failed to load sessions:", err, "project:", JSON.stringify(project));
      sessionsRequestRef.current = null;
      setSelectedProject(null);
      updateTab(tab.id, { title: 'Projects', icon: undefined });
      // NO_ACCOUNT_FOR_PROJECT: surface verbatim, no silent default-account fallback.
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
      if (sessionsRequestRef.current === project.id || sessionsRequestRef.current === null) setSessionsLoading(false);
    }
  };

  useEffect(() => {
    const path = tab.returnToProjectPath;
    if (!isActive || tab.type !== 'projects' || !path) return;
    const match = projects.find((p) => p.path === path);
    if (!match && !projectsLoaded) return;
    updateTab(tab.id, { returnToProjectPath: undefined });
    if (match) logAndForget('tab-content:return-to-project', handleProjectClick(match));
  }, [isActive, tab.type, tab.returnToProjectPath, projects, projectsLoaded]); // eslint-disable-line react-hooks/exhaustive-deps -- handleProjectClick/updateTab are read fresh each run

  const openProjectFolder = async (selected: string) => {
    const pair = await api.resolveAccountForProject(selected);
    if (pair.claude === null && pair.codex === null) {
      setPendingProjectPath(selected);
      setShowAccountPicker(true);
      return;
    }
    const project = await api.createProject(selected);
    await loadProjects();
    await handleProjectClick(project);
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
        await openProjectFolder(selected);
      }
    } catch (err) {
      console.error('Failed to open folder picker:', err);
      setError('Failed to open folder picker');
    }
  };

  const handleNewProject = async () => {
    try {
      setError(null);
      const created = await promptForNewProjectFolder({
        showSaveDialog: (options) => window.electronAPI.showSaveDialog(options),
        getHomeDirectory: () => api.getHomeDirectory(),
        createDirectory: (directoryPath) => api.createDirectory(directoryPath),
      });
      if (created) {
        await openProjectFolder(created);
      }
    } catch (err) {
      console.error('Failed to create new project:', err);
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Failed to create project: ${msg}`);
    }
  };
  
  const openSessionInTab = (session: Session) => {
    // Reset the tabId-keyed slice first, or stale extractedSessionInfo warps the new chat back into the last-opened session.
    useClaudeSessionStore.getState().resetTab(tab.id);
    updateTab(tab.id, {
      type: 'chat',
      title: session.project_path.split('/').pop() || 'Session',
      sessionId: session.id,
      sessionData: session,
      initialProjectPath: session.project_path,
      icon: undefined,
    });
    api.resolveAccountForProject(session.project_path).then((pair) => {
      const account = pair.claude?.account ?? pair.codex?.account ?? null;
      if (account) updateTab(tab.id, { accountName: account.name, accountColor: account.color, accountIcon: account.icon });
    }).catch(() => {});
  };

  // Re-point the resolution at the new engine's slot, or Start carries the previous engine's account.
  const handleFormAgentChange = (engine: AgentKind) => {
    setFormAgent(engine);
    setProjectAccountResolution(slotToResolution(projectResolvePair[engine]));
  };

  const handleStartNewSession = () => {
    if (!selectedProject) return;
    // Slice reset: see openSessionInTab.
    useClaudeSessionStore.getState().resetTab(tab.id);
    const projectName = selectedProject.path.split('/').pop() || 'Session';
    updateTab(tab.id, {
      type: 'chat',
      title: projectName,
      agent: formAgent,
      sessionId: undefined,
      sessionData: undefined,
      initialProjectPath: selectedProject.path,
      icon: undefined,
      initialSessionConfig: {
        model: formModel,
        effort: formEffort,
        permissionMode: formPermissionMode,
        accountResolution: projectAccountResolution ?? undefined,
      },
    });
    if (projectAccountResolution) {
      updateTab(tab.id, {
        accountName: projectAccountResolution.account.name,
      });
    } else {
      api.resolveAccountForProject(selectedProject.path).then((pair) => {
        const account = pair.claude?.account ?? pair.codex?.account ?? null;
        if (account) updateTab(tab.id, { accountName: account.name, accountColor: account.color, accountIcon: account.icon });
      }).catch(() => {});
    }
  };
  
  const handleQuickLaunch = async (project: Project) => {
    try {
      setError(null);
      const pair = await api.resolveAccountForProject(project.path);
      const engine: AgentKind = pair.claude ? 'claude' : pair.codex ? 'codex' : 'claude';
      const account = pair.claude?.account ?? pair.codex?.account ?? null;
      if (!account) {
        // Defer to the sessions page so NO_ACCOUNT_FOR_PROJECT surfaces; never launch without an account.
        await handleProjectClick(project);
        return;
      }
      const resolution = slotToResolution(pair[engine]);
      const d = resolution?.account.session_defaults;

      // Slice reset: see openSessionInTab.
      useClaudeSessionStore.getState().resetTab(tab.id);
      const projectName = project.path.split('/').pop() || 'Session';
      updateTab(tab.id, {
        type: 'chat',
        title: projectName,
        agent: engine,
        sessionId: undefined,
        sessionData: undefined,
        initialProjectPath: project.path,
        icon: undefined,
        accountName: account.name,
        accountColor: account.color,
        accountIcon: account.icon,
        initialSessionConfig: {
          model: d?.model ?? 'opus',
          effort: d?.effort ?? 'high',
          permissionMode: d?.permissionMode ?? 'acceptEdits',
          accountResolution: resolution ?? undefined,
        },
      });
    } catch (err) {
      console.error('Quick launch failed:', err, 'project:', JSON.stringify(project));
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Failed to launch session: ${msg}`);
    }
  };

  useEffect(() => {
    if (tab.type === 'chat' && !tab.accountName && tab.initialProjectPath) {
      api.resolveAccountForProject(tab.initialProjectPath).then((pair) => {
        const slot = pair[tab.agent] ?? pair.claude ?? pair.codex;
        const account = slot?.account ?? null;
        updateTab(tab.id, {
          accountName: account ? account.name : 'no account',
          accountColor: account?.color,
          accountIcon: account?.icon,
        });
      }).catch(() => {
        updateTab(tab.id, { accountName: 'no account' });
      });
    }
  }, [tab.type, tab.initialProjectPath, tab.accountName, tab.id, tab.agent, updateTab]);

  const panelVisibilityClass = isActive ? "" : "hidden";
  
  const renderContent = () => {
    switch (tab.type) {
      case 'projects':
        return (
          <div className="h-full">
              {settingsProject ? (
                <div className="h-full overflow-y-auto">
                  <ProjectSettings
                    project={settingsProject}
                    onBack={() => { setSettingsProject(null); }}
                  />
                </div>
              ) : selectedProject ? (
                <div className="h-full flex flex-col overflow-hidden">
                  <div className="max-w-6xl mx-auto p-6 w-full flex flex-col flex-1 min-h-0">
                    <div className="mb-6 flex-none">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <BackButton
                            label="Back to Projects"
                            size="md"
                            onClick={() => {
                              sessionsRequestRef.current = null;
                              setSelectedProject(null);
                              setSessions([]);
                              setSessionsLoading(false);
                              updateTab(tab.id, {
                                title: 'Projects',
                                icon: undefined,
                              });
                            }}
                          />
                          <div>
                            <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
                              {selectedProject.path.split('/').pop()}
                              {projectAccountName && <AccountBadge name={projectAccountName} />}
                            </h1>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-col gap-6 items-stretch flex-1 min-h-0">
                      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 items-stretch flex-none">
                        <div className="lg:col-span-3">
                          <NewSessionForm
                            resolvePair={projectResolvePair}
                            selectedModel={formModel}
                            setSelectedModel={setFormModel}
                            effort={formEffort}
                            setEffort={setFormEffort}
                            permissionMode={formPermissionMode}
                            setPermissionMode={setFormPermissionMode}
                            agent={formAgent}
                            setAgent={handleFormAgentChange}
                            agentPickerDisabled={sessionsLoading}
                            onStart={handleStartNewSession}
                            onChangeAccount={() => { setShowChangeAccountDialog(true); }}
                            onChooseAccount={() => { setShowChangeAccountDialog(true); }}
                            codexAuthStatus={codexAuthStatus}
                            onCodexSignIn={() => { setShowCodexSignIn(true); }}
                          />
                        </div>
                        {selectedProject && (
                          <div className="lg:col-span-1">
                            <ProjectReposCard projectPath={selectedProject.path} />
                          </div>
                        )}
                      </div>

                      <div className="w-full flex flex-col flex-1 min-h-0">
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

                        {sessionsLoading && (
                          <div className="flex flex-col gap-3 py-4 flex-none" data-testid="sessions-loading" aria-busy="true">
                            {Array.from({ length: 6 }, (_, i) => (
                              <div key={i} className="flex items-center gap-3">
                                <Skeleton className="h-8 flex-1" />
                                <Skeleton className="h-4 w-20" />
                                <Skeleton className="h-4 w-24" />
                              </div>
                            ))}
                          </div>
                        )}

                        {!sessionsLoading && (
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
                      onNewProject={platform.isDesktop ? handleNewProject : undefined}
                      onQuickLaunch={fireAndLog('tab-content:project-quick-launch', handleQuickLaunch)}
                      onTogglePin={handleTogglePin}
                      onOpenSettings={fireAndLog('tab-content:project-settings', setSettingsProject)}
                      loading={!projectsLoaded}
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
                  engineFilter={formAgent}
                  onAccountSelected={(account) => {
                    setProjectAccountResolution({
                      account: {
                        name: account.name,
                        subscription_label: account.subscription_label,
                        has_cost: account.has_cost,
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
                    if (selectedProject) {
                      void api.setProjectAccountOverride(selectedProject.path, account.id)
                        .then(() => api.resolveAccountForProject(selectedProject.path))
                        .then(setProjectResolvePair)
                        .catch(() => {});
                    }
                  }}
                />
              )}
              <CodexSignInModal
                open={showCodexSignIn}
                configDir={projectResolvePair.codex?.account.config_dir ?? ''}
                onClose={() => { setShowCodexSignIn(false); }}
              />
          </div>
        );

      case 'chat':
        return (
          <div className="h-full">
            <AgentSession
              session={tab.sessionData}
              initialProjectPath={tab.initialProjectPath || ''}
              tabId={tab.id}
              initialSessionConfig={tab.initialSessionConfig}
              initialPrompt={tab.initialPrompt}
              onInitialPromptSent={() => { updateTab(tab.id, { initialPrompt: undefined }); }}
              isActive={isActive}
              onStreamingChange={(isStreaming, sessionId) => {
                if (sessionId) {
                  updateTab(tab.id, { sessionId, status: isStreaming ? 'running' : 'idle' });
                } else {
                  updateTab(tab.id, { status: isStreaming ? 'running' : 'idle' });
                }
              }}
              onProjectPathChange={(path: string) => {
                const dirName = path.split('/').pop() || path.split('\\').pop() || 'Session';
                updateTab(tab.id, { title: dirName, initialProjectPath: path });
                api.resolveAccountForProject(path).then((pair) => {
                  const account = (pair[tab.agent] ?? pair.claude ?? pair.codex)?.account ?? null;
                  if (account) updateTab(tab.id, { accountName: account.name, accountColor: account.color, accountIcon: account.icon });
                }).catch(() => {});
              }}
            />
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
            <LimaViewer isActive={isActive} />
          </div>
        );

      case 'brain':
        return (
          <div className="h-full">
            <BrainTab />
          </div>
        );

      case 'cost-report':
        return (
          <div className="h-full">
            <CostReportView />
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

// Memoised: every panel is mounted at once, so without this a tab switch re-renders all N. Relies on updateTab keeping unchanged tab objects identical.
const TabPanel = React.memo(TabPanelImpl);

export const TabContent: React.FC = () => {
  useRenderProfile('TabContent');
  const { tabs, activeTabId, createChatTab, findTabBySessionId, closeTab, updateTab } = useTabState();
  
  useEffect(() => {
    const handleOpenSessionInTab = (event: CustomEvent<{ session: Session }>) => {
      const { session } = event.detail;
      
      const existingTab = findTabBySessionId(session.id);
      if (existingTab) {
        updateTab(existingTab.id, {
          sessionData: session,
          title: session.project_path.split('/').pop() || 'Session'
        });
        window.dispatchEvent(new CustomEvent('switch-to-tab', { detail: { tabId: existingTab.id } }));
      } else {
        const projectName = session.project_path.split('/').pop() || 'Session';
        const newTabId = createChatTab(session.id, projectName, session.project_path);
        updateTab(newTabId, {
          sessionData: session,
          initialProjectPath: session.project_path
        });
        api.resolveAccountForProject(session.project_path).then((pair) => {
          const account = pair.claude?.account ?? pair.codex?.account ?? null;
          if (account) {
            updateTab(newTabId, { accountName: account.name, accountColor: account.color, accountIcon: account.icon });
          }
        }).catch(() => {});
      }
    };

    const handleCloseTab = (event: CustomEvent<{ tabId: string }>) => {
      const { tabId } = event.detail;
      logAndForget('tab-content:close-tab', closeTab(tabId));
    };

    const handleClaudeSessionSelected = (event: CustomEvent<{ session: Session }>) => {
      const { session } = event.detail;
      const existingTab = findTabBySessionId(session.id);
      if (existingTab) {
        updateTab(existingTab.id, {
          sessionData: session,
          title: session.project_path.split('/').pop() || 'Session',
        });
        window.dispatchEvent(new CustomEvent('switch-to-tab', { detail: { tabId: existingTab.id } }));
      } else {
        const currentTab = tabs.find(t => t.id === activeTabId);
        if (currentTab?.type === 'projects') {
          updateTab(currentTab.id, {
            type: 'chat',
            title: session.project_path.split('/').pop() || 'Session',
            sessionId: session.id,
            sessionData: session,
            initialProjectPath: session.project_path
          });
          api.resolveAccountForProject(session.project_path).then((pair) => {
            const account = pair.claude?.account ?? pair.codex?.account ?? null;
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

    const handleCodexSessionSelected = (event: CustomEvent) => {
      const detail = event.detail as {
        conversationId: string;
        projectPath: string | null;
        jsonlPath?: string;
        lastActivity?: string;
      };
      const codexProjectPath = detail.projectPath ?? '';
      const existingTab = findTabBySessionId(detail.conversationId);
      if (existingTab) {
        window.dispatchEvent(new CustomEvent('switch-to-tab', { detail: { tabId: existingTab.id } }));
        return;
      }
      const projectName = codexProjectPath.split('/').pop() || 'Codex Session';
      const currentTab = tabs.find((t) => t.id === activeTabId);
      if (currentTab?.type === 'projects') {
        updateTab(currentTab.id, {
          type: 'chat',
          title: projectName,
          agent: 'codex',
          sessionId: detail.conversationId,
          initialProjectPath: codexProjectPath || undefined,
        });
      } else {
        const newTabId = createChatTab(
          detail.conversationId,
          projectName,
          codexProjectPath || undefined,
          'codex',
        );
        updateTab(newTabId, {
          initialProjectPath: codexProjectPath || undefined,
        });
      }
    };

    const handleBackToProject = (event: Event) => {
      const currentTab = tabs.find((t) => t.id === activeTabId);
      if (currentTab?.type === 'chat') {
        const detail = (event as CustomEvent<{ projectPath?: string } | null>).detail;
        const projectPath: string | undefined =
          detail?.projectPath || currentTab.initialProjectPath || currentTab.sessionData?.project_path || undefined;
        // Backing out closes the session, or a later session opened into this reused tab id rebinds to the stale handle.
        void api.stopSession(currentTab.id).catch(() => {});
        useClaudeSessionStore.getState().resetTab(currentTab.id);
        updateTab(currentTab.id, {
          type: 'projects',
          title: 'Projects',
          icon: 'folder',
          status: 'idle',
          sessionId: undefined,
          sessionData: undefined,
          initialProjectPath: undefined,
          returnToProjectPath: projectPath,
        });
      }
    };

    window.addEventListener('open-session-in-tab', handleOpenSessionInTab as EventListener);
    window.addEventListener('close-tab', handleCloseTab as EventListener);
    window.addEventListener('claude-session-selected', handleClaudeSessionSelected as EventListener);
    window.addEventListener('codex-session-selected', handleCodexSessionSelected as EventListener);
    window.addEventListener('back-to-project', handleBackToProject);
    return () => {
      window.removeEventListener('open-session-in-tab', handleOpenSessionInTab as EventListener);
      window.removeEventListener('close-tab', handleCloseTab as EventListener);
      window.removeEventListener('claude-session-selected', handleClaudeSessionSelected as EventListener);
      window.removeEventListener('codex-session-selected', handleCodexSessionSelected as EventListener);
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
    </div>
  );
};

export default TabContent;
