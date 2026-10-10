// Which file an instance's log viewer reads (InstanceConfig.serverLogFile):
//   - only paths inside the working directory are accepted — on both
//     platforms' rules, by the instance and the template schemas alike
//   - a config or request without the field gets rwr_server.log when the
//     executable is rwr_server (any directory, optional .exe, any case),
//     else none; an explicit value, '' included, is kept
import { describe, expect, it } from 'vitest';
import { inferServerLogFile, isValidServerLogFile, serverLogFileOf } from '../../src/core/log/server-log-file.js';
import { CreateInstanceSchema } from '../../src/api/http/schemas/instance-schemas.js';
import { TemplateValuesSchema } from '../../src/api/http/schemas/template-schemas.js';

const INSIDE = ['rwr_server.log', 'server.log', 'logs/server.log', 'logs\\server.log', './rwr_server.log', 'a/./b.log', '...log', 'log', 'console.log', 'nul_x.log', 'com10.log', 'x'.repeat(260)];
const OUTSIDE = [
  '',
  '/etc/passwd',
  '\\Windows\\win.ini',
  'C:\\x.log',
  'c:/x.log',
  'C:x.log',
  '\\\\host\\share\\x.log',
  '//host/share/x.log',
  '..',
  '../x.log',
  '..\\x.log',
  'a/../../x.log',
  'a/../x.log',
  '.. /x.log',
  '.. \\x.log',
  '... /x.log',
  'a/ . /x.log',
  ' ',
  'logs/..',
  'logs/',
  'logs\\',
  '.',
  'logs/.',
  'NUL',
  'nul.log',
  'logs/CON',
  'com1.txt',
  'LPT9',
  'aux .log',
  'conout$',
  'a\0b.log',
  'x'.repeat(261)
];

describe('isValidServerLogFile', () => {
  it.each([undefined, null, 42, true, {}, ['rwr_server.log']])('%j (not text) is refused', value => {
    expect(isValidServerLogFile(value)).toBe(false);
  });
  it.each(INSIDE)('%j is inside the working directory', value => {
    expect(isValidServerLogFile(value)).toBe(true);
  });
  it.each(OUTSIDE)('%j is refused', value => {
    expect(isValidServerLogFile(value)).toBe(false);
  });
});

describe('inferServerLogFile', () => {
  it.each(['./rwr_server', 'rwr_server', 'rwr_server.exe', 'RWR_Server.EXE', '/opt/rwr/rwr_server', 'C:\\rwr\\rwr_server.exe'])(
    '%j → rwr_server.log',
    executable => {
      expect(inferServerLogFile(executable)).toBe('rwr_server.log');
    }
  );
  it.each(['./steamcmd', 'steamcmd.exe', './rwr_server2', './rwr_server.bak', './rwr_server.sh', './rwr_server_x', '/opt/rwr_server/run', '', undefined, 42])('%j → none', executable => {
    expect(inferServerLogFile(executable)).toBe('');
  });
  it('an explicit value wins, an empty one too', () => {
    expect(serverLogFileOf({ executable: './rwr_server', serverLogFile: '' })).toBe('');
    expect(serverLogFileOf({ executable: './rwr_server', serverLogFile: 42 })).toBe('');
    expect(serverLogFileOf({ executable: './steamcmd', serverLogFile: 'logs/x.log' })).toBe('logs/x.log');
    expect(serverLogFileOf({ executable: './rwr_server' })).toBe('rwr_server.log');
  });
});

describe('CreateInstanceSchema', () => {
  const body = { id: 'a', name: 'a', cwd: '.' };
  it('a request without serverLogFile follows the executable', () => {
    expect(CreateInstanceSchema.parse({ ...body, executable: './rwr_server' }).serverLogFile).toBe('rwr_server.log');
    expect(CreateInstanceSchema.parse({ ...body, executable: './steamcmd' }).serverLogFile).toBe('');
  });
  it('an explicit value is kept, an empty one too', () => {
    expect(CreateInstanceSchema.parse({ ...body, executable: './rwr_server', serverLogFile: '' }).serverLogFile).toBe('');
    expect(CreateInstanceSchema.parse({ ...body, executable: './steamcmd', serverLogFile: 'logs/x.log' }).serverLogFile).toBe('logs/x.log');
  });
  it.each(OUTSIDE.filter(value => value !== ''))('serverLogFile %j is rejected', serverLogFile => {
    expect(CreateInstanceSchema.safeParse({ ...body, executable: './rwr_server', serverLogFile }).success).toBe(false);
  });
  it('a non-string serverLogFile is rejected', () => {
    expect(CreateInstanceSchema.safeParse({ ...body, executable: './rwr_server', serverLogFile: null }).success).toBe(false);
    expect(CreateInstanceSchema.safeParse({ ...body, executable: './rwr_server', serverLogFile: true }).success).toBe(false);
  });
});

describe('TemplateValuesSchema', () => {
  it('takes a file inside the working directory', () => {
    expect(TemplateValuesSchema.safeParse({ serverLogFile: 'logs/server.log' }).success).toBe(true);
  });
  it.each(OUTSIDE)('serverLogFile %j is rejected (a template stores only a file)', serverLogFile => {
    expect(TemplateValuesSchema.safeParse({ serverLogFile }).success).toBe(false);
  });
});
