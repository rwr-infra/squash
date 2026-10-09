import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Alert, Button, ConfigProvider, Grid, Space, Spin, Switch, Tooltip, theme } from 'antd';
import { ApartmentOutlined, ArrowLeftOutlined, CloseOutlined, ReloadOutlined, SearchOutlined, VerticalAlignBottomOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { ApiError, fetchServerLogInfo, fetchServerLogLines } from '../services/apiService';
import type { ServerLogInfo } from '../services/apiService';
import { LogViewport } from '../components/LogViewport';
import type { LogViewportHandle } from '../components/LogViewport';
import { LogSearchBar } from '../components/LogSearchBar';
import type { LogSearchHandle } from '../components/LogSearchBar';

// Lines per request and per cache entry.
const BLOCK_LINES = 200;
// Blocks kept around the view (8,000 lines); the farthest go first.
const MAX_BLOCKS = 40;
// Block requests at once; the ones nearest the view go first.
const MAX_IN_FLIGHT = 4;
// The view must rest this long before blocks load (dragging the scrollbar
// across a big file would otherwise request every block it passes).
const LOAD_DELAY_MS = 60;
const POLL_MS = 2000;
const MAX_RETRY_MS = 10_000;

// A block as read: its lines and the file as the server saw it then.
type Block = {
  readonly generation: string;
  readonly lines: readonly string[];
  readonly size: number;
  readonly lineCount: number;
};

const isNotFound = (error: unknown) => error instanceof ApiError && error.code === 'INSTANCE_NOT_FOUND';

// Whether a block can stand for the file as `info` describes it. A block
// that ended before the last line of its read is final; one holding that
// last line may have been read before an append completed or extended it.
const isCurrent = (block: Block, index: number, info: ServerLogInfo) =>
  block.generation === info.generation && ((index + 1) * BLOCK_LINES < block.lineCount || block.size >= info.size);

const formatBytes = (bytes: number) =>
  bytes < 1024 ? `${bytes} B`
    : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB`
      : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
        : `${(bytes / 1024 ** 3).toFixed(2)} GB`;

const ServerLogPage = () => {
  const { instanceId = '' } = useParams<{ instanceId: string }>();
  const navigate = useNavigate();
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;
  const viewportRef = useRef<LogViewportHandle>(null);
  const searchRef = useRef<LogSearchHandle>(null);
  const [follow, setFollow] = useState(true);
  // When this page saw the log emptied or replaced (rwr_server restarted).
  const [resetAt, setResetAt] = useState<Date | undefined>();
  const [blocks, setBlocks] = useState<ReadonlyMap<number, Block>>(new Map());
  const [loadError, setLoadError] = useState<string | undefined>();
  // Bumped to retry failed block loads.
  const [retryTick, setRetryTick] = useState(0);

  // The file as this page last saw it (not the query cache's: that may be
  // from an earlier visit).
  const seen = useRef<ServerLogInfo | undefined>(undefined);
  const { data: info, error, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['server-log', instanceId],
    queryFn: async () => {
      const next = await fetchServerLogInfo(instanceId);
      const previous = seen.current;
      if (previous?.exists && next.exists && previous.generation !== next.generation) {
        // A new run's log: show its end. Cached blocks are keyed by
        // generation and simply stop matching; search results describe
        // lines that are gone.
        setResetAt(new Date());
        setFollow(true);
        searchRef.current?.reset();
      }
      seen.current = next;
      return next;
    },
    gcTime: 0,
    refetchInterval: (query) => (isNotFound(query.state.error) ? false : POLL_MS),
    // A 404 (no such instance) won't fix itself.
    retry: (count, err) => !isNotFound(err) && count < 3
  });

  // Mirrors for the loader, which runs from callbacks and timers.
  const infoRef = useRef<ServerLogInfo | undefined>(undefined);
  const blocksRef = useRef(blocks);
  const rangeRef = useRef({ from: 0, to: 0, first: 0 });
  const inFlight = useRef(new Map<number, { readonly generation: string; readonly controller: AbortController }>());
  const retryDelay = useRef(1000);
  useEffect(() => {
    infoRef.current = info;
    blocksRef.current = blocks;
  });

  // Fetches the blocks covering the rows in view that aren't current,
  // nearest first, and drops requests the view has moved away from.
  const load = useCallback(() => {
    const current = infoRef.current;
    if (!current?.exists) return;
    const { from, to } = rangeRef.current;
    const first = Math.floor(from / BLOCK_LINES);
    const last = Math.floor(Math.max(from, to - 1) / BLOCK_LINES);
    for (const [index, request] of inFlight.current) {
      if (index < first || index > last || request.generation !== current.generation) {
        request.controller.abort();
        inFlight.current.delete(index);
      }
    }
    const centre = (from + to) / 2 / BLOCK_LINES;
    const wanted: number[] = [];
    for (let index = first; index <= last; index++) {
      const block = blocksRef.current.get(index);
      if ((!block || !isCurrent(block, index, current)) && !inFlight.current.has(index)) wanted.push(index);
    }
    wanted.sort((a, b) => Math.abs(a + 0.5 - centre) - Math.abs(b + 0.5 - centre));
    for (const index of wanted.slice(0, Math.max(0, MAX_IN_FLIGHT - inFlight.current.size))) {
      const controller = new AbortController();
      inFlight.current.set(index, { generation: current.generation, controller });
      fetchServerLogLines(instanceId, index * BLOCK_LINES, BLOCK_LINES, controller.signal).then(
        (result) => {
          if (inFlight.current.get(index)?.controller === controller) inFlight.current.delete(index);
          // Read after the file was started over: other content. The next
          // poll moves the page to the new generation.
          if (controller.signal.aborted || result.generation !== infoRef.current?.generation) return;
          retryDelay.current = 1000;
          setLoadError(undefined);
          setBlocks((previous) => {
            const next = new Map([...previous].filter(([, block]) => block.generation === result.generation));
            next.set(index, { generation: result.generation, lines: result.lines, size: result.size, lineCount: result.lineCount });
            if (next.size > MAX_BLOCKS) {
              const middle = (rangeRef.current.from + rangeRef.current.to) / 2 / BLOCK_LINES;
              const farthest = [...next.keys()].sort((a, b) => Math.abs(b - middle) - Math.abs(a - middle));
              for (const key of farthest.slice(0, next.size - MAX_BLOCKS)) next.delete(key);
            }
            return next;
          });
        },
        (err: Error) => {
          if (inFlight.current.get(index)?.controller === controller) inFlight.current.delete(index);
          if (controller.signal.aborted) return;
          // Try again later, backing off; say why meanwhile.
          setLoadError(err.message);
          const delay = retryDelay.current;
          retryDelay.current = Math.min(MAX_RETRY_MS, delay * 2);
          setTimeout(() => setRetryTick((tick) => tick + 1), delay);
        }
      );
    }
  }, [instanceId]);

  // New lines, a new generation, a block arrived (others may wait for a
  // free slot) or a retry: load what the view needs.
  useEffect(() => {
    load();
  }, [info, blocks, retryTick, load]);

  // The view moved: load once it rests.
  const loadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onRangeChange = useCallback((from: number, to: number, first: number) => {
    rangeRef.current = { from, to, first };
    clearTimeout(loadTimer.current);
    loadTimer.current = setTimeout(load, LOAD_DELAY_MS);
  }, [load]);

  useEffect(() => {
    const requests = inFlight.current;
    return () => {
      clearTimeout(loadTimer.current);
      for (const request of requests.values()) request.controller.abort();
    };
  }, []);

  const getLine = (line: number) => {
    const block = blocks.get(Math.floor(line / BLOCK_LINES));
    return block && block.generation === info?.generation ? block.lines[line % BLOCK_LINES] : undefined;
  };

  const notFound = isNotFound(error);
  const muted = { color: '#888', fontSize: 12 };

  return (
    <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100svh', background: '#1e1e1e', color: '#d4d4d4' }}>
        <div style={{ padding: '8px 12px', background: '#252526', borderBottom: '1px solid #3c3c3c', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <Button icon={<ArrowLeftOutlined />} size="small" onClick={() => navigate('/')} type="text" style={{ color: '#fff' }} title="Back to instances" />
          <code style={{ color: '#fff', background: '#3c3c3c', padding: '2px 8px', borderRadius: 4, wordBreak: 'break-all', maxWidth: '40vw' }}>{instanceId}</code>
          <strong style={{ color: '#fff' }}>rwr_server.log</strong>
          {info?.exists && (
            <span style={muted}>
              {info.lineCount.toLocaleString()} lines · {formatBytes(info.size)}
              {info.modifiedAt && !isMobile ? ` · updated ${new Date(info.modifiedAt).toLocaleTimeString()}` : ''}
            </span>
          )}
          <Space style={{ marginLeft: 'auto' }} wrap>
            <Tooltip title="Find (Ctrl+F / ⌘F)">
              <Button size="small" icon={<SearchOutlined />} disabled={!info?.exists} onClick={() => searchRef.current?.open()} aria-label="Find in rwr_server.log" />
            </Tooltip>
            <Tooltip title="Keep showing the newest lines">
              <Space size={4}>
                <Switch size="small" checked={follow} onChange={(on) => { if (!on) viewportRef.current?.holdEnd(); setFollow(on); }} aria-label="Follow new lines" />
                <span style={{ fontSize: 12 }}>Follow</span>
              </Space>
            </Tooltip>
            <Button size="small" icon={<VerticalAlignBottomOutlined />} onClick={() => setFollow(true)} title="Jump to the end and follow">{isMobile ? null : 'End'}</Button>
            <Button size="small" icon={<ReloadOutlined />} loading={isFetching && !info} onClick={() => refetch()} title="Check for new lines now" />
            <Button size="small" icon={<ApartmentOutlined />} onClick={() => navigate(`/terminal/${encodeURIComponent(instanceId)}`)} title="Open Terminal">{isMobile ? null : 'Terminal'}</Button>
          </Space>
        </div>

        {info && (
          <div style={{ ...muted, padding: '4px 12px', background: '#252526', borderBottom: '1px solid #3c3c3c', wordBreak: 'break-all' }}>{info.path}</div>
        )}

        {resetAt && (
          <Alert
            type="info"
            showIcon
            banner
            // antd only treats an object as closable when it names the icon.
            closable={{ closeIcon: <CloseOutlined />, onClose: () => setResetAt(undefined) }}
            title={`The log was emptied or replaced at ${resetAt.toLocaleTimeString()} (rwr_server clears it when it starts). Showing the new file.`}
          />
        )}
        {error && info && !notFound && <Alert type="warning" showIcon banner title={`Could not check for new lines: ${(error as Error).message}`} />}
        {loadError && info?.exists && <Alert type="warning" showIcon banner title={`Could not load lines: ${loadError}. Retrying…`} />}

        {notFound ? (
          <Alert type="error" showIcon style={{ margin: 12 }} title={`Instance ${instanceId} not found`} />
        ) : error && !info ? (
          <Alert type="error" showIcon style={{ margin: 12 }} title={(error as Error).message} action={<Button size="small" onClick={() => refetch()}>Retry</Button>} />
        ) : isLoading || !info ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1 }}><Spin /></div>
        ) : !info.exists ? (
          <Alert
            type="warning"
            showIcon
            style={{ margin: 12 }}
            title="No rwr_server.log yet"
            description="rwr_server writes it in its working directory (the path above) once it starts. This page checks again every few seconds."
          />
        ) : (
          <LogSearchBar
            ref={searchRef}
            instanceId={instanceId}
            generation={info.generation}
            size={info.size}
            firstVisibleLine={() => rangeRef.current.first}
            onJump={(line) => viewportRef.current?.scrollToLine(line)}
            onClose={() => viewportRef.current?.focus()}
          >
            {(search) => (
              <LogViewport
                ref={viewportRef}
                lineCount={info.lineCount}
                getLine={getLine}
                onRangeChange={onRangeChange}
                follow={follow}
                onFollowChange={setFollow}
                renderLine={search.renderLine}
                activeLine={search.activeLine}
              />
            )}
          </LogSearchBar>
        )}
      </div>
    </ConfigProvider>
  );
};

export default ServerLogPage;
