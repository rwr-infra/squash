export class InstanceStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstanceStateError';
  }
}

export const assertInstanceState = (condition: boolean, message: string) => {
  if (!condition) {
    throw new InstanceStateError(message);
  }
};
