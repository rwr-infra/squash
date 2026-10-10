import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { MouseEvent, ReactNode, Ref } from 'react';
import { Button, Input, Space, Tooltip, Typography } from 'antd';
import type { InputRef } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined, CloseOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { searchServerLog } from '../services/apiService';
import type { ServerLogSearchResult } from '../services/apiService';

export type LogSearchHandle = {
  open: () => void;
  // The log was started over: results describe content that is gone.
  reset: () => void;
};

// What the viewport needs from the search: marks in each line, and the
// current match's row.
export type LogSearchView = {
  renderLine?: (text: string) => ReactNode;
  activeLine?: number;
};

type Props = {
  ref?: Ref<LogSearchHandle>;
  instanceId: string;
  // The file as the page last saw it.
  generation: string;
  size: number;
  // The first line in view: a new search starts at the first match from there.
  firstVisibleLine: () => number;
  onJump: (line: number) => void;
  // The bar closed: give the keyboard back to the log.
  onClose: () => void;
  children: (view: LogSearchView) => ReactNode;
};

type Results = ServerLogSearchResult & { readonly query: string; readonly caseSensitive: boolean };

// Marks per line at most: a long line and a one-letter query could otherwise
// make tens of thousands of elements.
const MAX_MARKS_PER_LINE = 100;
// The server's mark on a line cut at 16 KiB; not log text.
const CUT_MARK = / … \[\d+ more bytes\]$/;

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

// Case folding as the server does it: lower case, and the Greek final sigma
// as the plain one.
const fold = (text: string) => text.toLowerCase().replace(/ς/g, 'σ');

// Marks occurrences of `query` in `text` (none where folding changes the
// text's length, which would misplace them; none in the cut mark).
const highlight = (text: string, query: string, caseSensitive: boolean): ReactNode => {
  const cut = CUT_MARK.exec(text);
  const body = cut ? text.slice(0, cut.index) : text;
  const haystack = caseSensitive ? body : fold(body);
  const needle = caseSensitive ? query : fold(query);
  if (needle.length === 0 || haystack.length !== body.length) return text;
  const parts: ReactNode[] = [];
  let from = 0;
  for (let at = haystack.indexOf(needle); at !== -1 && parts.length < MAX_MARKS_PER_LINE * 2; at = haystack.indexOf(needle, from)) {
    if (at > from) parts.push(body.slice(from, at));
    parts.push(<mark key={at} className="log-match">{body.slice(at, at + needle.length)}</mark>);
    from = at + needle.length;
  }
  if (parts.length === 0) return text;
  parts.push(text.slice(from));
  return parts;
};

// Keeps the focus in the find box when a bar button is clicked, so Enter
// keeps searching (and doesn't press the button again).
const keepFocus = (event: MouseEvent) => event.preventDefault();

// The find bar. Ctrl+F (⌘F on macOS) opens it instead of the browser's own
// find, which only sees the rows on screen; the server searches the whole
// file. Enter / F3: next match; Shift+Enter / Shift+F3: previous; Esc closes.
export const LogSearchBar = ({ ref, instanceId, generation, size, firstVisibleLine, onJump, onClose, children }: Props) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [results, setResults] = useState<Results | undefined>();
  const [index, setIndex] = useState(-1);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // Past the matches the server listed (it lists the first 10,000).
  const [beyond, setBeyond] = useState(false);
  const inputRef = useRef<InputRef>(null);
  const request = useRef<AbortController | undefined>(undefined);
  // The generation as of the latest render, for results that arrive late.
  const generationRef = useRef(generation);
  useEffect(() => {
    generationRef.current = generation;
  });

  const cancel = () => {
    request.current?.abort();
    request.current = undefined;
    setSearching(false);
  };

  const openBar = () => {
    setOpen(true);
    // Mounted already: focus now. Otherwise the input's autoFocus does it
    // (within the user's gesture, which iOS needs to show the keyboard).
    inputRef.current?.focus({ cursor: 'all' });
  };

  useImperativeHandle(ref, () => ({
    open: openBar,
    reset: () => {
      cancel();
      setResults(undefined);
      setIndex(-1);
      setError(undefined);
      setBeyond(false);
    }
  }), []);

  useEffect(() => () => request.current?.abort(), []);

  // Results answer the query as typed, for this file.
  const current = results && results.query === query && results.caseSensitive === caseSensitive && results.generation === generation ? results : undefined;
  // The file grew since: Enter keeps stepping; "Search again" includes the new part.
  const stale = current !== undefined && size > current.size;

  const jump = (matches: readonly number[], next: number) => {
    setIndex(next);
    setBeyond(false);
    onJump(matches[next]!);
  };

  const run = async () => {
    cancel();
    setError(undefined);
    if (!query) {
      setResults(undefined);
      setIndex(-1);
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setSearching(true);
    try {
      const found = await searchServerLog(instanceId, query, caseSensitive, controller.signal);
      if (controller.signal.aborted) return;
      setResults({ ...found, query, caseSensitive });
      setIndex(-1);
      // A result for an older or newer file: keep it out of the view.
      if (found.matches.length === 0 || found.generation !== generationRef.current) return;
      const start = firstVisibleLine();
      const below = found.matches.findIndex((line) => line >= start);
      if (below !== -1) {
        jump(found.matches, below);
      } else if (found.truncated) {
        // Every listed match is above the view and more exist: show the
        // nearest one, and say the rest isn't listed.
        jump(found.matches, found.matches.length - 1);
        setBeyond(true);
      } else {
        jump(found.matches, 0);
      }
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally {
      if (request.current === controller) {
        request.current = undefined;
        setSearching(false);
      }
    }
  };

  const step = (direction: 1 | -1) => {
    // Already searching for this: one search is enough.
    if (searching) return;
    if (!current) {
      void run();
      return;
    }
    const count = current.matches.length;
    if (count === 0) return;
    if (index === -1) {
      jump(current.matches, direction === 1 ? 0 : count - 1);
      return;
    }
    const next = index + direction;
    if (next >= count && current.truncated) {
      // The server listed the first 10,000; there is no "next" to wrap to.
      setBeyond(true);
      return;
    }
    jump(current.matches, (next + count) % count);
  };

  const close = () => {
    cancel();
    setError(undefined);
    setOpen(false);
    onClose();
  };

  // Ctrl+F (⌘F on macOS) (re)opens the bar; F3 steps and Esc closes while
  // it is open. Read through the ref: the listener stays registered.
  const keyRef = useRef<(event: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    keyRef.current = (event) => {
      const find = (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
        && !event.altKey && !event.shiftKey && (event.code === 'KeyF' || event.key.toLowerCase() === 'f');
      if (find) {
        event.preventDefault();
        openBar();
      } else if (open && event.key === 'F3') {
        event.preventDefault();
        step(event.shiftKey ? -1 : 1);
      } else if (open && event.key === 'Escape' && !event.isComposing) {
        event.preventDefault();
        close();
      }
    };
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => keyRef.current(event);
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  let status: ReactNode = null;
  if (searching) status = 'Searching…';
  else if (error) status = <Typography.Text type="danger">{error}</Typography.Text>;
  else if (current) {
    const count = current.matches.length;
    status = count === 0
      ? 'No matches'
      : `${index === -1 ? '–' : (index + 1).toLocaleString()} / ${count.toLocaleString()}${current.truncated ? '+' : ''}`;
    if (beyond) {
      status = <>{status} <Typography.Text type="warning">· only the first {count.toLocaleString()} matches are listed — refine the search</Typography.Text></>;
    }
  }

  const view: LogSearchView = open && current && current.matches.length > 0
    ? { renderLine: (text) => highlight(text, current.query, current.caseSensitive), activeLine: index >= 0 ? current.matches[index] : undefined }
    : {};

  return (
    <>
      {open && (
        <div className="log-search-bar" role="search">
          <Input
            ref={inputRef}
            className="log-search-input"
            autoFocus
            size="small"
            placeholder="Find in rwr_server.log"
            aria-label="Find in rwr_server.log"
            // Phones label their Enter key "Search".
            enterKeyHint="search"
            value={query}
            maxLength={256}
            onFocus={(e) => e.target.select()}
            onChange={(e) => {
              // A new query: the search for the old one no longer matters.
              cancel();
              setError(undefined);
              setQuery(e.target.value);
            }}
            onKeyDown={(e) => {
              // Enter or Esc that picks or drops an IME candidate is not ours.
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                step(e.shiftKey ? -1 : 1);
              }
            }}
          />
          <Space wrap size={6} className="log-search-actions">
            {/* A button to search with, for touch screens (Enter is not a
                gesture to rely on there); once there are results, the arrows. */}
            {!current && (
              <Button size="small" type="primary" icon={<SearchOutlined />} disabled={!query} loading={searching} onMouseDown={keepFocus} onClick={() => step(1)}>
                Search
              </Button>
            )}
            <Tooltip title="Match case">
              <Button
                size="small"
                type={caseSensitive ? 'primary' : 'default'}
                aria-pressed={caseSensitive}
                onMouseDown={keepFocus}
                onClick={() => {
                  cancel();
                  setError(undefined);
                  setCaseSensitive((on) => !on);
                }}
              >
                Aa
              </Button>
            </Tooltip>
            {current && (
              <>
                <Button size="small" icon={<ArrowUpOutlined />} onMouseDown={keepFocus} onClick={() => step(-1)} title="Previous match (Shift+Enter)" />
                <Button size="small" icon={<ArrowDownOutlined />} onMouseDown={keepFocus} onClick={() => step(1)} title="Next match (Enter)" />
              </>
            )}
            <span className="log-search-status" aria-live="polite">{status}</span>
            {stale && !searching && (
              <Tooltip title="New lines arrived since this search">
                <Button size="small" icon={<ReloadOutlined />} onMouseDown={keepFocus} onClick={() => void run()}>Search again</Button>
              </Tooltip>
            )}
            <Button size="small" type="text" icon={<CloseOutlined />} onClick={close} title="Close (Esc)" />
          </Space>
        </div>
      )}
      {children(view)}
    </>
  );
};
