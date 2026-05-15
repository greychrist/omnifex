import React, { useCallback, useEffect, useState } from 'react';
import { HardDrive, Container, RefreshCw, AlertCircle, Play, Square, Loader2 } from 'lucide-react';
import { api, type LimaVm, type LimaDockerContainer } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { HeaderLabel } from './HeaderLabel';
import { fireAndLog } from "@/lib/fireAndLog";

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

// Status-pill palettes — mirror TabStatusPopover.STATUS_COLOR so the Lima
// page reads in the same visual language (green = healthy, amber = in
// flight, red = error, muted = inert). Foreground + tinted background +
// optional pulsing dot. The pill always includes the dot when transient
// so VM/container lifecycle changes are obvious at a glance.
function vmPillPalette(status: string, pending: 'starting' | 'stopping' | undefined): string {
  if (pending) return 'text-amber-300 bg-amber-500/20';
  const s = status.toLowerCase();
  if (s === 'running') return 'text-emerald-400 bg-emerald-500/10';
  if (s === 'stopped') return 'text-red-400 bg-red-500/15';
  if (s === 'broken' || s === 'error') return 'text-red-400 bg-red-500/15';
  return 'text-amber-300 bg-amber-500/15';
}

function containerPillPalette(state: string, pending: 'starting' | 'stopping' | undefined): string {
  if (pending) return 'text-amber-300 bg-amber-500/20';
  const s = state.toLowerCase();
  if (s === 'running') return 'text-emerald-400 bg-emerald-500/10';
  if (s === 'exited' || s === 'dead' || s === 'created') return 'text-muted-foreground bg-muted/40';
  if (s === 'paused') return 'text-amber-300 bg-amber-500/15';
  if (s === 'restarting') return 'text-blue-300 bg-blue-500/15';
  return 'text-muted-foreground bg-muted/40';
}

// Shared shell: the two-zone card from TabStatusCard (TabStatusPopover.tsx).
// Used by both VM rows and container tiles so a single style change
// propagates to both lists.
const CARD_SHELL =
  'rounded-md border-0 overflow-hidden bg-[color-mix(in_oklch,var(--color-background)_40%,var(--color-muted))] shadow-[0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_45%,transparent),2px_2px_4px_rgb(0_0_0/0.08)]';

const CARD_HEADER =
  'w-full flex items-center justify-between gap-3 px-3 py-2 bg-muted shadow-[inset_0_-1px_0_0_color-mix(in_oklch,var(--color-muted-foreground)_45%,transparent)] transition-colors text-left';

// Mono value pill — bg-background + 1px inset border. Mirrors the
// "Context Size" / branch pill treatment in TabStatusCard.
const VALUE_PILL =
  'inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-mono font-medium text-foreground bg-background shadow-[0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_45%,transparent)]';

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
          <Button variant="outline" size="sm" onClick={fireAndLog('lima-viewer:click', handleRefresh)}>
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
        <Button variant="outline" size="sm" onClick={fireAndLog('lima-viewer:refresh', handleRefresh)} disabled={refreshing}>
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
        {/* VM list (left) — TabStatusCard idiom: card-per-row, tinted
            header strip with status pill + name + chevron, body grid
            below with HeaderLabel left-col + value-pill right-col. */}
        <div className="w-[340px] shrink-0 border-r border-border/50 overflow-y-auto">
          {vms.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">
              No Lima VMs configured. Create one with{' '}
              <code className="font-mono px-1 rounded bg-muted">limactl create</code>.
            </div>
          ) : (
            <div className="p-2 space-y-1.5">
              {vms.map((vm) => {
                const isActive = selectedVm === vm.name;
                const action = pendingAction[vm.name];
                const isRunning = vm.status === 'Running';
                const isStopped = vm.status === 'Stopped';
                const pillLabel = action === 'starting'
                  ? 'Starting…'
                  : action === 'stopping'
                    ? 'Stopping…'
                    : vm.status;
                const showDot = !!action || vm.status.toLowerCase() === 'broken';
                return (
                  <div key={vm.name} className={cn(CARD_SHELL, isActive && 'ring-1 ring-accent')}>
                    {/* Header strip — clickable to select. */}
                    <button
                      type="button"
                      onClick={() => { setSelectedVm(vm.name); }}
                      className={cn(CARD_HEADER, 'hover:bg-accent/40', isActive && 'bg-accent/60')}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={cn(
                            'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                            vmPillPalette(vm.status, action),
                          )}
                        >
                          {showDot && (
                            <span className="inline-block h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
                          )}
                          {pillLabel}
                        </span>
                        <span className="truncate text-sm font-medium">{vm.name}</span>
                      </div>
                      <span className="text-[10px] text-muted-foreground shrink-0">→</span>
                    </button>

                    {/* Body — metadata grid + action bar. */}
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 px-3 pb-2.5 pt-2 text-xs">
                      <div className="flex items-center gap-2 min-w-0">
                        <HeaderLabel className="inline-block w-10 shrink-0">Arch</HeaderLabel>
                        <span className={VALUE_PILL}>{vm.arch}</span>
                      </div>
                      <div className="flex items-center gap-2 min-w-0">
                        <HeaderLabel className="inline-block w-10 shrink-0">CPU</HeaderLabel>
                        <span className={VALUE_PILL}>{vm.cpus}</span>
                      </div>
                      <div className="flex items-center gap-2 min-w-0">
                        <HeaderLabel className="inline-block w-10 shrink-0">Mem</HeaderLabel>
                        <span className={VALUE_PILL}>{formatBytes(vm.memoryBytes)}</span>
                      </div>
                      <div className="flex items-center gap-2 min-w-0">
                        <HeaderLabel className="inline-block w-10 shrink-0">Disk</HeaderLabel>
                        <span className={VALUE_PILL}>{formatBytes(vm.diskBytes)}</span>
                      </div>

                      <div className="col-span-2 pt-1">
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
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
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
                    const cPillLabel = cAction === 'starting'
                      ? 'Starting…'
                      : cAction === 'stopping'
                        ? 'Stopping…'
                        : c.state;
                    const cShowDot = !!cAction || cState === 'restarting' || cState === 'paused';
                    return (
                      <li key={c.id} className={cn(CARD_SHELL, 'flex flex-col')}>
                        {/* Header strip — non-interactive (no drill-in target). */}
                        <div className={CARD_HEADER}>
                          <div className="flex items-center gap-2 min-w-0">
                            <span
                              className={cn(
                                'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                                containerPillPalette(c.state, cAction),
                              )}
                            >
                              {cShowDot && (
                                <span className="inline-block h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
                              )}
                              {cPillLabel}
                            </span>
                            <span className="truncate text-sm font-medium font-mono" title={c.name}>
                              {c.name}
                            </span>
                          </div>
                        </div>

                        {/* Body — metadata + action bar pinned to the bottom. */}
                        <div className="px-3 pb-2.5 pt-2 text-xs flex-1 flex flex-col">
                          <div className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1.5 mb-2">
                            <HeaderLabel className="self-center">Image</HeaderLabel>
                            <span className={cn(VALUE_PILL, 'truncate min-w-0')} title={c.image}>
                              <span className="truncate">{c.image}</span>
                            </span>
                            <HeaderLabel className="self-center">Status</HeaderLabel>
                            <span className={cn(VALUE_PILL, 'truncate min-w-0')} title={c.status}>
                              <span className="truncate">{c.status || '—'}</span>
                            </span>
                            <HeaderLabel className="self-center">Ports</HeaderLabel>
                            <span className={cn(VALUE_PILL, 'break-all min-w-0')} title={c.ports}>
                              <span className="break-all">{c.ports || '—'}</span>
                            </span>
                          </div>

                          <div className="mt-auto pt-1">
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
