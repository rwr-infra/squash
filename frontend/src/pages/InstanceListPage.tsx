import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Table, Tag, Button, Space, Modal, Form, Input, Select, message, Popconfirm, Grid, Card, List, Drawer } from 'antd';
import { RestartInfo } from '../components/RestartInfo';
import { InstanceFormFields, ResetFormOnMount } from '../components/InstanceFormFields';
import { TemplateModal, type TemplateTarget } from '../components/TemplateModal';
import { TemplatesDrawer } from '../components/TemplatesDrawer';
import { ReloadOutlined, PlayCircleOutlined, StopOutlined, SyncOutlined, DeleteOutlined, PlusOutlined, ApartmentOutlined, EditOutlined, HistoryOutlined, LogoutOutlined, SaveOutlined, SnippetsOutlined, FileTextOutlined } from '@ant-design/icons';
import { useQuery, useMutation, useMutationState, useQueryClient } from '@tanstack/react-query';
import type { InstanceStatus, CreateInstanceRequest, InstanceWithRuntime, AuditEntry, InstanceTemplate } from '../services/apiService';
import { fetchInstances, createInstance, updateInstance, startInstance, stopInstance, restartInstance, deleteInstance, fetchAudit, fetchTemplates, getAuthStatus, logout } from '../services/apiService';
import { CREATE_DEFAULTS, TEMPLATE_FIELD_NAMES, createFormValues, formToTemplateValues, splitArgs } from '../services/instanceForm';
import type { InstanceFormValues } from '../services/instanceForm';

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
  const [form] = Form.useForm<InstanceFormValues>();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<InstanceWithRuntime | null>(null);
  // The template the create form was last filled from, and the values it
  // opens with (a template picked in the templates drawer).
  const [templateId, setTemplateId] = useState<string | undefined>();
  const [createInitial, setCreateInitial] = useState<Partial<InstanceFormValues>>(CREATE_DEFAULTS);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [templateTarget, setTemplateTarget] = useState<TemplateTarget | null>(null);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  // State updates render later; the ref also blocks submissions in one turn.
  const savingRef = useRef(false);
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

  const { data: templates = [], isError: templatesFailed } = useQuery({
    queryKey: ['templates'],
    queryFn: fetchTemplates,
    enabled: modalOpen && !editing
  });

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
  const stopMut = useMutation({
    mutationKey: ['stop'],
    mutationFn: ({ id, force }: { id: string; force: boolean }) => stopInstance(id, { force }),
    // Show `stopping` right away: until the refetch lands the row would still
    // read "Stop", inviting a second click.
    onSuccess: (runtime, { id }) => {
      queryClient.setQueryData<InstanceWithRuntime[]>(['instances'], (rows) =>
        rows?.map((row) => (row.config.id === id ? { ...row, runtime } : row))
      );
      queryClient.invalidateQueries({ queryKey: ['instances'] });
    }
  });
  // Rows with a Stop request in flight (stopMut.variables only tracks the
  // latest call).
  const pendingStopIds = useMutationState({
    filters: { mutationKey: ['stop'], status: 'pending' },
    select: (mutation) => (mutation.state.variables as { id: string } | undefined)?.id
  });
  const restartMut = useMutation({
    mutationKey: ['restart'],
    mutationFn: restartInstance,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['instances'] }),
    // A restart can now fail after a long wait (cancelled by a Stop, spawn
    // error): say so instead of silently dropping the spinner.
    onError: (e: Error) => {
      message.error(e.message);
      queryClient.invalidateQueries({ queryKey: ['instances'] });
    }
  });
  const pendingRestartIds = useMutationState({
    filters: { mutationKey: ['restart'], status: 'pending' },
    select: (mutation) => mutation.state.variables as string | undefined
  });
  const deleteMut = useMutation({ mutationFn: deleteInstance, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['instances'] }) });

  const openCreate = () => {
    if (savingRef.current) return;
    setEditing(null);
    setTemplateId(undefined);
    setCreateInitial(CREATE_DEFAULTS);
    setModalOpen(true);
  };

  const openCreateFromTemplate = (template: InstanceTemplate) => {
    if (savingRef.current) return;
    setEditing(null);
    setTemplateId(template.id);
    setCreateInitial(createFormValues(template.values));
    setTemplatesOpen(false);
    setModalOpen(true);
  };

  // Refills every template field (defaults where the template sets nothing);
  // the Instance ID typed so far stays.
  const applyTemplate = (id: string | undefined) => {
    setTemplateId(id);
    form.setFieldsValue(createFormValues(templates.find((template) => template.id === id)?.values));
    form.setFields(TEMPLATE_FIELD_NAMES.map((name) => ({ name, errors: [] })));
  };

  const openTemplateModal = (target: TemplateTarget) => {
    setTemplateTarget(target);
    setTemplateModalOpen(true);
  };

  // The dialog's settings as a new template. A Name equal to the Instance ID
  // is what a blank Name became, not a name to give every instance made from
  // the template.
  const saveAsTemplate = () => {
    const values = form.getFieldsValue();
    const { name, ...rest } = formToTemplateValues(values);
    openTemplateModal({ kind: 'new', values: name !== undefined && name !== values.id ? { name, ...rest } : rest });
  };

  const openEdit = (record: InstanceWithRuntime) => {
    if (savingRef.current) return;
    setEditing(record);
    setModalOpen(true);
  };

  const handleSubmit = async (values: InstanceFormValues) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const parsed: CreateInstanceRequest = {
        ...values,
        // These settings have no form fields, so onFinish omits them. Editing
        // replaces the full config: carry them explicitly rather than reset
        // them to the API defaults. New instances use server defaults.
        ...(editing ? { env: { ...editing.config.env }, logDir: editing.config.logDir } : {}),
        name: values.name?.trim() || values.id,
        args: splitArgs(values.args),
        // Kept as typed: a trailing empty line is an Enter (rwr_server needs one
        // after `quit`). Only an all-blank value means "none".
        stopCommand: values.stopCommand?.trim() ? values.stopCommand : undefined,
        // A cleared InputNumber reports null, which the schema rejects; omit it
        // so the server-side default applies.
        stopTimeoutMs: values.stopTimeoutMs ?? undefined,
        restartDelayMs: values.restartDelayMs ?? undefined,
        autoRestart: values.restartPolicy !== 'never'
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
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  // Form values when (re)opening the modal: existing config for edit, defaults for create.
  const initialValues: Partial<InstanceFormValues> = editing
    ? { ...editing.config, restartPolicy: editing.config.restartPolicy ?? (editing.config.autoRestart ? 'on-failure' : 'never'), args: editing.config.args.join(', ') }
    : createInitial;

  // Action buttons shared by the desktop table and the mobile card list. Larger
  // touch targets (middle) on mobile, compact (small) in the table.
  const renderActions = (record: InstanceWithRuntime, size: 'small' | 'middle') => {
    const running = record.runtime.status === 'running' || record.runtime.status === 'starting';
    const stopped = record.runtime.status === 'stopped' || record.runtime.status === 'crashed';
    // While a graceful stop is pending, Stop becomes an explicit Force stop.
    const stopping = record.runtime.status === 'stopping';
    const canCancel = !!record.runtime.restartAt || record.runtime.desiredState === 'running';
    const stopPending = pendingStopIds.includes(record.config.id);
    const restartPending = pendingRestartIds.includes(record.config.id);
    return (
      <Space wrap>
        <Button size={size} icon={<ApartmentOutlined />} onClick={() => navigate(`/terminal/${record.config.id}`)} title="Open Terminal" />
        <Button size={size} icon={<FileTextOutlined />} onClick={() => navigate(`/server-log/${encodeURIComponent(record.config.id)}`)} title="View rwr_server.log" />
        <Button size={size} icon={<PlayCircleOutlined />} disabled={running || stopping} onClick={() => startMut.mutate(record.config.id)} title="Start" />
        {/* Force stop asks first: a double click on Stop would otherwise land
            on it once the first request has returned. */}
        <Popconfirm title="Force stop?" description="Kills the server now instead of waiting for it to shut down. Unsaved progress may be lost." disabled={!stopping} onConfirm={() => stopMut.mutate({ id: record.config.id, force: true })} okText="Force stop" okButtonProps={{ danger: true }}>
          <Button size={size} icon={<StopOutlined />} danger={stopping} disabled={(!running && !stopping && !canCancel) || stopPending} loading={stopPending} onClick={stopping ? undefined : () => stopMut.mutate({ id: record.config.id, force: false })} title={stopping ? 'Force stop' : 'Stop / cancel auto-restart'} />
        </Popconfirm>
        <Button size={size} icon={<SyncOutlined />} disabled={(!running && !stopped) || restartPending} onClick={() => restartMut.mutate(record.config.id)} loading={restartPending} title="Restart" />
        <Button size={size} icon={<EditOutlined />} disabled={!stopped || saving} onClick={() => openEdit(record)} title={stopped ? 'Edit' : 'Stop the instance before editing'} />
        <Popconfirm title="Delete this instance?" onConfirm={() => deleteMut.mutate(record.config.id)}>
          <Button size={size} danger icon={<DeleteOutlined />} disabled={running || stopping} loading={deleteMut.isPending} title="Delete" />
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
      render: (status: InstanceStatus, record: InstanceWithRuntime) => <div><Tag color={statusColor[status]}>{status.toUpperCase()}</Tag><div style={{ fontSize: 12 }}><RestartInfo runtime={record.runtime} /></div></div>
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
              <div style={{ fontSize: 12, marginTop: 6 }}><RestartInfo runtime={runtime} /></div>
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
          <Button icon={<SnippetsOutlined />} onClick={() => setTemplatesOpen(true)} title="Instance templates">{isMobile ? '' : 'Templates'}</Button>
          <Button icon={<ReloadOutlined />} onClick={() => refetch()}>{isMobile ? '' : 'Refresh'}</Button>
          <Button type="primary" icon={<PlusOutlined />} disabled={saving} onClick={openCreate}>{isMobile ? 'Create' : 'Create Instance'}</Button>
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
        onCancel={() => { if (!savingRef.current) { setModalOpen(false); setEditing(null); } }}
        onOk={() => { if (!savingRef.current) form.submit(); }}
        confirmLoading={saving}
        okButtonProps={{ disabled: saving }}
        cancelButtonProps={{ disabled: saving }}
        closable={!saving}
        keyboard={!saving}
        mask={{ closable: !saving }}
        okText={editing ? 'Save' : 'Create'}
        footer={(buttons) => (
          <>
            <Button
              icon={<SaveOutlined />}
              disabled={saving}
              onClick={saveAsTemplate}
              style={{ float: 'left' }}
              title="Save these settings (without the Instance ID) as a new template"
            >
              {isMobile ? 'Template' : 'Save as template'}
            </Button>
            {buttons}
          </>
        )}
        width={isMobile ? '95vw' : 520}
        style={isMobile ? { top: 12 } : undefined}
        destroyOnHidden
        styles={{ body: { maxHeight: isMobile ? '75vh' : '70vh', overflowY: 'auto', overflowX: 'hidden' } }}
      >
        {!editing && templatesFailed && (
          <div style={{ marginTop: 16, color: '#888', fontSize: 12 }}>Templates could not be loaded.</div>
        )}
        {!editing && templates.length > 0 && (
          // Outside the <Form>: picking a template is not a setting to submit.
          <Select
            className="template-picker"
            aria-label="Prefill from a template"
            allowClear
            placeholder="Prefill from a template (optional)"
            value={templateId}
            onChange={applyTemplate}
            options={templates.map((template) => ({ value: template.id, label: template.name }))}
            disabled={saving}
            style={{ width: '100%', marginTop: 16 }}
          />
        )}
        <Form form={form} layout="vertical" disabled={saving} onFinish={handleSubmit} initialValues={initialValues} style={{ marginTop: 16 }}>
          <Form.Item name="id" label="Instance ID" rules={[{ required: true, pattern: /^[a-zA-Z0-9_-]+$/, message: 'Alphanumeric, dash, underscore only' }]} tooltip={editing ? 'The ID cannot be changed' : undefined}>
            <Input placeholder="my-server-1" disabled={!!editing || saving} />
          </Form.Item>
          <InstanceFormFields />
          <ResetFormOnMount />
        </Form>
      </Modal>

      <TemplatesDrawer
        open={templatesOpen}
        onClose={() => setTemplatesOpen(false)}
        isMobile={isMobile}
        onUse={openCreateFromTemplate}
        onNew={() => openTemplateModal({ kind: 'new', values: {} })}
        onEdit={(template) => openTemplateModal({ kind: 'edit', template })}
      />

      <TemplateModal target={templateTarget} open={templateModalOpen} onClose={() => setTemplateModalOpen(false)} isMobile={isMobile} />

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
