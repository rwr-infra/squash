const splitBufferedValue = (value: string) => {
  const segments = value.split(/\r?\n/);
  const trailing = segments.pop() ?? '';

  return {
    completed: segments,
    trailing
  };
};

export const createOutputParser = () => {
  let buffer = '';

  return {
    push(chunk: string) {
      const nextValue = `${buffer}${chunk}`;
      const nextState = splitBufferedValue(nextValue);

      buffer = nextState.trailing;
      return nextState.completed;
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
