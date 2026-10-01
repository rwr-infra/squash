import type { InstanceRuntime, RestartReason } from '../services/apiService';

const reasons: Record<RestartReason, string> = {
  'unexpected-exit': 'Unexpected exit',
  disabled: 'Auto-restart disabled',
  'clean-exit': 'Clean exit; no restart',
  'manual-stop': 'Stopped by request',
  'retry-limit': 'Auto-restart paused after 5 attempts; Start to retry',
  'spawn-failed': 'Could not start; check configuration'
};

export const RestartInfo = ({ runtime }: { runtime: InstanceRuntime }) => {
  if (runtime.status === 'running' || runtime.status === 'starting') return null;
  return (
    <span>
      {runtime.restartAt
        ? `Auto-restart #${runtime.restartCount} at ${new Date(runtime.restartAt).toLocaleTimeString()}`
        : runtime.restartReason ? reasons[runtime.restartReason] : ''}
      {runtime.exitCode !== undefined ? ` · Exit code ${runtime.exitCode}` : ''}
      {runtime.exitSignal ? ` · Signal ${runtime.exitSignal}` : ''}
    </span>
  );
};
