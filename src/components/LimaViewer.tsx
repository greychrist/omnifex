import React, { useCallback, useEffect, useState } from 'react';
import { HardDrive, Container, RefreshCw, AlertCircle, Play, Square, Loader2 } from 'lucide-react';
import { api, type LimaVm, type LimaDockerContainer } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

const POLL_INTERVAL_MS = 5000;

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function statusColor(status: string): string {
  const s = status.toLowerCase();
  if (s === 'running') return 'bg-green-500';
  if (s === 'stopped') return 'bg-zinc-500';
  if (s === 'broken' || s === 'error') return 'bg-red-500';
  return 'bg-amber-500';
}

function containerStateColor(state: string): string {
  const s = state.toLowerCase();
  if (s === 'running') return 'bg-green-500';
  if (s === 'exited' || s === 'dead') return 'bg-zinc-500';
  if (s === 'paused') return 'bg-amber-500';
  if (s === 'restarting') return 'bg-blue-500';
  return 'bg-zinc-400';
}

export const LimaViewer: React.FC = () => {
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [vms, setVms] = useState<LimaVm[]>([]);
  const [selectedVm, setSelectedVm] = useState<string | null>(null);
  const [containers, setContainers] = useState<LimaDockerContainer[]>([]);
  const [containersLoading, setContainersLoading] = useState(false);
  const [containersError, setContainersError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  /** Map of vmName → pending lifecycle action ('starting' | 'stopping'). */
  const [pendingAction, setPendingAction] = useState<Record<string, 'starting' | 'stopping'>>({});
  /** Map of containerId → pending action. Separate map so a VM-level action
   *  doesn't disable container buttons and vice versa. */
  const [pendingContainerAction, setPendingContainerAction] = useState<Record<string, 'starting' | 'stopping'>>({});
  const [actionError, setActionError] = useState<string | null>(null);

  const loadVms = useCallback(async () => {
    const check = await api.limaCheckInstalled();
    setInstalled(check.installed);
    if (!check.installed) {
      setVms([]);
      return;
    }
    const next = await api.limaListVms();
    setVms(next);
    setSelectedVm((prev) => {
      if (prev && next.some((v) => v.name === prev)) return prev;
      const firstRunning = next.find((v) => v.status === 'Running');
      return firstRunning?.name ?? next[0]?.name ?? null;
    });
  }, []);

  const loadContainers = useCallback(async (vmName: string, vmStatus: string) => {
    if (vmStatus !== 'Running') {
      setContainers([]);
      setContainersError(null);
      return;
    }
    setContainersLoading(true);
    try {
      const next = await api.limaListContainers(vmName);
      setContainers(next);
      setContainersError(null);
    } catch (err) {
      setContainersError(err instanceof Error ? err.message : String(err));
    } finally {
      setContainersLoading(false);
    }
  }, []);

  // Initial load + poll
  useEffect(() => {
    let cancelled = false;
    void loadVms();
    const id = setInterval(() => {
      if (!cancelled) void loadVms();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [loadVms]);

  // Containers: refresh whenever the selected VM changes or its status changes
  const selectedVmObj = vms.find((v) => v.name === selectedVm) ?? null;
  const selectedVmStatus = selectedVmObj?.status ?? 'Stopped';
  useEffect(() => {
    if (!selectedVm) {
      setContainers([]);
      return;
    }
    void loadContainers(selectedVm, selectedVmStatus);
    const id = setInterval(() => {
      void loadContainers(selectedVm, selectedVmStatus);
    }, POLL_INTERVAL_MS);
    return () => { clearInterval(id); };
  }, [selectedVm, selectedVmStatus, loadContainers]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await loadVms();
      if (selectedVm) await loadContainers(selectedVm, selectedVmStatus);
    } finally {
      setRefreshing(false);
    }
  };

  const handleStart = async (vmName: string) => {
    setActionError(null);
    setPendingAction((prev) => ({ ...prev, [vmName]: 'starting' }));
    try {
      await api.limaStartVm(vmName);
      await loadVms();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingAction((prev) => {
        const next = { ...prev };
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- intentional removal of one property from a copied object; rest-spread alternative is more allocation-heavy.
        delete next[vmName];
        return next;
      });
    }
  };

  const handleStop = async (vmName: string) => {
    setActionError(null);
    setPendingAction((prev) => ({ ...prev, [vmName]: 'stopping' }));
    try {
      await api.limaStopVm(vmName);
      await loadVms();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingAction((prev) => {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- intentional removal of one property from a copied object; rest-spread alternative is more allocation-heavy.
        const next = { ...prev };
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- intentional removal of one property from a copied object; rest-spread alternative is more allocation-heavy.
        delete next[vmName];
        return next;
      });
    }
  };

  const handleStartContainer = async (vmName: string, containerId: string) => {
    setActionError(null);
    setPendingContainerAction((prev) => ({ ...prev, [containerId]: 'starting' }));
    try {
      await api.limaStartContainer(vmName, containerId);
      await loadContainers(vmName, 'Running');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- intentional removal of one property from a copied object; rest-spread alternative is more allocation-heavy.
      setPendingContainerAction((prev) => {
        const next = { ...prev };
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- intentional removal of one property from a copied object; rest-spread alternative is more allocation-heavy.
        delete next[containerId];
        return next;
      });
    }
  };

  const handleStopContainer = async (vmName: string, containerId: string) => {
    setActionError(null);
    setPendingContainerAction((prev) => ({ ...prev, [containerId]: 'stopping' }));
    try {
      await api.limaStopContainer(vmName, containerId);
      await loadContainers(vmName, 'Running');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- intentional removal of one property from a copied object; rest-spread alternative is more allocation-heavy.
    } finally {
      setPendingContainerAction((prev) => {
        const next = { ...prev };
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- intentional removal of one property from a copied object; rest-spread alternative is more allocation-heavy.
        delete next[containerId];
        return next;
      });
    }
  };

  if (installed === false) {
    return (
      <div className="h-full flex items-center justify-center p-8">
        <div className="max-w-md text-center space-y-3">
          <AlertCircle className="h-10 w-10 text-amber-500 mx-auto" />
          <h2 className="text-lg font-semibold">Lima not found</h2>
          <p className="text-sm text-muted-foreground">
            <code className="font-mono px-1.5 py-0.5 rounded bg-muted">limactl</code> isn't on your PATH.
            Install it with <code className="font-mono px-1.5 py-0.5 rounded bg-muted">brew install lima</code>,
            then refresh.
          </p>
          <Button variant="outline" size="sm" onClick={handleRefresh}>
            <RefreshCw className={cn('w-3.5 h-3.5 mr-1.5', refreshing && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
        <div className="flex items-center gap-2">
          <HardDrive className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Lima VMs</h2>
          <span className="text-xs text-muted-foreground">
            {vms.length} VM{vms.length === 1 ? '' : 's'}
          </span>
        </div>
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing}>
          <RefreshCw className={cn('w-3.5 h-3.5 mr-1.5', refreshing && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {actionError && (
        <div className="px-4 py-2 border-b border-border/50 bg-red-500/10 text-red-400 text-xs font-mono flex items-center gap-2">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1 truncate">{actionError}</span>
          <button
            onClick={() => { setActionError(null); }}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      )}

      {/* Master/detail */}
      <div className="flex-1 flex overflow-hidden">
        {/* VM list (left) */}
        <div className="w-[320px] shrink-0 border-r border-border/50 overflow-y-auto">
          {vms.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">
              No Lima VMs configured. Create one with{' '}
              <code className="font-mono px-1 rounded bg-muted">limactl create</code>.
            </div>
          ) : (
            <ul className="divide-y divide-border/40">
              {vms.map((vm) => {
                const isActive = selectedVm === vm.name;
                const action = pendingAction[vm.name];
                const isRunning = vm.status === 'Running';
                const isStopped = vm.status === 'Stopped';
                return (
                  <li key={vm.name}>
                    <button
                      onClick={() => { setSelectedVm(vm.name); }}
                      className={cn(
                        'w-full text-left px-4 py-3 hover:bg-accent/40 transition-colors',
                        isActive && 'bg-accent',
                      )}
                    >
                      {/* Top row: name + status */}
                      <div className="flex items-center gap-2 mb-2">
                        <span
                          className={cn('inline-block h-2 w-2 rounded-full shrink-0', statusColor(vm.status))}
                          aria-hidden
                        />
                        <span className="text-sm font-medium truncate flex-1">{vm.name}</span>
                        <span
                          className={cn(
                            'text-[10px] uppercase tracking-wider shrink-0',
                            action
                              ? 'text-muted-foreground'
                              : isRunning
                              ? 'text-green-400'
                              : isStopped
                              ? 'text-red-400'
                              : 'text-muted-foreground',
                          )}
                        >
                          {action === 'starting' ? 'Starting…' : action === 'stopping' ? 'Stopping…' : vm.status}
                        </span>
                      </div>

                      {/* Compact metadata — two pairs per row */}
                      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] font-mono mb-2">
                        <div className="flex items-baseline gap-1.5 min-w-0">
                          <span className="text-muted-foreground/60 shrink-0">arch</span>
                          <span className="text-foreground/80 truncate">{vm.arch}</span>
                        </div>
                        <div className="flex items-baseline gap-1.5 min-w-0">
                          <span className="text-muted-foreground/60 shrink-0">cpu</span>
                          <span className="text-foreground/80">{vm.cpus}</span>
                        </div>
                        <div className="flex items-baseline gap-1.5 min-w-0">
                          <span className="text-muted-foreground/60 shrink-0">mem</span>
                          <span className="text-foreground/80 truncate">{formatBytes(vm.memoryBytes)}</span>
                        </div>
                        <div className="flex items-baseline gap-1.5 min-w-0">
                          <span className="text-muted-foreground/60 shrink-0">disk</span>
                          <span className="text-foreground/80 truncate">{formatBytes(vm.diskBytes)}</span>
                        </div>
                      </div>

                      {/* Action button bar — segmented look */}
                      <div className="inline-flex items-center rounded border border-border bg-background overflow-hidden">
                        {action ? (
                          <span className="h-7 w-14 inline-flex items-center justify-center text-muted-foreground">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          </span>
                        ) : (
                          <>
                            <button
                              type="button"
                              disabled={!isStopped}
                              onClick={(e) => { e.stopPropagation(); void handleStart(vm.name); }}
                              className="h-7 w-7 inline-flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed"
                              title={isStopped ? `Start ${vm.name}` : `Already ${vm.status.toLowerCase()}`}
                            >
                              <Play className="h-3.5 w-3.5" />
                            </button>
                            <span className="h-5 w-px bg-border" aria-hidden />
                            <button
                              type="button"
                              disabled={!isRunning}
                              onClick={(e) => { e.stopPropagation(); void handleStop(vm.name); }}
                              className="h-7 w-7 inline-flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed"
                              title={isRunning ? `Stop ${vm.name}` : `Already ${vm.status.toLowerCase()}`}
                            >
                              <Square className="h-3.5 w-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Container detail (right) */}
        <div className="flex-1 overflow-y-auto">
          {!selectedVmObj ? (
            <div className="p-8 text-sm text-muted-foreground">
              Select a VM to see its Docker containers.
            </div>
          ) : selectedVmObj.status !== 'Running' ? (
            <div className="p-8 max-w-md">
              <div className="text-sm font-semibold mb-1">{selectedVmObj.name}</div>
              <p className="text-sm text-muted-foreground">
                VM status is <span className="font-mono">{selectedVmObj.status}</span>. Start it to see
                containers.
              </p>
            </div>
          ) : (
            <div className="flex flex-col h-full">
              <div className="px-4 py-2 border-b border-border/50 flex items-center gap-2">
                <Container className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-semibold">Docker containers in {selectedVmObj.name}</span>
                <span className="text-[10px] text-muted-foreground ml-auto">
                  {containersLoading
                    ? 'loading…'
                    : `${containers.length} container${containers.length === 1 ? '' : 's'}`}
                </span>
              </div>
              {containersError ? (
                <div className="p-4 text-sm text-red-400 font-mono">{containersError}</div>
              ) : containers.length === 0 && !containersLoading ? (
                <div className="p-8 text-sm text-muted-foreground">
                  No containers running in this VM.
                </div>
              ) : (
                <ul className="grid grid-cols-1 lg:grid-cols-2 gap-3 p-4">
                  {containers.map((c) => {
                    const cAction = pendingContainerAction[c.id];
                    const cState = c.state.toLowerCase();
                    const cIsRunning = cState === 'running';
                    const cIsStopped = ['exited', 'created', 'dead'].includes(cState);
                    return (
                      <li
                        key={c.id}
                        className="rounded border border-border/60 bg-background/40 p-3 flex flex-col hover:bg-accent/40 transition-colors"
                      >
                        {/* Top row: name + state */}
                        <div className="flex items-center gap-2 mb-2">
                          <span
                            className={cn('inline-block h-2 w-2 rounded-full shrink-0', containerStateColor(c.state))}
                            aria-hidden
                          />
                          <span className="text-sm font-medium truncate flex-1 font-mono">{c.name}</span>
                          <span
                            className={cn(
                              'text-[10px] uppercase tracking-wider shrink-0 font-mono',
                              cAction
                                ? 'text-muted-foreground'
                                : cIsRunning
                                ? 'text-green-400'
                                : cIsStopped
                                ? 'text-red-400'
                                : 'text-muted-foreground',
                            )}
                          >
                            {cAction === 'starting' ? 'starting…' : cAction === 'stopping' ? 'stopping…' : c.state}
                          </span>
                        </div>

                        {/* Stacked metadata */}
                        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px] font-mono mb-2">
                          <dt className="text-muted-foreground/60">image</dt>
                          <dd className="text-foreground/80 truncate" title={c.image}>{c.image}</dd>
                          <dt className="text-muted-foreground/60">status</dt>
                          <dd className="text-foreground/80 truncate" title={c.status}>{c.status || '—'}</dd>
                          <dt className="text-muted-foreground/60">ports</dt>
                          <dd className="text-foreground/80 break-all" title={c.ports}>{c.ports || '—'}</dd>
                        </dl>

                        {/* Action button bar (anchored to card bottom) */}
                        <div className="mt-auto pt-2">
                          <div className="inline-flex items-center rounded border border-border bg-background overflow-hidden">
                            {cAction ? (
                              <span className="h-7 w-14 inline-flex items-center justify-center text-muted-foreground">
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              </span>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  disabled={!cIsStopped}
                                  onClick={() => void handleStartContainer(selectedVmObj.name, c.id)}
                                  className="h-7 w-7 inline-flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed"
                                  title={cIsStopped ? `Start ${c.name}` : `Already ${c.state}`}
                                >
                                  <Play className="h-3.5 w-3.5" />
                                </button>
                                <span className="h-5 w-px bg-border" aria-hidden />
                                <button
                                  type="button"
                                  disabled={!cIsRunning}
                                  onClick={() => void handleStopContainer(selectedVmObj.name, c.id)}
                                  className="h-7 w-7 inline-flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed"
                                  title={cIsRunning ? `Stop ${c.name}` : `Already ${c.state}`}
                                >
                                  <Square className="h-3.5 w-3.5" />
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
