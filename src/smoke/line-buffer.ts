const splitTrailingBuffer = (value: string) => {
  const parts = value.split(/\r?\n/);
  const trailing = parts.pop() ?? '';

  return { completed: parts, trailing };
};

export const createLineBuffer = () => {
  let buffer = '';

  return {
    push(chunk: string) {
      const nextValue = `${buffer}${chunk}`;
      const { completed, trailing } = splitTrailingBuffer(nextValue);

      buffer = trailing;
      return completed;
    },
    flush() {
      if (!buffer) {
        return [] as string[];
      }

      const pending = buffer;
      buffer = '';
      return [pending];
    }
  };
};
