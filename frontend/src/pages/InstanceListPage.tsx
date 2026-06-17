import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Table, Tag, Button, Space, Modal, Form, Input, InputNumber, Switch, message, Popconfirm, Grid, Card, List, Drawer } from 'antd';
import { ReloadOutlined, PlayCircleOutlined, StopOutlined, SyncOutlined, DeleteOutlined, PlusOutlined, ApartmentOutlined, EditOutlined, HistoryOutlined, LogoutOutlined } from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { InstanceStatus, CreateInstanceRequest, InstanceWithRuntime, AuditEntry } from '../services/apiService';
import { fetchInstances, createInstance, updateInstance, startInstance, stopInstance, restartInstance, deleteInstance, fetchAudit, getAuthStatus, logout } from '../services/apiService';

const auditActionColor: Record<AuditEntry['action'], string> = {
  login: 'blue',
  logout: 'default',
  create: 'cyan',
  start: 'green',
  stop: 'orange',
  restart: 'gold',
  delete: 'red',
  command: 'purple'
};

const CREATE_DEFAULTS: Partial<CreateInstanceRequest> = {
  cwd: '.',
  executable: './rwr_server',
  autoStart: false,
  autoRestart: true,
  restartDelayMs: 3000
};

const statusColor: Record<InstanceStatus, string> = {
  stopped: 'default',
  starting: 'processing',
  running: 'success',
  stopping: 'warning',
  crashed: 'error'
};

const formatUptime = (startedAt?: string, status?: InstanceStatus): string => {
  if (!startedAt || status !== 'running') return '-';
  const ms = Date.now() - new Date(startedAt).getTime();
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
};

const InstanceListPage = () => {
  const navigate = useNavigate();
  const [form] = Form.useForm<CreateInstanceRequest>();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<InstanceWithRuntime | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);
  const queryClient = useQueryClient();

  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;

  const { data: instances = [], isLoading, refetch } = useQuery({
    queryKey: ['instances'],
    queryFn: fetchInstances,
    refetchInterval: 3000
  });

  const { data: authStatus } = useQuery({ queryKey: ['auth-status'], queryFn: getAuthStatus, staleTime: Infinity });

  const { data: auditEntries = [], isFetching: auditLoading } = useQuery({
    queryKey: ['audit'],
    queryFn: () => fetchAudit(200),
    enabled: auditOpen
  });

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const startMut = useMutation({ mutationFn: startInstance, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['instances'] }) });
  const stopMut = useMutation({ mutationFn: stopInstance, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['instances'] }) });
  const restartMut = useMutation({ mutationFn: restartInstance, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['instances'] }) });
  const deleteMut = useMutation({ mutationFn: deleteInstance, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['instances'] }) });

  const openCreate = () => {
    setEditing(null);
    setModalOpen(true);
  };

  const openEdit = (record: InstanceWithRuntime) => {
    setEditing(record);
    setModalOpen(true);
  };

  const handleSubmit = async (values: CreateInstanceRequest) => {
    try {
      const argsStr = values.args as unknown as string;
      const parsed: CreateInstanceRequest = {
        ...values,
        name: values.name?.trim() || values.id,
        args: argsStr ? argsStr.split(',').map((s: string) => s.trim()).filter(Boolean) : []
      };
      if (editing) {
        await updateInstance(editing.config.id, parsed);
        message.success('Instance updated');
      } else {
        await createInstance(parsed);
        message.success('Instance created');
      }
      setModalOpen(false);
      setEditing(null);
      queryClient.invalidateQueries({ queryKey: ['instances'] });
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  // Form values when (re)opening the modal: existing config for edit, defaults for create.
  const initialValues: Partial<CreateInstanceRequest> = editing
    ? { ...editing.config, args: editing.config.args.join(', ') as unknown as string[] }
    : CREATE_DEFAULTS;

  // Action buttons shared by the desktop table and the mobile card list. Larger
  // touch targets (middle) on mobile, compact (small) in the table.
  const renderActions = (record: InstanceWithRuntime, size: 'small' | 'middle') => {
    const running = record.runtime.status === 'running' || record.runtime.status === 'starting';
    const stopped = record.runtime.status === 'stopped' || record.runtime.status === 'crashed';
    return (
      <Space wrap>
        <Button size={size} icon={<ApartmentOutlined />} onClick={() => navigate(`/terminal/${record.config.id}`)} title="Open Terminal" />
        <Button size={size} icon={<PlayCircleOutlined />} disabled={running} onClick={() => startMut.mutate(record.config.id)} title="Start" />
        <Button size={size} icon={<StopOutlined />} disabled={!running} onClick={() => stopMut.mutate(record.config.id)} title="Stop" />
        <Button size={size} icon={<SyncOutlined />} disabled={!running && !stopped} onClick={() => restartMut.mutate(record.config.id)} loading={restartMut.isPending} title="Restart" />
        <Button size={size} icon={<EditOutlined />} disabled={!stopped} onClick={() => openEdit(record)} title={stopped ? 'Edit' : 'Stop the instance before editing'} />
        <Popconfirm title="Delete this instance?" onConfirm={() => deleteMut.mutate(record.config.id)}>
          <Button size={size} danger icon={<DeleteOutlined />} disabled={running} loading={deleteMut.isPending} title="Delete" />
        </Popconfirm>
      </Space>
    );
  };

  const columns = [
    { title: 'Name', dataIndex: ['config', 'name'], key: 'name' },
    { title: 'ID', dataIndex: ['config', 'id'], key: 'id', render: (id: string) => <code>{id}</code> },
    {
      title: 'Status',
      dataIndex: ['runtime', 'status'],
      key: 'status',
      render: (status: InstanceStatus) => <Tag color={statusColor[status]}>{status.toUpperCase()}</Tag>
    },
    {
      title: 'PID',
      dataIndex: ['runtime', 'pid'],
      key: 'pid',
      render: (pid?: number) => (pid ? String(pid) : '-')
    },
    {
      title: 'Uptime',
      key: 'uptime',
      render: (_: unknown, record: InstanceWithRuntime) => formatUptime(record.runtime.startedAt, record.runtime.status)
    },
    {
      title: 'Restarts',
      dataIndex: ['runtime', 'restartCount'],
      key: 'restartCount',
      render: (count?: number) => (count && count > 0 ? String(count) : '-')
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_: unknown, record: InstanceWithRuntime) => renderActions(record, 'small')
    }
  ];

  const emptyState = (
    <div style={{ textAlign: 'center', padding: 48, color: '#888' }}>
      <p>No instances yet. Create one to get started.</p>
    </div>
  );

  const renderMobileCards = () => (
    <List
      loading={isLoading}
      dataSource={instances}
      locale={{ emptyText: emptyState }}
      renderItem={(record) => {
        const { config, runtime } = record;
        return (
          <List.Item key={config.id} style={{ padding: 0, marginBottom: 12, borderBlockEnd: 'none' }}>
            <Card size="small" style={{ width: '100%' }} styles={{ body: { padding: 12 } }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <strong style={{ fontSize: 16, wordBreak: 'break-word' }}>{config.name}</strong>
                <Tag color={statusColor[runtime.status]} style={{ marginInlineEnd: 0 }}>{runtime.status.toUpperCase()}</Tag>
              </div>
              <div style={{ margin: '6px 0' }}><code>{config.id}</code></div>
              <div style={{ color: '#888', fontSize: 13, marginBottom: 10 }}>
                PID {runtime.pid ?? '-'} · Uptime {formatUptime(runtime.startedAt, runtime.status)} · Restarts {runtime.restartCount ?? 0}
              </div>
              {renderActions(record, 'middle')}
            </Card>
          </List.Item>
        );
      }}
    />
  );

  return (
    <div style={{ padding: isMobile ? 12 : 24, width: '100%', maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2>Instances</h2>
        <Space wrap>
          <Button icon={<HistoryOutlined />} onClick={() => setAuditOpen(true)}>{isMobile ? '' : 'Audit log'}</Button>
          <Button icon={<ReloadOutlined />} onClick={() => refetch()}>{isMobile ? '' : 'Refresh'}</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>{isMobile ? 'Create' : 'Create Instance'}</Button>
          {authStatus?.loginEnabled && (
            <Button icon={<LogoutOutlined />} onClick={handleLogout} title="Log out">{isMobile ? '' : 'Log out'}</Button>
          )}
        </Space>
      </div>

      {isMobile ? (
        renderMobileCards()
      ) : instances.length === 0 && !isLoading ? (
        emptyState
      ) : (
        <Table rowKey={(r) => r.config.id} dataSource={instances} columns={columns} loading={isLoading} scroll={{ x: 'max-content' }} />
      )}

      <Modal
        key={editing ? `edit-${editing.config.id}` : 'create'}
        title={editing ? `Edit Instance — ${editing.config.id}` : 'Create Instance'}
        open={modalOpen}
        onCancel={() => { setModalOpen(false); setEditing(null); }}
        onOk={() => form.submit()}
        okText={editing ? 'Save' : 'Create'}
        width={isMobile ? '95vw' : 520}
        style={isMobile ? { top: 12 } : undefined}
        destroyOnHidden
        styles={{ body: { maxHeight: isMobile ? '75vh' : '70vh', overflowY: 'auto', overflowX: 'hidden' } }}
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit} initialValues={initialValues} style={{ marginTop: 16 }}>
          <Form.Item name="id" label="Instance ID" rules={[{ required: true, pattern: /^[a-zA-Z0-9_-]+$/, message: 'Alphanumeric, dash, underscore only' }]} tooltip={editing ? 'The ID cannot be changed' : undefined}>
            <Input placeholder="my-server-1" disabled={!!editing} />
          </Form.Item>
          <Form.Item name="name" label="Name" tooltip="Defaults to the Instance ID if left blank">
            <Input placeholder="Defaults to the Instance ID" />
          </Form.Item>
          <Form.Item name="cwd" label="Working Directory" rules={[{ required: true }]}>
            <Input placeholder="/path/to/server" />
          </Form.Item>
          <Form.Item name="executable" label="Executable" rules={[{ required: true }]}>
            <Input placeholder="./rwr_server" />
          </Form.Item>
          <Form.Item name="args" label="Arguments (comma-separated)">
            <Input placeholder="--config server.cfg, --port 27015" />
          </Form.Item>
          <Form.Item name="autoStart" label="Auto Start" valuePropName="checked" tooltip="Start this instance automatically when squash launches">
            <Switch />
          </Form.Item>
          <Form.Item name="autoRestart" label="Auto Restart" valuePropName="checked" tooltip="Restart automatically if the server crashes">
            <Switch />
          </Form.Item>
          <Form.Item name="restartDelayMs" label="Restart Delay (ms)">
            <InputNumber min={0} step={1000} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        title="Audit log"
        open={auditOpen}
        onClose={() => setAuditOpen(false)}
        width={isMobile ? '100%' : 720}
        extra={<Button size="small" icon={<ReloadOutlined />} onClick={() => queryClient.invalidateQueries({ queryKey: ['audit'] })} />}
      >
        <Table<AuditEntry>
          rowKey={(r, i) => `${r.time}-${i}`}
          dataSource={auditEntries}
          loading={auditLoading}
          size="small"
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
          scroll={{ x: 'max-content' }}
          columns={[
            { title: 'Time', dataIndex: 'time', key: 'time', render: (t: string) => new Date(t).toLocaleString() },
            { title: 'User', dataIndex: 'user', key: 'user' },
            { title: 'Action', dataIndex: 'action', key: 'action', render: (a: AuditEntry['action']) => <Tag color={auditActionColor[a]}>{a.toUpperCase()}</Tag> },
            { title: 'Instance', dataIndex: 'instanceId', key: 'instanceId', render: (id?: string) => (id ? <code>{id}</code> : '-') },
            { title: 'Detail', dataIndex: 'detail', key: 'detail', render: (d?: string) => (d ? <code style={{ wordBreak: 'break-all' }}>{d}</code> : '-') }
          ]}
        />
      </Drawer>
    </div>
  );
};

export default InstanceListPage;
