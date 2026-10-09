import { randomUUID } from 'node:crypto';
import type { TemplateStore } from '../core/config/template-store.js';
import type { InstanceTemplate, InstanceTemplateValues } from '../core/template/template-types.js';

export class TemplateNameTakenError extends Error {
  constructor(name: string) {
    super(`A template named "${name}" already exists`);
    this.name = 'TemplateNameTakenError';
  }
}

export type TemplateInput = {
  readonly name: string;
  readonly values: InstanceTemplateValues;
};

// Names are what the template picker shows, so two that differ only in case
// would be indistinguishable there.
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const assertNameFree = (templates: ReadonlyMap<string, InstanceTemplate>, name: string) => {
  for (const template of templates.values()) {
    if (sameName(template.name, name)) {
      throw new TemplateNameTakenError(name);
    }
  }
};

export class TemplateService {
  constructor(private readonly store: TemplateStore) {}

  listTemplates(): readonly InstanceTemplate[] {
    return this.store.list();
  }

  createTemplate(input: TemplateInput): Promise<InstanceTemplate> {
    return this.store.update(templates => {
      assertNameFree(templates, input.name);
      const template: InstanceTemplate = { id: randomUUID(), name: input.name, values: input.values };
      templates.set(template.id, template);
      return template;
    });
  }

  updateTemplate(id: string, input: TemplateInput): Promise<InstanceTemplate | undefined> {
    return this.store.update(templates => {
      const existing = templates.get(id);
      if (!existing) {
        return undefined;
      }
      // Keeping its own name (in any case) is always allowed — also when a
      // hand-edited file already holds a clashing one.
      if (!sameName(existing.name, input.name)) {
        assertNameFree(templates, input.name);
      }
      const template: InstanceTemplate = { id, name: input.name, values: input.values };
      templates.set(id, template);
      return template;
    });
  }

  deleteTemplate(id: string): Promise<boolean> {
    return this.store.update(templates => templates.delete(id));
  }
}
