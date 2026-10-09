import { Alert, Button, Drawer, List, Popconfirm, message } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query';
import { deleteTemplate, fetchTemplates } from '../services/apiService';
import type { InstanceTemplate } from '../services/apiService';
import { sanitizeTemplateValues, stopCommandKeys } from '../services/instanceForm';

const policyLabel = { never: 'no restart', 'on-failure': 'restart on failure', always: 'keep running' } as const;

// One line naming everything the template sets.
const summarize = (template: InstanceTemplate): string => {
  const values = sanitizeTemplateValues(template.values);
  const stopKeys = stopCommandKeys(values.stopCommand);
  const parts = [
    values.name && `name "${values.name}"`,
    values.executable,
    values.cwd && `in ${values.cwd}`,
    values.args && values.args.length > 0 && `args ${values.args.join(' ')}`,
    values.autoStart !== undefined && (values.autoStart ? 'auto start' : 'no auto start'),
    values.restartPolicy && policyLabel[values.restartPolicy],
    values.restartDelayMs !== undefined && `restart delay ${values.restartDelayMs} ms`,
    stopKeys.length > 0 && `stop: ${stopKeys.join(' ')}`,
    values.stopTimeoutMs !== undefined && `stop timeout ${values.stopTimeoutMs} ms`
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'Sets nothing yet';
};

type Props = {
  open: boolean;
  onClose: () => void;
  isMobile: boolean;
  onUse: (template: InstanceTemplate) => void;
  onNew: () => void;
  onEdit: (template: InstanceTemplate) => void;
};

export const TemplatesDrawer = ({ open, onClose, isMobile, onUse, onNew, onEdit }: Props) => {
  const queryClient = useQueryClient();
  const { data: templates = [], isFetching, isError, error, refetch } = useQuery({ queryKey: ['templates'], queryFn: fetchTemplates, enabled: open });
  const deleteMut = useMutation({
    mutationKey: ['delete-template'],
    mutationFn: deleteTemplate,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['templates'] }),
    onError: (e: Error) => message.error(e.message)
  });
  // Every template with a delete in flight (deleteMut.variables only tracks
  // the latest call).
  const pendingDeleteIds = useMutationState({
    filters: { mutationKey: ['delete-template'], status: 'pending' },
    select: (mutation) => mutation.state.variables as string | undefined
  });
  // Larger touch targets on mobile, like the instance actions.
  const size = isMobile ? 'middle' : 'small';

  return (
    <Drawer
      title="Instance templates"
      open={open}
      onClose={onClose}
      width={isMobile ? '100%' : 560}
      extra={<Button size={size} type="primary" icon={<PlusOutlined />} onClick={onNew}>New template</Button>}
    >
      {isError && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          title={`Could not load templates: ${(error as Error).message}`}
          action={<Button size="small" onClick={() => refetch()}>Retry</Button>}
        />
      )}
      <List<InstanceTemplate>
        loading={isFetching && templates.length === 0}
        dataSource={templates}
        locale={{ emptyText: isError ? ' ' : 'No templates. Create one here, or use "Save as template" in the instance form.' }}
        renderItem={(template) => {
          const deleting = pendingDeleteIds.includes(template.id);
          return (
            <List.Item
              key={template.id}
              actions={[
                <Button key="use" size={size} type="link" onClick={() => onUse(template)}>Create instance</Button>,
                <Button key="edit" size={size} icon={<EditOutlined />} onClick={() => onEdit(template)} title="Edit template" />,
                <Popconfirm key="delete" title="Delete this template?" description="Instances created from it are not affected." disabled={deleting} onConfirm={() => deleteMut.mutate(template.id)}>
                  <Button size={size} danger icon={<DeleteOutlined />} loading={deleting} title="Delete template" />
                </Popconfirm>
              ]}
            >
              <List.Item.Meta
                title={<strong style={{ wordBreak: 'break-word' }}>{template.name}</strong>}
                description={<span style={{ wordBreak: 'break-word' }}>{summarize(template)}</span>}
              />
            </List.Item>
          );
        }}
      />
    </Drawer>
  );
};
