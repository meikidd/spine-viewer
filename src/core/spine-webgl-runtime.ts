import { spine } from "../vendor/spine-webgl-3.8.js";
import type {
  AnimationInfo,
  CameraState,
  DebugOptions,
  EventFrame,
  SpineRuntime,
  SpineRuntimeLoadOptions,
  SpineRuntimeMetadata
} from "./controller";
import type { ValidatedSpineResourceBundle } from "./resource-bundle";

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

class StaleRuntimeLoadError extends Error {
  constructor() {
    super("资源加载已被更新的请求取消。");
    this.name = "StaleRuntimeLoadError";
  }
}

const NO_DEBUG: DebugOptions = {
  bones: false,
  regions: false,
  meshes: false,
  bounds: false,
  paths: false,
  clipping: false,
  points: false,
  hulls: false
};

const readDataUrl = (file: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("读取文件失败。"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });

const loadAsset = (
  manager: spine.webgl.AssetManager,
  type: "text" | "binary" | "atlas",
  path: string
) =>
  new Promise<void>((resolve, reject) => {
    const success = () => resolve();
    const failure = (_failedPath: string, reason: string) =>
      reject(new Error(`无法加载“${path}”：${reason}`));

    if (type === "text") manager.loadText(path, success, failure);
    else if (type === "binary") manager.loadBinary(path, success, failure);
    else manager.loadTextureAtlas(path, success, failure);
  });

function assertRuntimeVersion(version: string | null | undefined, fileName: string) {
  const match = version?.match(/^3\.8\.(\d+)(?:\D.*)?$/);
  if (!match || Number(match[1]) < 20) {
    throw new Error(`“${fileName}”必须由 Spine 3.8.20–3.8.x 导出。`);
  }
}

function eventFrames(animation: spine.Animation): EventFrame[] {
  const result: EventFrame[] = [];
  animation.timelines.forEach((timeline, timelineIndex) => {
    if (!(timeline instanceof spine.EventTimeline)) return;
    timeline.events.forEach((event, eventIndex) => {
      result.push({
        id: `${animation.name}:${timelineIndex}:${eventIndex}`,
        name: event.data.name,
        time: event.time,
        intValue: event.intValue,
        floatValue: event.floatValue,
        stringValue: event.stringValue,
        audioPath: event.data.audioPath || null,
        volume: event.volume,
        balance: event.balance
      });
    });
  });
  return result.sort((left, right) => left.time - right.time);
}

async function assertTextureDimensions(
  files: ReadonlyMap<string, File>,
  maximumSize: number
) {
  if (typeof createImageBitmap !== "function") return;

  for (const [name, file] of files) {
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new Error(`无法解码纹理文件“${name}”。请重新导出或替换该纹理。`);
    }
    const tooLarge = bitmap.width > maximumSize || bitmap.height > maximumSize;
    const dimensions = `${bitmap.width}×${bitmap.height}`;
    bitmap.close();
    if (tooLarge) {
      throw new Error(
        `纹理“${name}”尺寸为 ${dimensions}，超过当前设备 WebGL 上限 ${maximumSize}×${maximumSize}。`
      );
    }
  }
}

export class SpineWebGLRuntime implements SpineRuntime {
  private readonly gl: WebGLRenderingContext;
  private readonly scene: spine.webgl.SceneRenderer;
  private assets: spine.webgl.AssetManager | null = null;
  private readonly pendingAssets = new Set<spine.webgl.AssetManager>();
  private loadGeneration = 0;
  private disposed = false;
  private errorHandler: ((error: Error) => void) | null = null;
  private skeleton: spine.Skeleton | null = null;
  private skeletonData: spine.SkeletonData | null = null;
  private animation: spine.Animation | null = null;
  private bounds: Bounds = { x: -50, y: -50, width: 100, height: 100 };
  private currentTime = 0;
  private premultipliedAlpha = true;
  private debug: DebugOptions = { ...NO_DEBUG };
  private camera: CameraState = { zoom: 1, offsetX: 0, offsetY: 0 };

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl =
      canvas.getContext("webgl", { alpha: false, antialias: true }) ??
      (canvas.getContext("experimental-webgl", {
        alpha: false,
        antialias: true
      }) as WebGLRenderingContext | null);
    if (!gl) {
      throw new Error(
        "当前浏览器或设备不支持 WebGL。请开启浏览器硬件加速，或更换受支持的桌面浏览器。"
      );
    }

    this.gl = gl;
    this.scene = new spine.webgl.SceneRenderer(canvas, gl, true);
    canvas.addEventListener("webglcontextlost", this.handleContextLost);
    canvas.addEventListener("webglcontextrestored", this.handleContextRestored);
  }

  async load(
    bundle: ValidatedSpineResourceBundle,
    options: SpineRuntimeLoadOptions
  ): Promise<SpineRuntimeMetadata> {
    if (this.disposed) throw new StaleRuntimeLoadError();
    const generation = ++this.loadGeneration;
    const candidate = new spine.webgl.AssetManager(this.gl);
    this.pendingAssets.add(candidate);
    try {
      const maximumTextureSize = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number;
      await assertTextureDimensions(bundle.textureFiles, maximumTextureSize);

      const dataUrls = await Promise.all(
        bundle.files.map(async (file) => [file.name, await readDataUrl(file)] as const)
      );
      dataUrls.forEach(([name, value]) => candidate.setRawDataURI(name, value));

      await Promise.all([
        loadAsset(
          candidate,
          bundle.format === "json" ? "text" : "binary",
          bundle.skeletonFile.name
        ),
        loadAsset(candidate, "atlas", bundle.atlasFile.name)
      ]);

      const atlas = candidate.get(bundle.atlasFile.name) as spine.TextureAtlas;
      const loader = new spine.AtlasAttachmentLoader(atlas);
      const parser =
        bundle.format === "json"
          ? new spine.SkeletonJson(loader)
          : new spine.SkeletonBinary(loader);
      const rawSkeleton = candidate.get(bundle.skeletonFile.name);
      const skeletonData = parser.readSkeletonData(rawSkeleton);
      assertRuntimeVersion(skeletonData.version, bundle.skeletonFile.name);
      this.assertCurrentLoad(generation);

      const skeleton = new spine.Skeleton(skeletonData);
      const animations: AnimationInfo[] = skeletonData.animations.map((animation) => ({
        name: animation.name,
        duration: animation.duration,
        events: eventFrames(animation)
      }));
      if (animations.length === 0) throw new Error("骨骼文件中没有可预览的动画。");

      const animation =
        (options.animation && skeletonData.findAnimation(options.animation)) ||
        skeletonData.animations[0];
      const skin =
        (options.skin && skeletonData.findSkin(options.skin)) ??
        skeletonData.skins[0] ??
        null;
      if (skin) {
        skeleton.setSkin(skin);
        skeleton.setSlotsToSetupPose();
      }
      const bounds = this.calculateAnimationBounds(skeleton, animation);
      this.assertCurrentLoad(generation);

      const previous = {
        assets: this.assets,
        skeleton: this.skeleton,
        skeletonData: this.skeletonData,
        animation: this.animation,
        bounds: this.bounds,
        currentTime: this.currentTime,
        premultipliedAlpha: this.premultipliedAlpha,
        camera: this.camera
      };
      this.assets = candidate;
      this.pendingAssets.delete(candidate);
      this.skeleton = skeleton;
      this.skeletonData = skeletonData;
      this.animation = animation;
      this.bounds = bounds;
      this.currentTime = Math.min(
        Math.max(options.time ?? 0, 0),
        animation.duration
      );
      this.premultipliedAlpha = options.premultipliedAlpha;
      this.debug = { ...(options.debug ?? NO_DEBUG) };
      this.camera = {
        ...(options.camera ?? { zoom: 1, offsetX: 0, offsetY: 0 })
      };
      try {
        this.applyPose();
        this.render();
      } catch (commitError) {
        this.assets = previous.assets;
        this.skeleton = previous.skeleton;
        this.skeletonData = previous.skeletonData;
        this.animation = previous.animation;
        this.bounds = previous.bounds;
        this.currentTime = previous.currentTime;
        this.premultipliedAlpha = previous.premultipliedAlpha;
        this.camera = previous.camera;
        try {
          candidate.dispose();
        } catch {
          // Preserve the original render error.
        }
        if (this.skeleton) {
          try {
            this.render();
          } catch {
            // A lost WebGL context is reported through its dedicated handler.
          }
        }
        throw commitError;
      }

      try {
        previous.assets?.dispose();
      } catch (disposeError) {
        this.errorHandler?.(
          new Error(`旧资源释放失败：${String(disposeError)}`)
        );
      }

      return {
        animations,
        skins: skeletonData.skins.map((skin) => skin.name),
        fps: Number.isFinite(skeletonData.fps) && skeletonData.fps > 0
          ? skeletonData.fps
          : null
      };
    } catch (error) {
      this.pendingAssets.delete(candidate);
      if (candidate !== this.assets) {
        try {
          candidate.dispose();
        } catch {
          // Keep the actionable loading error below.
        }
      }
      if (error instanceof StaleRuntimeLoadError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/version|3\.8|SkeletonBinary|Invalid/i.test(message)) {
        throw new Error(
          `无法解析“${bundle.skeletonFile.name}”。请确认资源由 Spine 3.8.20–3.8.x 导出。原始错误：${message}`
        );
      }
      throw error;
    }
  }

  setAnimation(name: string) {
    const animation = this.skeletonData?.findAnimation(name);
    const skeleton = this.skeleton;
    if (!animation || !skeleton) return;
    this.animation = animation;
    this.currentTime = 0;
    this.bounds = this.calculateAnimationBounds(skeleton, animation);
    this.applyPose();
    this.camera = { zoom: 1, offsetX: 0, offsetY: 0 };
    this.render();
  }

  setSkin(name: string) {
    if (!this.skeleton) return;
    this.skeleton.setSkinByName(name);
    this.skeleton.setSlotsToSetupPose();
    this.applyPose();
    this.render();
  }

  seek(time: number) {
    this.currentTime = Math.max(0, time);
    this.applyPose();
    this.render();
  }

  setDebug(options: DebugOptions) {
    this.debug = { ...options };
    this.render();
  }

  setCamera(camera: CameraState) {
    this.camera = {
      zoom: Math.min(Math.max(camera.zoom, 0.2), 8),
      offsetX: camera.offsetX,
      offsetY: camera.offsetY
    };
    this.render();
  }

  setErrorHandler(handler: (error: Error) => void) {
    this.errorHandler = handler;
  }

  cancelPendingLoad() {
    this.loadGeneration += 1;
    this.pendingAssets.forEach((assets) => assets.dispose());
    this.pendingAssets.clear();
  }

  render() {
    const skeleton = this.skeleton;
    if (!skeleton) return;

    this.scene.resize(spine.webgl.ResizeMode.Expand);
    this.updateCamera();
    this.gl.clearColor(0.075, 0.09, 0.13, 1);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);

    const debugRenderer = this.scene.skeletonDebugRenderer;
    debugRenderer.drawBones = this.debug.bones;
    debugRenderer.drawRegionAttachments = this.debug.regions;
    debugRenderer.drawMeshTriangles = this.debug.meshes;
    debugRenderer.drawBoundingBoxes = this.debug.bounds;
    debugRenderer.drawPaths = this.debug.paths;
    debugRenderer.drawClipping = this.debug.clipping;
    debugRenderer.drawMeshHull = this.debug.hulls;

    this.scene.begin();
    this.scene.drawSkeleton(skeleton, this.premultipliedAlpha);
    if (Object.values(this.debug).some(Boolean)) {
      this.scene.drawSkeletonDebug(skeleton, this.premultipliedAlpha);
      if (this.debug.points) this.drawPoints(skeleton);
    }
    this.scene.end();
  }

  dispose() {
    this.disposed = true;
    this.cancelPendingLoad();
    this.assets?.dispose();
    this.assets = null;
    this.skeleton = null;
    this.skeletonData = null;
    this.animation = null;
    this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.handleContextRestored);
    this.errorHandler = null;
    this.scene.dispose();
  }

  private assertCurrentLoad(generation: number) {
    if (this.disposed || generation !== this.loadGeneration) {
      throw new StaleRuntimeLoadError();
    }
  }

  private applyPose() {
    if (!this.skeleton || !this.animation) return;
    this.skeleton.setToSetupPose();
    this.animation.apply(
      this.skeleton,
      0,
      Math.min(this.currentTime, this.animation.duration),
      false,
      [],
      1,
      spine.MixBlend.replace,
      spine.MixDirection.mixIn
    );
    this.skeleton.updateWorldTransform();
  }

  private calculateAnimationBounds(
    skeleton: spine.Skeleton,
    animation: spine.Animation
  ): Bounds {
    const samples = Math.max(2, Math.min(60, Math.ceil(animation.duration * 15)));
    const offset = new spine.Vector2();
    const size = new spine.Vector2();
    let left = Number.POSITIVE_INFINITY;
    let bottom = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let top = Number.NEGATIVE_INFINITY;

    for (let index = 0; index <= samples; index += 1) {
      const time = animation.duration * (index / samples);
      skeleton.setToSetupPose();
      animation.apply(
        skeleton,
        0,
        time,
        false,
        [],
        1,
        spine.MixBlend.replace,
        spine.MixDirection.mixIn
      );
      skeleton.updateWorldTransform();
      skeleton.getBounds(offset, size, []);
      if (size.x <= 0 || size.y <= 0) continue;
      left = Math.min(left, offset.x);
      bottom = Math.min(bottom, offset.y);
      right = Math.max(right, offset.x + size.x);
      top = Math.max(top, offset.y + size.y);
    }

    if (!Number.isFinite(left)) return { x: -50, y: -50, width: 100, height: 100 };
    const width = Math.max(right - left, 1);
    const height = Math.max(top - bottom, 1);
    return {
      x: left - width * 0.1,
      y: bottom - height * 0.1,
      width: width * 1.2,
      height: height * 1.2
    };
  }

  private updateCamera() {
    const canvasWidth = Math.max(this.canvas.clientWidth, 1);
    const canvasHeight = Math.max(this.canvas.clientHeight, 1);
    const fitScale = Math.min(
      canvasWidth / this.bounds.width,
      canvasHeight / this.bounds.height
    );
    const baseZoom = 1 / Math.max(fitScale, Number.EPSILON);
    const worldPerPixel = baseZoom / this.camera.zoom;

    this.scene.camera.zoom = baseZoom / this.camera.zoom;
    this.scene.camera.position.x =
      this.bounds.x + this.bounds.width / 2 - this.camera.offsetX * worldPerPixel;
    this.scene.camera.position.y =
      this.bounds.y + this.bounds.height / 2 + this.camera.offsetY * worldPerPixel;
    this.scene.camera.update();
  }

  private drawPoints(skeleton: spine.Skeleton) {
    const point = new spine.Vector2();
    skeleton.slots.forEach((slot) => {
      const attachment = slot.getAttachment();
      if (!(attachment instanceof spine.PointAttachment)) return;
      attachment.computeWorldPosition(slot.bone, point);
      const rotation = (attachment.computeWorldRotation(slot.bone) * Math.PI) / 180;
      const length = 18 / this.camera.zoom;
      this.scene.circle(false, point.x, point.y, 5 / this.camera.zoom, attachment.color);
      this.scene.line(
        point.x,
        point.y,
        point.x + Math.cos(rotation) * length,
        point.y + Math.sin(rotation) * length,
        attachment.color
      );
    });
  }

  private readonly handleContextLost = (event: Event) => {
    event.preventDefault();
    this.errorHandler?.(
      new Error("WebGL 上下文已丢失。请等待浏览器恢复，或重新加载当前资源包。")
    );
  };

  private readonly handleContextRestored = () => {
    if (!this.disposed) this.render();
  };
}
