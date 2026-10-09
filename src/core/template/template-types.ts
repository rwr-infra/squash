import type { InstanceConfig } from '../instance/instance-types.js';

// The instance settings a template can prefill: everything the instance form
// edits except the ID. All optional — a template stores only what was filled
// in, and applying it fills only those fields. Applying copies the values: a
// later change to the template leaves instances created from it alone.
export type InstanceTemplateValues = Partial<
  Pick<
    InstanceConfig,
    'name' | 'cwd' | 'executable' | 'args' | 'autoStart' | 'restartPolicy' | 'restartDelayMs' | 'stopCommand' | 'stopTimeoutMs'
  >
>;

export type InstanceTemplate = {
  readonly id: string;
  readonly name: string;
  readonly values: InstanceTemplateValues;
};
