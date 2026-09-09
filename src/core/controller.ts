import {
  validateSpineResourceBundle,
  type ValidatedSpineResourceBundle
} from "./resource-bundle";

export interface EventFrame {
  id: string;
  name: string;
  time: number;
  intValue: number;
  floatValue: number;
  stringValue: string;
  audioPath: string | null;
  volume: number;
  balance: number;
}

export interface AnimationInfo {
  name: string;
  duration: number;
  events: readonly EventFrame[];
}

export interface SpineRuntimeMetadata {
  animations: readonly AnimationInfo[];
  skins: readonly string[];
  fps: number | null;
}

export interface DebugOptions {
  bones: boolean;
  regions: boolean;
  meshes: boolean;
  bounds: boolean;
  paths: boolean;
  clipping: boolean;
  points: boolean;
  hulls: boolean;
}

export interface CameraState {
  zoom: number;
  offsetX: number;
  offsetY: number;
}

export interface SpineRuntimeLoadOptions {
  premultipliedAlpha: boolean;
  animation?: string | null;
  skin?: string | null;
  time?: number;
  debug?: DebugOptions;
  camera?: CameraState;
}

export interface SpineRuntime {
  load(
    bundle: ValidatedSpineResourceBundle,
    options: SpineRuntimeLoadOptions
  ): Promise<SpineRuntimeMetadata>;
  setAnimation(name: string): void;
  setSkin(name: string): void;
  seek(time: number): void;
  setDebug(options: DebugOptions): void;
  setCamera(camera: CameraState): void;
  cancelPendingLoad?(): void;
  setErrorHandler?(handler: (error: Error) => void): void;
  render(): void;
  dispose(): void;
}

export type ViewerStatus = "idle" | "loading" | "ready" | "error";
export const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 1.5, 2] as const;

export interface ViewerSnapshot {
  status: ViewerStatus;
  error: Error | null;
  bundle: ValidatedSpineResourceBundle | null;
  animations: readonly AnimationInfo[];
  skins: readonly string[];
  fps: number | null;
  animation: string | null;
  skin: string | null;
  duration: number;
  time: number;
  isPlaying: boolean;
  loop: boolean;
  speed: number;
  premultipliedAlpha: boolean;
  debugEnabled: boolean;
  debug: DebugOptions;
  selectedEventId: string | null;
  camera: CameraState;
}

const DEFAULT_DEBUG: DebugOptions = {
  bones: true,
  regions: false,
  meshes: false,
  bounds: true,
  paths: false,
  clipping: false,
  points: false,
  hulls: false
};

const EMPTY_DEBUG: DebugOptions = {
  bones: false,
  regions: false,
  meshes: false,
  bounds: false,
  paths: false,
  clipping: false,
  points: false,
  hulls: false
};

const INITIAL_SNAPSHOT: ViewerSnapshot = {
  status: "idle",
  error: null,
  bundle: null,
  animations: [],
  skins: [],
  fps: null,
  animation: null,
  skin: null,
  duration: 0,
  time: 0,
  isPlaying: false,
  loop: true,
  speed: 1,
  premultipliedAlpha: true,
  debugEnabled: false,
  debug: { ...DEFAULT_DEBUG },
  selectedEventId: null,
  camera: { zoom: 1, offsetX: 0, offsetY: 0 }
};

export const createInitialViewerSnapshot = (): ViewerSnapshot => ({
  ...INITIAL_SNAPSHOT,
  debug: { ...INITIAL_SNAPSHOT.debug },
  camera: { ...INITIAL_SNAPSHOT.camera }
});

export class SpineViewerController {
  private snapshot: ViewerSnapshot = createInitialViewerSnapshot();
  private lastReadySnapshot: ViewerSnapshot | null = null;
  private readonly listeners = new Set<() => void>();
  private loadSequence = 0;

  constructor(private readonly runtime: SpineRuntime) {}

  getSnapshot = (): ViewerSnapshot => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(changes: Partial<ViewerSnapshot>) {
    this.snapshot = { ...this.snapshot, ...changes };
    if (this.snapshot.status === "ready" && this.snapshot.error === null) {
      this.lastReadySnapshot = this.snapshot;
    }
    this.listeners.forEach((listener) => listener());
  }

  async load(inputFiles: Iterable<File>): Promise<boolean> {
    const sequence = ++this.loadSequence;
    this.runtime.cancelPendingLoad?.();
    const previous = this.snapshot;
    this.update({ status: "loading", error: null });

    try {
      const bundle = await validateSpineResourceBundle(inputFiles);
      if (sequence !== this.loadSequence) return false;
      const metadata = await this.runtime.load(
        bundle,
        { premultipliedAlpha: this.snapshot.premultipliedAlpha }
      );
      if (sequence !== this.loadSequence) return false;
      if (metadata.animations.length === 0) {
        throw new Error("骨骼文件中没有可预览的动画。");
      }

      const animation = metadata.animations[0];
      const skin = metadata.skins[0] ?? null;

      this.update({
        status: "ready",
        error: null,
        bundle,
        animations: metadata.animations,
        skins: metadata.skins,
        fps: metadata.fps,
        animation: animation.name,
        skin,
        duration: animation.duration,
        time: 0,
        isPlaying: true,
        loop: true,
        speed: 1,
        debugEnabled: false,
        debug: { ...DEFAULT_DEBUG },
        selectedEventId: null,
        camera: { zoom: 1, offsetX: 0, offsetY: 0 }
      });
      return true;
    } catch (error) {
      if (sequence !== this.loadSequence) return false;
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.snapshot =
        this.lastReadySnapshot
          ? { ...this.lastReadySnapshot, error: normalized }
          : { ...previous, status: "error", error: normalized };
      this.listeners.forEach((listener) => listener());
      throw normalized;
    }
  }

  play() {
    if (this.snapshot.status === "ready") this.update({ isPlaying: true });
  }

  pause() {
    if (this.snapshot.status === "ready") this.update({ isPlaying: false });
  }

  setAnimation(name: string) {
    const animation = this.snapshot.animations.find((item) => item.name === name);
    if (!animation || name === this.snapshot.animation) return;

    this.runtime.setAnimation(name);
    this.runtime.seek(0);
    this.update({
      animation: name,
      duration: animation.duration,
      time: 0,
      selectedEventId: null
    });
  }

  setSkin(name: string) {
    if (!this.snapshot.skins.includes(name) || name === this.snapshot.skin) return;
    this.runtime.setSkin(name);
    this.runtime.seek(this.snapshot.time);
    this.update({ skin: name });
  }

  seek(time: number) {
    if (this.snapshot.status !== "ready") return;
    const nextTime = Math.min(Math.max(time, 0), this.snapshot.duration);
    this.runtime.seek(nextTime);
    this.update({ time: nextTime, isPlaying: false });
  }

  selectEvent(eventId: string) {
    const animation = this.snapshot.animations.find(
      (item) => item.name === this.snapshot.animation
    );
    const event = animation?.events.find((item) => item.id === eventId);
    if (!event) return;

    this.runtime.seek(event.time);
    this.update({
      time: event.time,
      isPlaying: false,
      selectedEventId: event.id
    });
  }

  setSpeed(speed: number) {
    if (!(PLAYBACK_SPEEDS as readonly number[]).includes(speed)) return;
    this.update({ speed });
  }

  setLoop(loop: boolean) {
    this.update({ loop });
  }

  setDebugEnabled(debugEnabled: boolean) {
    const debug = debugEnabled ? this.snapshot.debug : EMPTY_DEBUG;
    this.runtime.setDebug(debug);
    this.update({ debugEnabled });
  }

  setDebugOption(option: keyof DebugOptions, enabled: boolean) {
    const debug = { ...this.snapshot.debug, [option]: enabled };
    if (this.snapshot.debugEnabled) this.runtime.setDebug(debug);
    this.update({ debug });
  }

  setCamera(camera: CameraState) {
    const normalized = {
      zoom: Math.min(Math.max(camera.zoom, 0.2), 8),
      offsetX: camera.offsetX,
      offsetY: camera.offsetY
    };
    this.runtime.setCamera(normalized);
    this.update({ camera: normalized });
  }

  resetCamera() {
    this.setCamera({ zoom: 1, offsetX: 0, offsetY: 0 });
  }

  render() {
    this.runtime.render();
  }

  reportRuntimeError(error: Error) {
    this.update({
      status: this.snapshot.status === "ready" ? "ready" : "error",
      error,
      isPlaying: false
    });
  }

  async setPremultipliedAlpha(enabled: boolean) {
    const bundle = this.snapshot.bundle;
    if (enabled === this.snapshot.premultipliedAlpha) return;
    if (!bundle || this.snapshot.status !== "ready") {
      this.update({ premultipliedAlpha: enabled });
      return;
    }

    const previous = this.snapshot;
    const sequence = ++this.loadSequence;
    this.runtime.cancelPendingLoad?.();
    this.update({ status: "loading", error: null });
    try {
      await this.runtime.load(bundle, {
        premultipliedAlpha: enabled,
        animation: previous.animation,
        skin: previous.skin,
        time: previous.time,
        debug: previous.debugEnabled ? previous.debug : EMPTY_DEBUG,
        camera: previous.camera
      });
      if (sequence !== this.loadSequence) return;
      this.update({
        status: "ready",
        premultipliedAlpha: enabled,
        error: null
      });
    } catch (error) {
      if (sequence !== this.loadSequence) return;
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.snapshot = { ...previous, error: normalized };
      this.listeners.forEach((listener) => listener());
      throw normalized;
    }
  }

  tick(deltaSeconds: number) {
    if (
      this.snapshot.status !== "ready" ||
      !this.snapshot.isPlaying ||
      this.snapshot.duration <= 0
    ) {
      return;
    }

    let nextTime = this.snapshot.time + Math.max(deltaSeconds, 0) * this.snapshot.speed;
    let isPlaying = true;
    if (this.snapshot.loop) {
      nextTime %= this.snapshot.duration;
    } else if (nextTime >= this.snapshot.duration) {
      nextTime = this.snapshot.duration;
      isPlaying = false;
    }

    this.runtime.seek(nextTime);
    this.update({ time: nextTime, isPlaying });
  }

  dispose() {
    this.loadSequence += 1;
    this.runtime.dispose();
    this.listeners.clear();
  }
}
