import { describe, expect, it, vi } from "vitest";
import {
  SpineViewerController,
  type SpineRuntime,
  type SpineRuntimeMetadata
} from "../src/core/controller";

const file = (name: string, content: string) => new File([content], name);

const files = (baseName = "hero") => [
  file(
    `${baseName}.json`,
    JSON.stringify({
      skeleton: { spine: "3.8.99" },
      bones: [{ name: "root" }],
      slots: [],
      skins: {},
      animations: {}
    })
  ),
  file(
    `${baseName}.atlas`,
    `${baseName}.png\nsize: 1,1\nformat: RGBA8888\nfilter: Linear,Linear\nrepeat: none\n`
  ),
  file(`${baseName}.png`, "image")
];

const metadata: SpineRuntimeMetadata = {
  animations: [
    {
      name: "idle",
      duration: 2,
      events: [
        {
          id: "idle:0:impact",
          name: "impact",
          time: 0.75,
          intValue: 2,
          floatValue: 0,
          stringValue: "",
          audioPath: null,
          volume: 1,
          balance: 0
        }
      ]
    },
    { name: "run", duration: 1, events: [] }
  ],
  skins: ["default", "blue"],
  fps: 30
};

const runtime = (): SpineRuntime => ({
  load: vi.fn().mockResolvedValue(metadata),
  setAnimation: vi.fn(),
  setSkin: vi.fn(),
  seek: vi.fn(),
  setDebug: vi.fn(),
  setCamera: vi.fn(),
  cancelPendingLoad: vi.fn(),
  render: vi.fn(),
  dispose: vi.fn()
});

describe("SpineViewerController", () => {
  it("loads a resource bundle and exposes its preview metadata", async () => {
    const adapter = runtime();
    const controller = new SpineViewerController(adapter);

    await controller.load(files());

    expect(controller.getSnapshot()).toMatchObject({
      status: "ready",
      animations: metadata.animations,
      skins: ["default", "blue"],
      animation: "idle",
      skin: "default",
      duration: 2,
      time: 0,
      isPlaying: true,
      speed: 1,
      loop: true
    });
    expect(adapter.load).toHaveBeenCalledWith(
      expect.objectContaining({
        skeletonFile: expect.objectContaining({ name: "hero.json" })
      }),
      { premultipliedAlpha: false }
    );
  });

  it("switches animation at zero without changing the play state", async () => {
    const adapter = runtime();
    const controller = new SpineViewerController(adapter);
    await controller.load(files());
    controller.pause();

    controller.setAnimation("run");

    expect(controller.getSnapshot()).toMatchObject({
      animation: "run",
      duration: 1,
      time: 0,
      isPlaying: false,
      selectedEventId: null
    });
    expect(adapter.setAnimation).toHaveBeenLastCalledWith("run");
    expect(adapter.seek).toHaveBeenLastCalledWith(0);
  });

  it("selects an event frame, pauses, and seeks to its exact time", async () => {
    const adapter = runtime();
    const controller = new SpineViewerController(adapter);
    await controller.load(files());

    controller.selectEvent("idle:0:impact");

    expect(controller.getSnapshot()).toMatchObject({
      selectedEventId: "idle:0:impact",
      time: 0.75,
      isPlaying: false
    });
    expect(adapter.seek).toHaveBeenLastCalledWith(0.75);
  });

  it("advances with speed and stops at the end when looping is disabled", async () => {
    const adapter = runtime();
    const controller = new SpineViewerController(adapter);
    await controller.load(files());
    controller.setSpeed(2);
    controller.setLoop(false);

    controller.tick(1.5);

    expect(controller.getSnapshot()).toMatchObject({
      time: 2,
      isPlaying: false,
      speed: 2,
      loop: false
    });
    expect(adapter.seek).toHaveBeenLastCalledWith(2);
  });

  it("restarts from zero when playing again after a non-looping animation ends", async () => {
    const adapter = runtime();
    const controller = new SpineViewerController(adapter);
    await controller.load(files());
    controller.setLoop(false);
    controller.tick(2);

    controller.play();

    expect(controller.getSnapshot()).toMatchObject({
      time: 0,
      isPlaying: true,
      loop: false
    });
    expect(adapter.seek).toHaveBeenLastCalledWith(0);
  });

  it("resumes from a paused time without restarting", async () => {
    const adapter = runtime();
    const controller = new SpineViewerController(adapter);
    await controller.load(files());
    controller.tick(0.5);
    controller.pause();
    const seekCalls = vi.mocked(adapter.seek).mock.calls.length;

    controller.play();

    expect(controller.getSnapshot()).toMatchObject({
      time: 0.5,
      isPlaying: true
    });
    expect(adapter.seek).toHaveBeenCalledTimes(seekCalls);
  });

  it("does not restart from the end while looping is enabled", async () => {
    const adapter = runtime();
    const controller = new SpineViewerController(adapter);
    await controller.load(files());
    controller.seek(2);
    const seekCalls = vi.mocked(adapter.seek).mock.calls.length;

    controller.play();

    expect(controller.getSnapshot()).toMatchObject({
      time: 2,
      isPlaying: true,
      loop: true
    });
    expect(adapter.seek).toHaveBeenCalledTimes(seekCalls);
  });

  it("does not commit an older load that finishes after a newer load", async () => {
    const resolvers = new Map<string, (value: SpineRuntimeMetadata) => void>();
    const adapter = runtime();
    vi.mocked(adapter.load).mockImplementation(
      (bundle) =>
        new Promise((resolve) => {
          resolvers.set(bundle.skeletonFile.name, resolve);
        })
    );
    const controller = new SpineViewerController(adapter);

    const first = controller.load(files("first"));
    await vi.waitFor(() => expect(adapter.load).toHaveBeenCalledOnce());
    const second = controller.load(files("second"));
    await vi.waitFor(() => expect(adapter.load).toHaveBeenCalledTimes(2));

    const newerMetadata: SpineRuntimeMetadata = {
      ...metadata,
      animations: [{ name: "newer", duration: 3, events: [] }]
    };
    resolvers.get("second.json")?.(newerMetadata);
    await expect(second).resolves.toBe(true);
    resolvers.get("first.json")?.(metadata);
    await expect(first).resolves.toBe(false);

    expect(controller.getSnapshot()).toMatchObject({
      animation: "newer",
      duration: 3,
      bundle: { skeletonFile: { name: "second.json" } }
    });
    expect(adapter.cancelPendingLoad).toHaveBeenCalledTimes(2);
  });

  it("cancels an active load before validating a newer selection", async () => {
    let resolveFirst: ((value: SpineRuntimeMetadata) => void) | undefined;
    const adapter = runtime();
    vi.mocked(adapter.load).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        })
    );
    const controller = new SpineViewerController(adapter);

    const first = controller.load(files("first"));
    await vi.waitFor(() => expect(adapter.load).toHaveBeenCalledOnce());
    await expect(controller.load([])).rejects.toMatchObject({
      code: "EMPTY_BUNDLE"
    });
    resolveFirst?.(metadata);

    await expect(first).resolves.toBe(false);
    expect(adapter.cancelPendingLoad).toHaveBeenCalledTimes(2);
  });

  it("restores the last ready preview when a superseding selection is invalid", async () => {
    let resolvePending: ((value: SpineRuntimeMetadata) => void) | undefined;
    const adapter = runtime();
    const controller = new SpineViewerController(adapter);
    await controller.load(files("ready"));
    vi.mocked(adapter.load).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePending = resolve;
        })
    );

    const pending = controller.load(files("pending"));
    await vi.waitFor(() => expect(adapter.load).toHaveBeenCalledTimes(2));
    await expect(controller.load([])).rejects.toMatchObject({
      code: "EMPTY_BUNDLE"
    });

    expect(controller.getSnapshot()).toMatchObject({
      status: "ready",
      bundle: { skeletonFile: { name: "ready.json" } }
    });
    resolvePending?.(metadata);
    await expect(pending).resolves.toBe(false);
  });
});
