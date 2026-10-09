import { useLayoutEffect } from 'react';
import { Form, Input, InputNumber, Select, Switch } from 'antd';
import { stopCommandKeys } from '../services/instanceForm';

// The form instance outlives the modal's content, and a remounted <Form> lets
// the values left in its store win over new initialValues — editing B right
// after A would show, and save, A's values. Rendered inside the <Form> — as
// its LAST child: only fields mounted before it hear the reset — this resets
// it to the current initialValues once it has mounted, before the browser
// paints. (Not clearOnDestroy: StrictMode's simulated unmount would
// empty the store behind inputs that still show values. Not an effect in the
// page: the modal's content mounts in a later commit than the page's.)
export const ResetFormOnMount = () => {
  const form = Form.useFormInstance();
  useLayoutEffect(() => {
    form.resetFields();
  }, [form]);
  return null;
};

// What a stop will type into the console: in the text box a trailing empty
// line (an Enter) is invisible.
const describeStopCommand = (value: string | undefined) => {
  const keys = stopCommandKeys(value);
  if (keys.length === 0) return 'Blank: SIGHUP on Linux/macOS, an immediate kill on Windows.';
  return `Sends, a second apart: ${keys.map((key) => (key === '⏎' ? '⏎ (Enter)' : key)).join(' → ')}`;
};

// The instance settings after the Instance ID, shared by the instance form
// and the template form. In a template every field is optional: only what is
// filled in is saved, and applying the template fills only that.
export const InstanceFormFields = ({ template = false }: { template?: boolean }) => {
  const form = Form.useFormInstance();
  const stopCommandValue = Form.useWatch('stopCommand', form);
  const required = !template;
  return (
    <>
      <Form.Item name="name" label="Name" tooltip="Defaults to the Instance ID if left blank">
        <Input placeholder={template ? 'Not set' : 'Defaults to the Instance ID'} />
      </Form.Item>
      <Form.Item name="cwd" label="Working Directory" rules={[{ required }]}>
        <Input placeholder={template ? 'Not set' : '/path/to/server'} />
      </Form.Item>
      <Form.Item name="executable" label="Executable" rules={[{ required }]}>
        <Input placeholder={template ? 'Not set' : './rwr_server'} />
      </Form.Item>
      <Form.Item name="args" label="Arguments (comma-separated)">
        <Input placeholder="--config server.cfg, --port 27015" />
      </Form.Item>
      <Form.Item name="autoStart" label="Auto Start" valuePropName="checked" tooltip="Start this instance automatically when squash launches">
        <Switch />
      </Form.Item>
      <Form.Item name="restartPolicy" label="Restart Policy" rules={[{ required }]} extra="Keep running also restarts after exit code 0. Stop always cancels recovery. Retries back off and pause after 5 consecutive attempts.">
        <Select
          allowClear={template}
          placeholder={template ? 'Not set' : undefined}
          options={[
            { value: 'never', label: 'Disabled' },
            { value: 'on-failure', label: 'On failure (non-zero exit or signal)' },
            { value: 'always', label: 'Keep running (recommended for RWR)' }
          ]}
        />
      </Form.Item>
      <Form.Item name="restartDelayMs" label="Restart Delay (ms)">
        <InputNumber min={0} step={1000} placeholder={template ? '3000' : undefined} style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item
        name="stopCommand"
        label="Stop Command"
        tooltip="Console command(s) that shut the server down, one per line, sent about a second apart; an empty line presses Enter. rwr_server: quit, then an empty line (it waits for Enter after 'Exit requested')."
        extra={describeStopCommand(stopCommandValue)}
      >
        <Input.TextArea placeholder={'quit\n(empty line = press Enter)'} autoSize={{ minRows: 1, maxRows: 5 }} />
      </Form.Item>
      <Form.Item name="stopTimeoutMs" label="Stop Timeout (ms)" tooltip="Force-kill the server if it is still running this long after the stop began (counted from the first stop command line, so allow a second per extra line). Blank: 15000">
        <InputNumber min={1000} max={600000} step={1000} precision={0} placeholder="15000" style={{ width: '100%' }} />
      </Form.Item>
    </>
  );
};
