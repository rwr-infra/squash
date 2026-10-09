import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Form, Input, Modal, message } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, createTemplate, updateTemplate } from '../services/apiService';
import type { InstanceTemplate, InstanceTemplateValues } from '../services/apiService';
import { formToTemplateValues, templateToFormValues } from '../services/instanceForm';
import type { InstanceFormValues } from '../services/instanceForm';
import { InstanceFormFields, ResetFormOnMount } from './InstanceFormFields';

// What the template modal edits: an existing template, or a new one starting
// from the given values (empty, or the instance form's when saving it).
export type TemplateTarget =
  | { readonly kind: 'edit'; readonly template: InstanceTemplate }
  | { readonly kind: 'new'; readonly values: InstanceTemplateValues };

type TemplateFormValues = Partial<InstanceFormValues> & { templateName: string };

type Props = {
  // Kept while the modal closes, so its content doesn't change mid-animation;
  // destroyOnHidden + ResetFormOnMount start each opening afresh.
  target: TemplateTarget | null;
  open: boolean;
  onClose: () => void;
  isMobile: boolean;
};

export const TemplateModal = ({ target, open, onClose, isMobile }: Props) => {
  const [form] = Form.useForm<TemplateFormValues>();
  const [saving, setSaving] = useState(false);
  // State updates render later; the ref also blocks submissions in one turn.
  const savingRef = useRef(false);
  const queryClient = useQueryClient();
  const editing = target?.kind === 'edit' ? target.template : undefined;

  const initialValues: Partial<TemplateFormValues> = editing
    ? { templateName: editing.name, ...templateToFormValues(editing.values) }
    : { templateName: '', ...templateToFormValues(target?.kind === 'new' ? target.values : {}) };

  const close = () => {
    if (!savingRef.current) onClose();
  };

  const handleSubmit = async ({ templateName, ...fields }: TemplateFormValues) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    let nameTaken = false;
    try {
      const body = { name: templateName.trim(), values: formToTemplateValues(fields) };
      if (editing) {
        await updateTemplate(editing.id, body);
        message.success('Template saved');
      } else {
        await createTemplate(body);
        message.success('Template created');
      }
      queryClient.invalidateQueries({ queryKey: ['templates'] });
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'TEMPLATE_NAME_TAKEN') {
        nameTaken = true;
        form.setFields([{ name: 'templateName', errors: [e.message] }]);
      } else {
        message.error((e as Error).message);
      }
    } finally {
      savingRef.current = false;
      // Enabled again right away: a disabled input cannot take focus.
      flushSync(() => setSaving(false));
    }
    // The name field is at the top: bring it into view (the body may be
    // scrolled to the bottom) and focus it.
    if (nameTaken) form.scrollToField('templateName', { focus: true });
  };

  return (
    <Modal
      title={editing ? `Edit Template — ${editing.name}` : 'New Template'}
      open={open}
      onCancel={close}
      onOk={() => { if (!savingRef.current) form.submit(); }}
      confirmLoading={saving}
      okButtonProps={{ disabled: saving }}
      cancelButtonProps={{ disabled: saving }}
      closable={!saving}
      keyboard={!saving}
      mask={{ closable: !saving }}
      okText={editing ? 'Save' : 'Create'}
      width={isMobile ? '95vw' : 520}
      style={isMobile ? { top: 12 } : undefined}
      // Above the instance modal it may be opened from ("Save as template").
      zIndex={1010}
      destroyOnHidden
      styles={{ body: { maxHeight: isMobile ? '75vh' : '70vh', overflowY: 'auto', overflowX: 'hidden' } }}
    >
      {/* name: prefixes the field ids, which would otherwise repeat the
          instance form's while this modal is stacked over it. */}
      <Form form={form} name="template" layout="vertical" disabled={saving} onFinish={handleSubmit} initialValues={initialValues} scrollToFirstError={{ focus: true }} style={{ marginTop: 16 }}>
        <Form.Item
          name="templateName"
          label="Template Name"
          rules={[
            { required: true, whitespace: true, message: 'Name the template' },
            // Counted after trimming, as the server does.
            { validator: (_, value?: string) => ((value ?? '').trim().length <= 128 ? Promise.resolve() : Promise.reject(new Error('At most 128 characters'))) }
          ]}
          extra="Every setting below is optional: creating an instance from this template fills in only what is set here."
        >
          <Input placeholder="RWR Castling server" />
        </Form.Item>
        <InstanceFormFields template />
        <ResetFormOnMount />
      </Form>
    </Modal>
  );
};
