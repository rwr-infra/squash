import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Table, Tag, Button, Space, Modal, Form, Input, InputNumber, Switch, message, Popconfirm } from 'antd';
import { ReloadOutlined, PlayCircleOutlined, StopOutlined, SyncOutlined, DeleteOutlined, PlusOutlined, ApartmentOutlined } from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { InstanceStatus, CreateInstanceRequest, InstanceWithRuntime } from '../services/apiService';
import { fetchInstances, createInstance, startInstance, stopInstance, restartInstance, deleteInstance } from '../services/apiService';

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
  const queryClient = useQueryClient();

  const { data: instances = [], isLoading, refetch } = useQuery({
    queryKey: ['instances'],
    queryFn: fetchInstances,
    refetchInterval: 3000
  });

  const startMut = useMutation({ mutationFn: startInstance, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['instances'] }) });
  const stopMut = useMutation({ mutationFn: stopInstance, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['instances'] }) });
  const restartMut = useMutation({ mutationFn: restartInstance, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['instances'] }) });
  const deleteMut = useMutation({ mutationFn: deleteInstance, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['instances'] }) });

  const handleCreate = async (values: CreateInstanceRequest) => {
    try {
      const argsStr = values.args as unknown as string;
      const parsed: CreateInstanceRequest = {
        ...values,
        args: argsStr ? argsStr.split(',').map((s: string) => s.trim()).filter(Boolean) : []
      };
      await createInstance(parsed);
      message.success('Instance created');
      setModalOpen(false);
      form.resetFields();
    } catch (e) {
      message.error((e as Error).message);
    }
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
      render: (_: unknown, record: InstanceWithRuntime) => {
        const running = record.runtime.status === 'running' || record.runtime.status === 'starting';
        const stopped = record.runtime.status === 'stopped' || record.runtime.status === 'crashed';
        return (
          <Space>
            <Button size="small" icon={<ApartmentOutlined />} onClick={() => navigate(`/terminal/${record.config.id}`)} title="Open Terminal" />
            <Button size="small" icon={<PlayCircleOutlined />} disabled={running} onClick={() => startMut.mutate(record.config.id)} />
            <Button size="small" icon={<StopOutlined />} disabled={!running} onClick={() => stopMut.mutate(record.config.id)} />
            <Button size="small" icon={<SyncOutlined />} disabled={!running && !stopped} onClick={() => restartMut.mutate(record.config.id)} loading={restartMut.isPending} />
            <Popconfirm title="Delete this instance?" onConfirm={() => deleteMut.mutate(record.config.id)}>
              <Button size="small" danger icon={<DeleteOutlined />} disabled={running} loading={deleteMut.isPending} />
            </Popconfirm>
          </Space>
        );
      }
    }
  ];

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16, alignItems: 'center' }}>
        <h2>Instances</h2>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => refetch()}>Refresh</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>Create Instance</Button>
        </Space>
      </div>

      {instances.length === 0 && !isLoading ? (
        <div style={{ textAlign: 'center', padding: 48, color: '#888' }}>
          <p>No instances yet. Create one to get started.</p>
        </div>
      ) : (
        <Table rowKey={(r) => r.config.id} dataSource={instances} columns={columns} loading={isLoading} />
      )}

      <Modal title="Create Instance" open={modalOpen} onCancel={() => setModalOpen(false)} footer={null} destroyOnClose>
        <Form form={form} layout="vertical" onFinish={handleCreate} style={{ marginTop: 16 }}>
          <Form.Item name="id" label="Instance ID" rules={[{ required: true, pattern: /^[a-zA-Z0-9_-]+$/, message: 'Alphanumeric, dash, underscore only' }]}>
            <Input placeholder="my-server-1" />
          </Form.Item>
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input placeholder="My Game Server" />
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
          <Form.Item name="logDir" label="Log Directory" rules={[{ required: true }]}>
            <Input placeholder="/var/log/instances" />
          </Form.Item>
          <Form.Item name="autoStart" label="Auto Start" valuePropName="checked" initialValue={false}>
            <Switch />
          </Form.Item>
          <Form.Item name="autoRestart" label="Auto Restart" valuePropName="checked" initialValue={false}>
            <Switch />
          </Form.Item>
          <Form.Item name="restartDelayMs" label="Restart Delay (ms)" initialValue={3000}>
            <InputNumber min={0} step={1000} style={{ width: '100%' }} />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>Create</Button>
        </Form>
      </Modal>
    </div>
  );
};

export default InstanceListPage;