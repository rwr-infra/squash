import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { Slider } from 'antd';
import { ROW_HEIGHT } from './LogViewport';
import type { LogViewportProps, ScrollAlign } from './LogViewport';
import './LogViewport.css';

// Long lines wrap, so rows have different heights and the native scrollbar
// can only span the lines in the DOM: a window around the view that slides
// by a third when the view nears one of its ends. The slider below covers
// the whole file. The window holds at least six screens of short lines, so
// one slide never brings the view near the other end.
const MIN_WINDOW_LINES = 400;
const SCREENS_PER_WINDOW = 6;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

type Target = { readonly line: number; readonly align: ScrollAlign };

// The log with wrapped lines and no sideways scrolling, for touch screens and
// narrow windows: native (touch, momentum) scrolling over a sliding window of
// lines. What is in view stays put while the window slides, lines load and
// grow, or the width changes.
export const WrappedLogViewport = ({ ref, lineCount, getLine, onRangeChange, follow, onFollowChange, renderLine, activeLine, initialLine }: LogViewportProps) => {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const windowLines = Math.max(MIN_WINDOW_LINES, Math.ceil((SCREENS_PER_WINDOW * size.height) / ROW_HEIGHT));
  const step = Math.floor(windowLines / 3);
  const maxStart = Math.max(0, lineCount - windowLines);
  // Where the window starts when not following (following shows the last lines).
  const [start, setStart] = useState(() => (initialLine === undefined ? 0 : Math.max(0, initialLine - step)));
  const windowStart = follow ? maxStart : Math.min(start, maxStart);
  const windowEnd = Math.min(lineCount, windowStart + windowLines);
  // The first line in view, for the slider.
  const [position, setPosition] = useState(initialLine ?? 0);
  // While the slider is dragged: where it is.
  const [dragging, setDragging] = useState<number | undefined>();
  // Bumped by a jump, so a jump within the current window still renders.
  const [, setJumps] = useState(0);

  // The row kept still across renders and how far its top is from the
  // view's top (px). The user's scrolling sets it to the first row in view;
  // a jump pins it to the line jumped to, so lines above it that load and
  // grow don't push that line out of view.
  const anchor = useRef<{ line: number; offset: number } | undefined>(undefined);
  // The anchor is the line jumped to, until the user scrolls.
  const pinned = useRef(false);
  // A line to bring into view once its row has loaded.
  const target = useRef<Target | undefined>(initialLine === undefined ? undefined : { line: initialLine, align: 'top' });
  // A scrollTop we set ourselves, so its scroll event isn't taken for the user's.
  const ownScroll = useRef<number | undefined>(undefined);
  // The scrollTop as last handled. A render can come between a scroll and
  // its (next-frame) event; the difference is the user's, not to be undone.
  const lastTop = useRef(0);
  // The window as of the last render: a slide changes the content's height,
  // and the browser may clamp scrollTop for it (not a user scroll).
  const lastWindowStart = useRef(windowStart);
  // This render's window, for the work done after it (`settle`).
  const live = useRef({ windowStart, windowEnd, maxStart, step, lineCount, follow });

  const rowOf = (line: number) => scrollerRef.current?.querySelector<HTMLElement>(`.log-row[data-line="${line}"]`) ?? null;

  // The first row in view, and how far its top is above the view's top.
  const firstInView = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return undefined;
    const top = scroller.getBoundingClientRect().top;
    for (const row of scroller.querySelectorAll<HTMLElement>('.log-row')) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom > top + 1) return { line: Number(row.dataset.line), offset: rect.top - top };
    }
    return undefined;
  };

  const scrollTo = (scroller: HTMLDivElement, value: number) => {
    if (Math.abs(scroller.scrollTop - value) < 1) return;
    scroller.scrollTop = value;
    // As the browser applied it (clamped): its scroll event is ours.
    ownScroll.current = scroller.scrollTop;
    lastTop.current = scroller.scrollTop;
  };

  const jump = (line: number, align: ScrollAlign = 'third') => {
    if (lineCount === 0) return;
    // The last line is the end: follow it.
    if (line >= lineCount - 1 && align === 'top') {
      target.current = undefined;
      onFollowChange(true);
      return;
    }
    const goal = clamp(line, 0, lineCount - 1);
    target.current = { line: goal, align };
    setStart(clamp(goal - step, 0, maxStart));
    setJumps((n) => n + 1);
    onFollowChange(false);
  };

  useImperativeHandle(ref, () => ({
    scrollToLine: jump,
    holdEnd: () => setStart(maxStart),
    focus: () => scrollerRef.current?.focus({ preventScroll: true })
  }));

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const observer = new ResizeObserver(() => setSize({ width: scroller.clientWidth, height: scroller.clientHeight }));
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  // After the view settles: show where it is, and slide the window when the
  // view is near one of its ends and there is more file that way (also when
  // no scroll happens: lines appended below a view held at the end).
  const settle = () => {
    const scroller = scrollerRef.current;
    const first = firstInView();
    if (!scroller || !first) return;
    const now = live.current;
    setPosition(first.line);
    onRangeChange(now.windowStart, now.windowEnd, first.line);
    // Following, or a jump still landing (its window must stay put).
    if (now.follow || target.current) return;
    const margin = scroller.clientHeight;
    const up = scroller.scrollTop < margin && now.windowStart > 0;
    const down = !up && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < margin && now.windowEnd < now.lineCount;
    if (!up && !down) return;
    // The view as it is now, before the slide changes the rows: that is
    // what the render after it keeps still.
    if (!target.current && !pinned.current) anchor.current = first;
    lastTop.current = scroller.scrollTop;
    setStart(up ? Math.max(0, now.windowStart - now.step) : Math.min(now.maxStart, now.windowStart + now.step));
  };
  const settleFrame = useRef(0);
  const scheduleSettle = () => {
    cancelAnimationFrame(settleFrame.current);
    settleFrame.current = requestAnimationFrame(settle);
  };
  useEffect(() => () => cancelAnimationFrame(settleFrame.current), []);

  // After every render: follow the end, land a jump once its row has
  // loaded, or keep the anchor row where it was.
  useLayoutEffect(() => {
    live.current = { windowStart, windowEnd, maxStart, step, lineCount, follow };
    const scroller = scrollerRef.current;
    if (!scroller) return;
    // Scrolled since last handled, the event still to come: the anchor row
    // has moved by that much on purpose. (Not after a slide: the anchor was
    // taken just before it, and a changed scrollTop is the browser clamping.)
    const slid = windowStart !== lastWindowStart.current;
    lastWindowStart.current = windowStart;
    const scrolled = scroller.scrollTop - lastTop.current;
    lastTop.current = scroller.scrollTop;
    if (!slid && anchor.current && Math.abs(scrolled) >= 1) anchor.current = { ...anchor.current, offset: anchor.current.offset - scrolled };
    if (follow) {
      target.current = undefined;
      pinned.current = false;
      scrollTo(scroller, scroller.scrollHeight);
      anchor.current = firstInView();
      scheduleSettle();
      return;
    }
    const goal = target.current;
    const row = goal && rowOf(goal.line);
    if (goal && row) {
      // Where the line goes: a third from the top (a search match, its first
      // mark there), or at the top (the slider, Wrap switched). Until its
      // row has loaded, roughly there; the jump lands once it has.
      const loaded = !row.querySelector('.log-text-loading');
      if (loaded) target.current = undefined;
      let offset = goal.align === 'top' ? 0 : scroller.clientHeight / 3;
      const mark = loaded && goal.align === 'third' ? row.querySelector('mark.log-match') : null;
      if (mark) offset -= mark.getBoundingClientRect().top - row.getBoundingClientRect().top;
      const top = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scrollTo(scroller, scroller.scrollTop + top - offset);
      anchor.current = { line: goal.line, offset: row.getBoundingClientRect().top - scroller.getBoundingClientRect().top };
      pinned.current = true;
    } else {
      const kept = anchor.current;
      const keptRow = kept && rowOf(kept.line);
      if (kept && keptRow) {
        const moved = keptRow.getBoundingClientRect().top - scroller.getBoundingClientRect().top - kept.offset;
        if (Math.abs(moved) >= 1) scrollTo(scroller, scroller.scrollTop + moved);
      }
    }
    scheduleSettle();
  });

  const onScroll = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const own = ownScroll.current !== undefined && Math.abs(scroller.scrollTop - ownScroll.current) < 2;
    ownScroll.current = undefined;
    lastTop.current = scroller.scrollTop;
    if (own) return;
    // The user's scroll: keep what they now look at.
    anchor.current = firstInView();
    target.current = undefined;
    pinned.current = false;
    const atEnd = windowEnd === lineCount && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
    if (atEnd !== follow) {
      // Leaving the end: the window stays where following had it.
      if (!atEnd) setStart(windowStart);
      onFollowChange(atEnd);
    }
    scheduleSettle();
  };

  // Home and End mean the file's, not the window's.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Home') {
      event.preventDefault();
      jump(0, 'top');
    } else if (event.key === 'End') {
      event.preventDefault();
      onFollowChange(true);
    }
  };

  // Rebuilt only when the window or the lines change, not as the view moves.
  const digits = String(Math.max(1, lineCount)).length;
  const rows = useMemo(() => {
    const built: ReactNode[] = [];
    for (let line = windowStart; line < windowEnd; line++) {
      const text = getLine(line);
      built.push(
        <div key={line} className={line === activeLine ? 'log-row log-row-active' : 'log-row'} data-line={line}>
          <span className="log-gutter" style={{ width: `${digits}ch` }}>{line + 1}</span>
          {text === undefined
            ? <span className="log-text log-text-loading">…</span>
            : <span className="log-text">{renderLine ? renderLine(text) : text}</span>}
        </div>
      );
    }
    return built;
  }, [windowStart, windowEnd, getLine, renderLine, activeLine, digits]);

  const last = Math.max(0, lineCount - 1);
  const shown = lineCount === 0 ? 0 : dragging ?? (follow ? last : Math.min(position, last));
  const lineLabel = (line: number) => `line ${(line + 1).toLocaleString()}`;
  return (
    <div className="log-wrap-frame">
      {/* role="log" implies aria-live=polite; rows swapped in by scrolling
          are not news to announce. */}
      <div ref={scrollerRef} className="log-viewport log-wrap" tabIndex={0} onScroll={onScroll} onKeyDown={onKeyDown} role="log" aria-live="off" aria-label="rwr_server.log">
        {rows}
      </div>
      <div className="log-position">
        <Slider
          min={0}
          max={last}
          value={shown}
          disabled={lineCount === 0}
          onChange={setDragging}
          onChangeComplete={(line) => {
            setDragging(undefined);
            jump(line, 'top');
          }}
          tooltip={{ formatter: (line) => lineLabel(line ?? 0) }}
          ariaLabelForHandle="Position in the log"
          ariaValueTextFormatterForHandle={lineLabel}
          style={{ flex: 1, margin: '6px 8px' }}
        />
        <span className="log-position-label">{lineCount === 0 ? '0 / 0' : `${(shown + 1).toLocaleString()} / ${lineCount.toLocaleString()}`}</span>
      </div>
    </div>
  );
};
