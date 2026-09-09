import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent
} from "react";
import {
  PLAYBACK_SPEEDS,
  SpineViewerController,
  createInitialViewerSnapshot,
  type DebugOptions,
  type EventFrame,
  type SpineRuntime,
  type ViewerSnapshot
} from "../core/controller";
import { SpineWebGLRuntime } from "../core/spine-webgl-runtime";

export interface SpineViewerLoadResult {
  files: readonly File[];
  animations: ViewerSnapshot["animations"];
  skins: ViewerSnapshot["skins"];
  fps: number | null;
}

export interface SpineViewerProps {
  className?: string;
  files?: readonly File[];
  showUploader?: boolean;
  onLoad?: (result: SpineViewerLoadResult) => void;
  onError?: (error: Error) => void;
  onAnimationChange?: (name: string) => void;
  onSkinChange?: (name: string) => void;
  onEventSelect?: (event: EventFrame) => void;
  onPlayStateChange?: (isPlaying: boolean) => void;
}

export interface SpineViewerHandle {
  play(): void;
  pause(): void;
  seek(time: number): void;
  setAnimation(name: string): void;
  setSkin(name: string): void;
}

interface SpineViewerInternalProps extends SpineViewerProps {
  runtimeFactory?: (canvas: HTMLCanvasElement) => SpineRuntime;
}

const DEBUG_LABELS: Record<keyof DebugOptions, string> = {
  bones: "骨骼",
  regions: "区域",
  meshes: "网格三角形",
  bounds: "边界框",
  paths: "路径",
  clipping: "裁剪",
  points: "点",
  hulls: "网格外壳"
};

const formatTime = (time: number) => `${time.toFixed(3)}s`;
const defaultRuntimeFactory = (canvas: HTMLCanvasElement) =>
  new SpineWebGLRuntime(canvas);

function EventDetails({ event }: { event: EventFrame }) {
  const values = [
    ["int", event.intValue],
    ["float", event.floatValue],
    ["string", event.stringValue],
    ["音频", event.audioPath],
    ["音量", event.audioPath ? event.volume : null],
    ["平衡", event.audioPath ? event.balance : null]
  ].filter(([, value]) => value !== null && value !== "");

  return (
    <dl className="sv-event-details">
      {values.map(([label, value]) => (
        <div key={String(label)}>
          <dt>{label}</dt>
          <dd>{String(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

export const SpineViewerImpl = forwardRef<
  SpineViewerHandle,
  SpineViewerInternalProps
>(function SpineViewerImpl(
  {
    className,
    files,
    showUploader = true,
    onLoad,
    onError,
    onAnimationChange,
    onSkinChange,
    onEventSelect,
    onPlayStateChange,
    runtimeFactory = defaultRuntimeFactory
  },
  ref
) {
  const rootRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const controllerRef = useRef<SpineViewerController | null>(null);
  const panRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);
  const lastPropFiles = useRef<readonly File[] | undefined>(undefined);
  const onErrorRef = useRef(onError);
  const onPlayStateChangeRef = useRef(onPlayStateChange);
  const [controller, setController] = useState<SpineViewerController | null>(null);
  const [snapshot, setSnapshot] = useState(createInitialViewerSnapshot);
  const [initializationError, setInitializationError] = useState<Error | null>(null);
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set());

  useEffect(() => {
    onErrorRef.current = onError;
    onPlayStateChangeRef.current = onPlayStateChange;
  }, [onError, onPlayStateChange]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const runtime = runtimeFactory(canvas);
      const nextController = new SpineViewerController(runtime);
      runtime.setErrorHandler?.((runtimeError) => {
        nextController.reportRuntimeError(runtimeError);
        onErrorRef.current?.(runtimeError);
      });
      controllerRef.current = nextController;
      setController(nextController);
      let previousSnapshot = nextController.getSnapshot();
      setSnapshot(previousSnapshot);
      const unsubscribe = nextController.subscribe(() => {
        const nextSnapshot = nextController.getSnapshot();
        if (nextSnapshot.isPlaying !== previousSnapshot.isPlaying) {
          onPlayStateChangeRef.current?.(nextSnapshot.isPlaying);
        }
        previousSnapshot = nextSnapshot;
        setSnapshot(nextSnapshot);
      });
      const resizeObserver = new ResizeObserver(() => nextController.render());
      resizeObserver.observe(canvas);
      return () => {
        resizeObserver.disconnect();
        unsubscribe();
        nextController.dispose();
        controllerRef.current = null;
      };
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      setInitializationError(normalized);
      onErrorRef.current?.(normalized);
    }
  }, [runtimeFactory]);

  useEffect(() => {
    if (!controller) return;
    let frame = 0;
    let previous = performance.now();
    const animate = (now: number) => {
      const delta = Math.min((now - previous) / 1000, 0.1);
      previous = now;
      controller.tick(delta);
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [controller]);

  const loadFiles = useCallback(
    async (selectedFiles: readonly File[]) => {
      if (!controller) return;
      try {
        const committed = await controller.load(selectedFiles);
        if (!committed) return;
        const next = controller.getSnapshot();
        setExpandedEvents(new Set());
        onLoad?.({
          files: next.bundle?.files ?? [],
          animations: next.animations,
          skins: next.skins,
          fps: next.fps
        });
      } catch (error) {
        onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    },
    [controller, onError, onLoad]
  );

  useEffect(() => {
    if (!files || files === lastPropFiles.current) return;
    lastPropFiles.current = files;
    void loadFiles(files);
  }, [files, loadFiles]);

  const changeAnimation = useCallback(
    (name: string) => {
      controller?.setAnimation(name);
      setExpandedEvents(new Set());
      onAnimationChange?.(name);
    },
    [controller, onAnimationChange]
  );

  const changeSkin = useCallback(
    (name: string) => {
      controller?.setSkin(name);
      onSkinChange?.(name);
    },
    [controller, onSkinChange]
  );

  const setPlaying = useCallback(
    (playing: boolean) => {
      if (playing) controller?.play();
      else controller?.pause();
    },
    [controller]
  );

  const selectEvent = useCallback(
    (event: EventFrame) => {
      controller?.selectEvent(event.id);
      onEventSelect?.(event);
      requestAnimationFrame(() => {
        const item = Array.from(
          rootRef.current?.querySelectorAll<HTMLElement>("[data-event-list-id]") ?? []
        ).find((element) => element.dataset.eventListId === event.id);
        if (typeof item?.scrollIntoView === "function") {
          item.scrollIntoView({ block: "nearest" });
        }
      });
    },
    [controller, onEventSelect]
  );

  useImperativeHandle(
    ref,
    () => ({
      play: () => setPlaying(true),
      pause: () => setPlaying(false),
      seek: (time) => controller?.seek(time),
      setAnimation: changeAnimation,
      setSkin: changeSkin
    }),
    [changeAnimation, changeSkin, controller, setPlaying]
  );

  const currentAnimation = snapshot.animations.find(
    (animation) => animation.name === snapshot.animation
  );
  const events = currentAnimation?.events ?? [];
  const error = snapshot.error ?? initializationError;
  const ready = snapshot.status === "ready";

  const handleFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (selected.length > 0) void loadFiles(selected);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!ready) return;
    panRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      offsetX: snapshot.camera.offsetX,
      offsetY: snapshot.camera.offsetY
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    controller?.setCamera({
      ...snapshot.camera,
      offsetX: pan.offsetX + event.clientX - pan.x,
      offsetY: pan.offsetY + event.clientY - pan.y
    });
  };

  const handlePointerEnd = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (panRef.current?.pointerId === event.pointerId) panRef.current = null;
  };

  const handleWheel = (event: WheelEvent<HTMLCanvasElement>) => {
    if (!ready) return;
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    controller?.setCamera({
      ...snapshot.camera,
      zoom: snapshot.camera.zoom * factor
    });
  };

  return (
    <section
      ref={rootRef}
      className={["spine-viewer", className].filter(Boolean).join(" ")}
    >
      <header className="sv-header">
        <div>
          <h1>Spine Viewer</h1>
          <p>Spine 3.8.20–3.8.x 动画检查工具</p>
        </div>
        {showUploader && (
          <label className="sv-upload">
            选择资源文件
            <input
              aria-label="选择 Spine 资源文件"
              type="file"
              multiple
              accept=".json,.skel,.atlas,image/*"
              onChange={handleFiles}
            />
          </label>
        )}
        {snapshot.bundle && (
          <span className="sv-file-summary">
            {snapshot.bundle.skeletonFile.name} · {snapshot.bundle.atlasPages.length} 张纹理
          </span>
        )}
      </header>

      {error && (
        <div className="sv-error" role="alert">
          <strong>加载失败</strong>
          <span>{error.message}</span>
        </div>
      )}

      <div className="sv-workspace" aria-busy={snapshot.status === "loading"}>
        <div className="sv-stage">
          <canvas
            ref={canvasRef}
            aria-label="Spine 动画预览"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            onWheel={handleWheel}
          />
          {!ready && (
            <div className="sv-empty">
              {snapshot.status === "loading" ? "正在加载资源…" : "请选择完整的 Spine 资源包"}
            </div>
          )}
          {ready && (
            <button
              className="sv-reset-camera"
              type="button"
              onClick={() => controller?.resetCamera()}
            >
              重置视图
            </button>
          )}
        </div>

        <aside className="sv-sidebar">
          <section className="sv-panel">
            <h2>预览设置</h2>
            <label>
              <span>动画</span>
              <select
                aria-label="动画"
                value={snapshot.animation ?? ""}
                disabled={!ready}
                onChange={(event) => changeAnimation(event.target.value)}
              >
                {snapshot.animations.map((animation) => (
                  <option key={animation.name} value={animation.name}>
                    {animation.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>皮肤</span>
              <select
                aria-label="皮肤"
                value={snapshot.skin ?? ""}
                disabled={!ready || snapshot.skins.length === 0}
                onChange={(event) => changeSkin(event.target.value)}
              >
                {snapshot.skins.map((skin) => (
                  <option key={skin} value={skin}>
                    {skin}
                  </option>
                ))}
              </select>
            </label>
            <label className="sv-check">
              <input
                type="checkbox"
                checked={snapshot.premultipliedAlpha}
                disabled={!ready || snapshot.status === "loading"}
                onChange={(event) => {
                  void controller
                    ?.setPremultipliedAlpha(event.target.checked)
                    .catch((loadError) => onError?.(loadError));
                }}
              />
              <span>预乘透明（PMA）</span>
            </label>
          </section>

          <section className="sv-panel">
            <label className="sv-debug-master">
              <span>Debug 模式</span>
              <input
                type="checkbox"
                checked={snapshot.debugEnabled}
                disabled={!ready}
                onChange={(event) =>
                  controller?.setDebugEnabled(event.target.checked)
                }
              />
            </label>
            <div className="sv-debug-grid">
              {(Object.keys(DEBUG_LABELS) as Array<keyof DebugOptions>).map((option) => (
                <label className="sv-check" key={option}>
                  <input
                    type="checkbox"
                    checked={snapshot.debug[option]}
                    disabled={!ready || !snapshot.debugEnabled}
                    onChange={(event) =>
                      controller?.setDebugOption(option, event.target.checked)
                    }
                  />
                  <span>{DEBUG_LABELS[option]}</span>
                </label>
              ))}
            </div>
          </section>

          <section className="sv-panel sv-events">
            <div className="sv-panel-heading">
              <h2>事件帧</h2>
              <span>{events.length}</span>
            </div>
            {events.length === 0 ? (
              <p className="sv-muted">{ready ? "当前动画没有事件" : "加载资源后显示事件"}</p>
            ) : (
              <ul>
                {events.map((event) => {
                  const selected = snapshot.selectedEventId === event.id;
                  const expanded = expandedEvents.has(event.id);
                  return (
                    <li
                      key={event.id}
                      className={selected ? "is-selected" : ""}
                      data-event-list-id={event.id}
                    >
                      <div className="sv-event-row">
                        <button
                          type="button"
                          aria-pressed={selected}
                          aria-label={`选择事件 ${event.name}，${formatTime(event.time).replace("s", " 秒")}`}
                          onClick={() => selectEvent(event)}
                        >
                          <time>{formatTime(event.time)}</time>
                          <strong>{event.name}</strong>
                        </button>
                        <button
                          className="sv-expand-event"
                          type="button"
                          aria-label={`${expanded ? "收起" : "展开"} ${event.name} 数据`}
                          aria-expanded={expanded}
                          onClick={() =>
                            setExpandedEvents((current) => {
                              const next = new Set(current);
                              if (next.has(event.id)) next.delete(event.id);
                              else next.add(event.id);
                              return next;
                            })
                          }
                        >
                          {expanded ? "−" : "+"}
                        </button>
                      </div>
                      {expanded && <EventDetails event={event} />}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </aside>
      </div>

      <footer className="sv-transport">
        <div className="sv-transport-controls">
          <button
            type="button"
            disabled={!ready}
            onClick={() => setPlaying(!snapshot.isPlaying)}
          >
            {snapshot.isPlaying ? "暂停" : "播放"}
          </button>
          <label className="sv-check">
            <input
              type="checkbox"
              checked={snapshot.loop}
              disabled={!ready}
              onChange={(event) => controller?.setLoop(event.target.checked)}
            />
            <span>循环</span>
          </label>
          <label>
            <span className="sv-visually-hidden">播放速度</span>
            <select
              aria-label="播放速度"
              value={snapshot.speed}
              disabled={!ready}
              onChange={(event) => controller?.setSpeed(Number(event.target.value))}
            >
              {PLAYBACK_SPEEDS.map((speed) => (
                <option key={speed} value={speed}>
                  {speed}×
                </option>
              ))}
            </select>
          </label>
          <output aria-label="当前时间">
            {formatTime(snapshot.time)} / {formatTime(snapshot.duration)}
            {snapshot.fps
              ? ` · ${Math.round(snapshot.time * snapshot.fps)} 帧`
              : ""}
          </output>
        </div>

        <div className="sv-timeline">
          <input
            aria-label="动画时间轴"
            type="range"
            min={0}
            max={Math.max(snapshot.duration, 0.001)}
            step={0.001}
            value={snapshot.time}
            disabled={!ready}
            onPointerDown={() => setPlaying(false)}
            onChange={(event) => controller?.seek(Number(event.target.value))}
          />
          <div className="sv-event-markers" aria-label="时间轴事件">
            {events.map((event) => (
              <button
                key={event.id}
                type="button"
                style={{
                  left: `${snapshot.duration > 0 ? (event.time / snapshot.duration) * 100 : 0}%`
                }}
                className={snapshot.selectedEventId === event.id ? "is-selected" : ""}
                aria-label={`事件 ${event.name}，${formatTime(event.time).replace("s", " 秒")}`}
                aria-pressed={snapshot.selectedEventId === event.id}
                onClick={() => selectEvent(event)}
              />
            ))}
          </div>
        </div>
      </footer>
    </section>
  );
});

export const SpineViewer = forwardRef<SpineViewerHandle, SpineViewerProps>(
  function SpineViewer(props, ref) {
    return <SpineViewerImpl {...props} ref={ref} />;
  }
);
