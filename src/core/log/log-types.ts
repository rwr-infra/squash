export type InstanceLogWriter = {
  writeLines: (lines: readonly string[]) => Promise<void>;
};
