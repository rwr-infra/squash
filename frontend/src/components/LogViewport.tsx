import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, Ref } from 'react';
import './LogViewport.css';

// Every line is one fixed-height row (long lines scroll sideways, no
// wrapping), so a line's position is a multiplication and only the rows in
// view exist in the DOM. Keep in step with .log-row in LogViewport.css.
export const ROW_HEIGHT = 18;
// Browsers cap an element's height (Firefox near 17.9M px). Above this the
// scrollbar maps proportionally onto the lines instead of 1 px = 1 px, and
// the wheel, keys and touch move by lines.
const MAX_SPACER_PX = 8_000_000;
const OVERSCAN_ROWS = 20;

export type LogViewportHandle = {
  // Scrolls `line` (0-based) into view, a third from the top, and stops
  // following.
  scrollToLine: (line: number) => void;
  // Keeps the view at the end once following stops (else it would return to
  // where the user last scrolled).
  holdEnd: () => void;
  // Gives the viewport keyboard focus (arrows, Page Up/Down, Space).
  focus: () => void;
};

type Props = {
  ref?: Ref<LogViewportHandle>;
  lineCount: number;
  // A line's text, or undefined while it loads.
  getLine: (line: number) => string | undefined;
  // The rows to have ready (overscan included), and the first one in view.
  onRangeChange: (from: number, to: number, firstVisible: number) => void;
  // While true the view stays at the end as lines arrive. The viewport
  // reports when the user scrolls away from the end (false) or back (true).
  follow: boolean;
  onFollowChange: (follow: boolean) => void;
  renderLine?: (text: string) => ReactNode;
  // Highlighted row, e.g. the current search match.
  activeLine?: number;
};

type InputHandlers = {
  wheel: (event: WheelEvent) => void;
  touchStart: (event: TouchEvent) => void;
  touchMove: (event: TouchEvent) => void;
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export const LogViewport = ({ ref, lineCount, getLine, onRangeChange, follow, onFollowChange, renderLine, activeLine }: Props) => {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [viewportHeight, setViewportHeight] = useState(0);
  // Where the user put the view (first visible line, fractional). Following
  // overrides it with the end; the native scroll position only maps onto
  // what is shown.
  const [topLine, setTopLine] = useState(0);
  // The shown top line as of the latest move, for input handlers that run
  // several times before the next render (wheel, touch).
  const topRef = useRef(0);
  // A scrollTop we set ourselves, so its scroll event isn't taken for the
  // user's; and the last scrollTop seen, so a sideways scroll is not taken
  // for a vertical one.
  const ownScroll = useRef<number | undefined>(undefined);
  const lastScrollTop = useRef(0);

  const scaled = lineCount * ROW_HEIGHT > MAX_SPACER_PX;
  const spacerPx = scaled ? MAX_SPACER_PX : lineCount * ROW_HEIGHT;
  const visibleRows = Math.max(1, Math.ceil(viewportHeight / ROW_HEIGHT));
  const maxTop = Math.max(0, lineCount - viewportHeight / ROW_HEIGHT);
  const shownTop = follow ? maxTop : clamp(topLine, 0, maxTop);

  const scrollTopFor = useCallback((line: number) => {
    if (!scaled) return line * ROW_HEIGHT;
    return maxTop === 0 ? 0 : (line / maxTop) * (spacerPx - viewportHeight);
  }, [scaled, spacerPx, viewportHeight, maxTop]);

  const lineFor = (scrollTop: number) => {
    if (!scaled) return scrollTop / ROW_HEIGHT;
    const range = spacerPx - viewportHeight;
    return range <= 0 ? 0 : (scrollTop / range) * maxTop;
  };

  // The user moved the view to `line`: follow exactly while at the end.
  const moveTo = (line: number) => {
    const next = clamp(line, 0, maxTop);
    topRef.current = next;
    setTopLine(next);
    const atEnd = next >= maxTop - 0.5;
    if (atEnd !== follow) onFollowChange(atEnd);
  };
  const moveBy = (lines: number) => moveTo(topRef.current + lines);

  useImperativeHandle(ref, () => ({
    scrollToLine: (line) => {
      const next = clamp(line - visibleRows / 3, 0, maxTop);
      topRef.current = next;
      setTopLine(next);
      onFollowChange(false);
    },
    holdEnd: () => setTopLine(maxTop),
    focus: () => scrollerRef.current?.focus({ preventScroll: true })
  }), [visibleRows, maxTop, onFollowChange]);

  // Long lines don't wrap: bring the active row's first highlighted match
  // into view sideways, once per active line (and only once its row has
  // loaded). Only scrollLeft changes, which the scroll handler ignores.
  const centredLine = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (activeLine === undefined) {
      centredLine.current = undefined;
      return;
    }
    const scroller = scrollerRef.current;
    const mark = scroller?.querySelector('.log-row-active mark.log-match');
    if (!scroller || !mark || centredLine.current === activeLine) return;
    centredLine.current = activeLine;
    const box = scroller.getBoundingClientRect();
    const rect = mark.getBoundingClientRect();
    const left = rect.left - box.left + scroller.scrollLeft;
    if (left < scroller.scrollLeft || left + rect.width > scroller.scrollLeft + scroller.clientWidth) {
      scroller.scrollLeft = Math.max(0, left - scroller.clientWidth / 3);
    }
  });

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const observer = new ResizeObserver(() => setViewportHeight(scroller.clientHeight));
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  // Keep the scrollbar where the shown line is (after following, a jump, or
  // the content changing under it).
  useLayoutEffect(() => {
    topRef.current = shownTop;
    const scroller = scrollerRef.current;
    // Not before the viewport is measured: the mapping depends on its height.
    if (!scroller || viewportHeight === 0) return;
    const target = scrollTopFor(shownTop);
    if (Math.abs(scroller.scrollTop - target) >= 1) {
      scroller.scrollTop = target;
      // As the browser applied it (clamped, rounded): its scroll event is ours.
      ownScroll.current = scroller.scrollTop;
    }
    lastScrollTop.current = scroller.scrollTop;
  }, [shownTop, scrollTopFor, viewportHeight]);

  const onScroll = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const expected = ownScroll.current;
    ownScroll.current = undefined;
    const vertical = Math.abs(scroller.scrollTop - lastScrollTop.current) >= 1;
    lastScrollTop.current = scroller.scrollTop;
    if (!vertical) return; // A sideways scroll.
    if (expected !== undefined && Math.abs(scroller.scrollTop - expected) < 2) return;
    moveTo(lineFor(scroller.scrollTop));
  };

  // Scaled, one scrollbar pixel spans many lines: the wheel and touch move
  // by lines instead (non-passive listeners: React's can't preventDefault).
  // The listeners call the latest render's handlers through the ref.
  const handlers = useRef<InputHandlers | null>(null);
  const touch = useRef<{ x: number; y: number; top: number; left: number } | undefined>(undefined);
  useLayoutEffect(() => {
    handlers.current = {
      wheel: (event) => {
        // Ctrl+wheel and pinch zoom the page; a mostly sideways scroll stays native.
        if (event.ctrlKey || event.deltaY === 0 || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
        event.preventDefault();
        const scroller = scrollerRef.current;
        if (scroller && event.deltaX !== 0) scroller.scrollLeft += event.deltaX;
        moveBy(event.deltaMode === 1 ? event.deltaY : event.deltaMode === 2 ? event.deltaY * visibleRows : event.deltaY / ROW_HEIGHT);
      },
      touchStart: (event) => {
        const point = event.touches[0];
        touch.current = point && event.touches.length === 1
          ? { x: point.clientX, y: point.clientY, top: topRef.current, left: scrollerRef.current?.scrollLeft ?? 0 }
          : undefined;
      },
      touchMove: (event) => {
        const start = touch.current;
        const point = event.touches[0];
        if (!start || !point || event.touches.length > 1) return;
        event.preventDefault();
        const scroller = scrollerRef.current;
        if (scroller) scroller.scrollLeft = start.left + (start.x - point.clientX);
        moveTo(start.top + (start.y - point.clientY) / ROW_HEIGHT);
      }
    };
  });
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !scaled) return;
    const onWheel = (event: WheelEvent) => handlers.current?.wheel(event);
    const onTouchStart = (event: TouchEvent) => handlers.current?.touchStart(event);
    const onTouchMove = (event: TouchEvent) => handlers.current?.touchMove(event);
    scroller.addEventListener('wheel', onWheel, { passive: false });
    scroller.addEventListener('touchstart', onTouchStart, { passive: true });
    scroller.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => {
      scroller.removeEventListener('wheel', onWheel);
      scroller.removeEventListener('touchstart', onTouchStart);
      scroller.removeEventListener('touchmove', onTouchMove);
    };
  }, [scaled]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const page = Math.max(1, visibleRows - 1);
    const moves: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page, ' ': event.shiftKey ? -page : page, Home: -Infinity, End: Infinity };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    moveBy(move);
  };

  const first = Math.floor(shownTop);
  const from = Math.max(0, first - OVERSCAN_ROWS);
  const to = Math.min(lineCount, first + visibleRows + 1 + OVERSCAN_ROWS);
  useEffect(() => {
    onRangeChange(from, to, first);
  }, [from, to, first, onRangeChange]);

  const gutterWidth = `${String(Math.max(1, lineCount)).length + 1}ch`;
  // The rows sit at the scroll position, shifted by the top line's fraction
  // and by the overscan rows above it.
  const offset = scrollTopFor(shownTop) - (shownTop - from) * ROW_HEIGHT;

  const rows: ReactNode[] = [];
  for (let line = from; line < to; line++) {
    const text = getLine(line);
    rows.push(
      <div key={line} className={line === activeLine ? 'log-row log-row-active' : 'log-row'} data-line={line}>
        <span className="log-gutter" style={{ width: gutterWidth }}>{line + 1}</span>
        {text === undefined
          ? <span className="log-text log-text-loading">…</span>
          : <span className="log-text">{renderLine ? renderLine(text) : text}</span>}
      </div>
    );
  }

  return (
    // role="log" implies aria-live=polite; rows swapped in by scrolling are
    // not news to announce.
    <div ref={scrollerRef} className="log-viewport" tabIndex={0} onScroll={onScroll} onKeyDown={onKeyDown} role="log" aria-live="off" aria-label="rwr_server.log">
      {/* The rows stay in the flow (translated into place), so the spacer is
          as wide as the widest row in view. overflow hidden: rows translated
          past either end must not change the height the scrollbar maps onto. */}
      <div className="log-spacer" style={{ height: spacerPx }}>
        <div className="log-rows" style={{ transform: `translateY(${offset}px)` }}>
          {rows}
        </div>
      </div>
    </div>
  );
};
