import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Button, Tag, Space, message, Spin, Input } from 'antd';
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
  const [pid, setPid] = useState<number | undefined>();
  const [loading, setLoading] = useState(true);
  const [quickCmd, setQuickCmd] = useState('');
  const [sending, setSending] = useState(false);

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
    if (loading || status !== 'running' && status !== 'starting') return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
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

    const connection = connectTerminal(instanceId, {
      onOutput: (data) => terminal.write(data),
      onRuntime: ({ status: s, pid: p }) => {
        setStatus(s as InstanceStatus);
        setPid(p);
      },
      onError: (msg) => message.error({ content: msg, duration: 5 }),
      onClose: () => message.warning('Terminal connection closed')
    });
    connectionRef.current = connection;

    terminal.onData((data) => connection.send({ type: 'input', data }));

    const handleResize = () => fitAddon.fit();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      connection.disconnect();
      terminal.dispose();
      connectionRef.current = null;
      terminalRef.current = null;
    };
  }, [loading, status, instanceId]);

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

  const handleStop = async () => {
    try {
      const runtime = await stopInstance(instanceId);
      setStatus(runtime.status);
      setPid(runtime.pid);
      message.success('Instance stopped');
    } catch (e) {
      message.error((e as Error).message);
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

  const handleQuickCommand = async () => {
    const cmd = quickCmd.trim();
    if (!cmd) return;
    setSending(true);
    try {
      const { output } = await sendCommand(instanceId, cmd, { captureMs: 1500 });
      if (output && terminalRef.current) {
        terminalRef.current.write(output);
      }
      setQuickCmd('');
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const running = status === 'running' || status === 'starting';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#1e1e1e' }}>
      <div style={{ padding: '8px 16px', background: '#252526', borderBottom: '1px solid #3c3c3c', display: 'flex', alignItems: 'center', gap: 12 }}>
        <Button icon={<ArrowLeftOutlined />} size="small" onClick={() => navigate('/')} type="text" style={{ color: '#fff' }} />
        <code style={{ color: '#fff', marginLeft: 4 }}>{instanceId}</code>
        <Tag color={statusColor[status]} style={{ marginLeft: 8 }}>{status.toUpperCase()}</Tag>
        {pid && <span style={{ color: '#888', fontSize: 12 }}>PID {pid}</span>}
        <Space style={{ marginLeft: 'auto' }}>
          <Button size="small" icon={<PlayCircleOutlined />} disabled={running} onClick={handleStart}>Start</Button>
          <Button size="small" icon={<StopOutlined />} disabled={!running} onClick={handleStop}>Stop</Button>
          <Button size="small" icon={<SyncOutlined />} onClick={handleRestart} loading={status === 'starting'}>Restart</Button>
          <Button size="small" icon={<ExpandOutlined />} onClick={handleResize}>Fit</Button>
        </Space>
      </div>

      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1 }}>
          <Spin />
        </div>
      ) : !running ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, color: '#888' }}>
          <div style={{ textAlign: 'center' }}>
            <p>Instance is not running</p>
            <Button type="primary" icon={<PlayCircleOutlined />} onClick={handleStart} style={{ marginTop: 8 }}>Start Instance</Button>
          </div>
        </div>
      ) : (
        <>
          <div ref={containerRef} style={{ flex: 1, padding: 8 }} />
          <div style={{ padding: '8px 16px', background: '#252526', borderTop: '1px solid #3c3c3c' }}>
            <Input.Search
              value={quickCmd}
              onChange={(e) => setQuickCmd(e.target.value)}
              onSearch={handleQuickCommand}
              enterButton="Send"
              loading={sending}
              placeholder="Quick command (e.g. status) — captures ~1.5s of output"
              disabled={!running}
            />
          </div>
        </>
      )}
    </div>
  );
};

export default TerminalPage;