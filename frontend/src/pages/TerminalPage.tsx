import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Button, Tag, Space, message, Spin, Input, Grid, ConfigProvider, Popconfirm, theme } from 'antd';
import { ArrowLeftOutlined, PlayCircleOutlined, StopOutlined, SyncOutlined, ExpandOutlined } from '@ant-design/icons';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { connectTerminal } from '../services/terminalService';
import { fetchInstance, startInstance, stopInstance, restartInstance, sendCommand } from '../services/apiService';
import type { InstanceStatus } from '../services/apiService';

const statusColor: Record<InstanceStatus, string> = {
  stopped: 'default',
  starting: 'processing',
  running: 'success',
  stopping: 'warning',
  crashed: 'error'
};

const TerminalPage = () => {
  const { instanceId = '' } = useParams<{ instanceId: string }>();
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const connectionRef = useRef<ReturnType<typeof connectTerminal> | null>(null);

  const [status, setStatus] = useState<InstanceStatus>('stopped');
  // A second click while the Stop request is in flight would reach the
  // server as a Force stop.
  const [stopPending, setStopPending] = useState(false);
  const [pid, setPid] = useState<number | undefined>();
  const [loading, setLoading] = useState(true);
  const [quickCmd, setQuickCmd] = useState('');

  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;

  useEffect(() => {
    if (!instanceId) return;
    fetchInstance(instanceId)
      .then(({ runtime }) => {
        setStatus(runtime.status);
        setPid(runtime.pid);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [instanceId]);

  useEffect(() => {
    // Connect regardless of status so a crashed/stopped instance still shows its
    // buffered output (e.g. the crash error). Status updates arrive via onRuntime.
    if (loading) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: isMobile ? 12 : 14,
      fontFamily: 'Menlo, Monaco, monospace',
      theme: { background: '#1e1e1e', foreground: '#d4d4d4' },
      convertEol: true
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    if (containerRef.current) {
      containerRef.current.innerHTML = '';
      terminal.open(containerRef.current);
      fitAddon.fit();
    }

    // The PTY must match what xterm shows, or the server's redraws land in the
    // wrong columns. fit() only fires onResize when the size changes, so the
    // current size is also sent explicitly whenever the other side may not have it.
    const sendSize = () => {
      fitAddon.fit();
      connection.send({ type: 'resize', cols: terminal.cols, rows: terminal.rows });
    };

    const connection = connectTerminal(instanceId, {
      onOpen: sendSize,
      onOutput: (data) => terminal.write(data),
      onRuntime: ({ status: s, pid: p }) => {
        setStatus(s as InstanceStatus);
        setPid(p);
        // Sent on every `running` push, not only on a change: a restart from
        // running reports running → running, with nothing in between.
        if (s === 'running') sendSize();
      },
      onError: (msg) => message.error({ content: msg, duration: 5 }),
      onClose: () => message.warning('Terminal connection closed')
    });
    connectionRef.current = connection;

    terminal.onData((data) => connection.send({ type: 'input', data }));
    terminal.onResize(({ cols, rows }) => connection.send({ type: 'resize', cols, rows }));

    // Observe the container rather than the window: it also changes size when the
    // "instance is stopped" banner appears or goes away. fit() runs in the next
    // frame so its own layout change can't re-enter the observer in a loop.
    let fitFrame = 0;
    const resizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(fitFrame);
      fitFrame = requestAnimationFrame(() => fitAddon.fit());
    });
    if (containerRef.current) resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      cancelAnimationFrame(fitFrame);
      connection.disconnect();
      terminal.dispose();
      connectionRef.current = null;
      terminalRef.current = null;
    };
    // NOTE: isMobile is intentionally NOT a dependency. Grid.useBreakpoint()
    // returns {} on first render then resolves a tick later, flipping isMobile —
    // if it were a dep, the terminal would be torn down and reconnected right
    // after mount, dropping the just-replayed output. Font size is adjusted
    // separately below without recreating the terminal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, instanceId]);

  // Adjust font size on breakpoint changes without recreating the terminal.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.fontSize = isMobile ? 12 : 14;
    fitAddonRef.current?.fit();
  }, [isMobile]);

  const handleResize = () => fitAddonRef.current?.fit();

  const handleStart = async () => {
    try {
      const runtime = await startInstance(instanceId);
      setStatus(runtime.status);
      setPid(runtime.pid);
      message.success('Instance started');
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const handleStop = async (force: boolean) => {
    setStopPending(true);
    try {
      const runtime = await stopInstance(instanceId, { force });
      // The WS may already have pushed `stopped` (a quick exit, a force kill);
      // this response is older and must not put the page back in `stopping`.
      setStatus((current) => (current === 'stopped' && runtime.status === 'stopping' ? current : runtime.status));
      setPid(runtime.pid);
      message.success(force ? 'Force-stopping instance' : runtime.status === 'stopped' ? 'Instance stopped' : 'Stopping instance');
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setStopPending(false);
    }
  };

  const handleRestart = async () => {
    try {
      const runtime = await restartInstance(instanceId);
      setStatus(runtime.status);
      setPid(runtime.pid);
      message.success('Instance restarting');
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  // Send via REST /command (fire-and-forget, no captureMs). The backend writes it
  // to the pty and records an audit entry; the echo + output come back over the
  // live WS stream (shown once — we do NOT write locally, which would double).
  const handleQuickCommand = async () => {
    const cmd = quickCmd.trim();
    if (!cmd) return;
    try {
      await sendCommand(instanceId, cmd);
      setQuickCmd('');
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const running = status === 'running' || status === 'starting';
  // Stop stays enabled while a graceful stop is pending: it then asks for a
  // force kill. Kept apart from `running`, which also drives the stopped banner
  // and the command input.
  const stopping = status === 'stopping';

  return (
    <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
    <div style={{ display: 'flex', flexDirection: 'column', height: '100svh', background: '#1e1e1e' }}>
      <div style={{ padding: '8px 12px', background: '#252526', borderBottom: '1px solid #3c3c3c', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <Button icon={<ArrowLeftOutlined />} size="small" onClick={() => navigate('/')} type="text" style={{ color: '#fff' }} />
        <code style={{ color: '#fff', background: '#3c3c3c', padding: '2px 8px', borderRadius: 4, wordBreak: 'break-all', maxWidth: '40vw' }}>{instanceId}</code>
        <Tag color={statusColor[status]} style={{ marginInlineEnd: 0 }}>{status.toUpperCase()}</Tag>
        {pid && <span style={{ color: '#888', fontSize: 12 }}>PID {pid}</span>}
        <Space style={{ marginLeft: 'auto' }} wrap>
          <Button size="small" icon={<PlayCircleOutlined />} disabled={running || stopping} onClick={handleStart} title="Start">{isMobile ? null : 'Start'}</Button>
          {/* Force stop asks first: a double click on Stop would otherwise land
              on it, since Stop turns into Force stop as soon as the request
              returns. */}
          <Popconfirm title="Force stop?" description="Kills the server now instead of waiting for it to shut down. Unsaved progress may be lost." disabled={!stopping} onConfirm={() => handleStop(true)} okText="Force stop" okButtonProps={{ danger: true }}>
            <Button size="small" icon={<StopOutlined />} danger={stopping} disabled={(!running && !stopping) || stopPending} loading={stopPending} onClick={stopping ? undefined : () => handleStop(false)} title={stopping ? 'Force stop' : 'Stop'}>{isMobile ? null : stopping ? 'Force stop' : 'Stop'}</Button>
          </Popconfirm>
          <Button size="small" icon={<SyncOutlined />} onClick={handleRestart} loading={status === 'starting'} title="Restart">{isMobile ? null : 'Restart'}</Button>
          <Button size="small" icon={<ExpandOutlined />} onClick={handleResize} title="Fit">{isMobile ? null : 'Fit'}</Button>
        </Space>
      </div>

      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1 }}>
          <Spin />
        </div>
      ) : (
        <>
          {!running && (
            <div style={{ padding: '8px 12px', background: '#3a2d2d', color: '#e0c0c0', fontSize: 13, display: 'flex', alignItems: 'center', gap: 12 }}>
              <span>Instance is {status}. Showing the last output below.</span>
              <Button size="small" type="primary" icon={<PlayCircleOutlined />} disabled={stopping} onClick={handleStart}>Start</Button>
            </div>
          )}
          <div ref={containerRef} style={{ flex: 1, padding: 8, minHeight: 0 }} />
          <div style={{ padding: '8px 12px', background: '#252526', borderTop: '1px solid #3c3c3c' }}>
            <Input.Search
              value={quickCmd}
              onChange={(e) => setQuickCmd(e.target.value)}
              onSearch={handleQuickCommand}
              enterButton="Send"
              placeholder={isMobile ? 'Send a command (e.g. status)' : 'Send a command to the terminal (e.g. status)'}
              disabled={!running}
            />
          </div>
        </>
      )}
    </div>
    </ConfigProvider>
  );
};

export default TerminalPage;