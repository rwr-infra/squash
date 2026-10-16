import { useLayoutEffect } from 'react';
import { Form, Input, InputNumber, Select, Switch } from 'antd';
import type { SwitchProps } from 'antd';
import { SERVER_LOG_HISTORY_LIMITS, isHistoryLimit, isValidServerLogFile, stopCommandKeys } from '../services/instanceForm';

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

// The switch for keeping previous logs: off and disabled while there is no
// log file to keep (the value stays, and is not sent). Otherwise `disabled`
// is left to the form (a save in flight): an explicit false would win.
// Form.Item's props (id, checked, onChange) pass through.
const KeepPreviousLogsSwitch = ({ checked, noLogFile, ...props }: SwitchProps & { noLogFile: boolean }) => (
  <Switch {...props} checked={!!checked && !noLogFile} disabled={noLogFile || undefined} />
);

// A limit for keeping previous logs, checked only while it will be sent:
// the switch on (and, in an instance, a log file). Read from the form's
// store when validating, not from a watch, which updates a render later.
const historyLimitRule = (limits: { readonly min: number; readonly max: number }, what: string, template: boolean) => ({ getFieldValue }: { getFieldValue: (name: string) => unknown }) => ({
  validator: (_: unknown, value: unknown) => {
    const sent = getFieldValue('keepPreviousLogs') && (template || !!(getFieldValue('serverLogFile') as string | undefined)?.trim());
    if (!sent || isHistoryLimit(value, limits)) return Promise.resolve();
    return Promise.reject(new Error(value === null || value === undefined ? `How many ${what} to keep` : `${limits.min} to ${limits.max} ${what}`));
  }
});

// The instance settings after the Instance ID, shared by the instance form
// and the template form. In a template every field is optional: only what is
// filled in is saved, and applying the template fills only that. Without
// `advanced` only the essentials show (Name, Working Directory, Executable);
// the rest stay in the form — hidden, still validated and submitted.
export const InstanceFormFields = ({ template = false, advanced = true }: { template?: boolean; advanced?: boolean }) => {
  const form = Form.useFormInstance();
  const stopCommandValue = Form.useWatch('stopCommand', form);
  const keepPreviousLogs = Form.useWatch('keepPreviousLogs', form);
  const serverLogFile = Form.useWatch('serverLogFile', form);
  const required = !template;
  const hidden = !advanced;
  // A template may leave the log file to the executable. (Before the watch
  // has a value — the first render — nothing is known yet.)
  const noLogFile = !template && serverLogFile !== undefined && !serverLogFile.trim();
  const limitsHidden = hidden || !keepPreviousLogs || noLogFile;
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
      <Form.Item name="args" label="Arguments (comma-separated)" hidden={hidden}>
        <Input placeholder="--config server.cfg, --port 27015" />
      </Form.Item>
      <Form.Item
        name="serverLogFile"
        label="Server Log File"
        hidden={hidden}
        tooltip="The log file the server writes, relative to the Working Directory, shown on the Log page (rwr_server: rwr_server.log)."
        extra={template ? 'Not set: the executable decides when an instance is created (rwr_server → rwr_server.log).' : 'Blank: no Log page for this instance (e.g. SteamCMD).'}
        rules={[
          {
            validator: (_, value: string | undefined) =>
              !value?.trim() || isValidServerLogFile(value.trim())
                ? Promise.resolve()
                : Promise.reject(new Error('A file inside the Working Directory: no absolute path, drive or ".."'))
          }
        ]}
      >
        <Input placeholder={template ? 'Not set' : 'rwr_server.log'} />
      </Form.Item>
      <Form.Item
        name="keepPreviousLogs"
        label="Keep Previous Logs"
        valuePropName="checked"
        hidden={hidden}
        tooltip="rwr_server empties its log whenever it starts. Before every start the previous one is moved into a folder next to it (rwr_server.log.history), named after the time it was last written, and shown on the Log page. Logs older than the days or past the count are deleted; the newest is always kept."
        extra={noLogFile ? 'Needs a Server Log File.' : template && !keepPreviousLogs ? 'Off: instances made from this template keep none.' : undefined}
      >
        <KeepPreviousLogsSwitch noLogFile={noLogFile} />
      </Form.Item>
      {/* Always in the form, hidden while off: what is sent must not depend
          on whether a render has caught up with the switch. Their values
          come with the form's (the defaults while off). */}
      <div style={{ display: limitsHidden ? 'none' : 'flex', gap: 12 }}>
        <Form.Item
          name={['serverLogHistory', 'keepDays']}
          label="Keep for (days)"
          dependencies={['keepPreviousLogs', 'serverLogFile']}
          rules={[historyLimitRule(SERVER_LOG_HISTORY_LIMITS.keepDays, 'days', template)]}
          hidden={limitsHidden}
          style={{ flex: 1 }}
        >
          <InputNumber min={SERVER_LOG_HISTORY_LIMITS.keepDays.min} max={SERVER_LOG_HISTORY_LIMITS.keepDays.max} precision={0} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item
          name={['serverLogHistory', 'keepFiles']}
          label="Keep at most (logs)"
          dependencies={['keepPreviousLogs', 'serverLogFile']}
          rules={[historyLimitRule(SERVER_LOG_HISTORY_LIMITS.keepFiles, 'logs', template)]}
          hidden={limitsHidden}
          style={{ flex: 1 }}
        >
          <InputNumber min={SERVER_LOG_HISTORY_LIMITS.keepFiles.min} max={SERVER_LOG_HISTORY_LIMITS.keepFiles.max} precision={0} style={{ width: '100%' }} />
        </Form.Item>
      </div>
      <Form.Item name="autoStart" label="Auto Start" valuePropName="checked" hidden={hidden} tooltip="Start this instance automatically when squash launches">
        <Switch />
      </Form.Item>
      <Form.Item name="restartPolicy" label="Restart Policy" rules={[{ required }]} hidden={hidden} extra="Keep running also restarts after exit code 0. Stop always cancels recovery. Retries back off and pause after 5 consecutive attempts.">
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
      <Form.Item name="restartDelayMs" label="Restart Delay (ms)" hidden={hidden}>
        <InputNumber min={0} step={1000} placeholder={template ? '3000' : undefined} style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item
        name="stopCommand"
        label="Stop Command"
        hidden={hidden}
        tooltip="Console command(s) that shut the server down, one per line, sent about a second apart; an empty line presses Enter. rwr_server: quit, then an empty line (it waits for Enter after 'Exit requested')."
        extra={describeStopCommand(stopCommandValue)}
      >
        <Input.TextArea placeholder={'quit\n(empty line = press Enter)'} autoSize={{ minRows: 1, maxRows: 5 }} />
      </Form.Item>
      <Form.Item name="stopTimeoutMs" label="Stop Timeout (ms)" hidden={hidden} tooltip="Force-kill the server if it is still running this long after the stop began (counted from the first stop command line, so allow a second per extra line). Blank: 15000">
        <InputNumber min={1000} max={600000} step={1000} precision={0} placeholder="15000" style={{ width: '100%' }} />
      </Form.Item>
    </>
  );
};
