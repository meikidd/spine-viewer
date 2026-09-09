import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SpineViewerImpl } from "../src/components/SpineViewer";
import type { SpineRuntime, SpineRuntimeMetadata } from "../src/core/controller";

const file = (name: string, content: string, type = "") =>
  new File([content], name, { type });

const resourceFiles = [
  file(
    "hero.json",
    JSON.stringify({
      skeleton: { spine: "3.8.99" },
      bones: [{ name: "root" }],
      slots: [],
      skins: {},
      animations: {}
    })
  ),
  file(
    "hero.atlas",
    "hero.png\nsize: 1,1\nformat: RGBA8888\nfilter: Linear,Linear\nrepeat: none\n"
  ),
  file("hero.png", "image", "image/png")
];

const metadata: SpineRuntimeMetadata = {
  animations: [
    {
      name: "idle",
      duration: 2,
      events: [
        {
          id: "idle:0:0",
          name: "impact",
          time: 0.75,
          intValue: 2,
          floatValue: 1.5,
          stringValue: "heavy",
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
  render: vi.fn(),
  dispose: vi.fn()
});

describe("SpineViewer", () => {
  it("loads local files and links an event list item to the timeline", async () => {
    const user = userEvent.setup();
    const adapter = runtime();
    const onLoad = vi.fn();
    render(
      <SpineViewerImpl
        runtimeFactory={() => adapter}
        onLoad={onLoad}
      />
    );

    await user.upload(screen.getByLabelText("选择 Spine 资源文件"), resourceFiles);

    expect(await screen.findByRole("option", { name: "idle" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "blue" })).toBeInTheDocument();
    expect(onLoad).toHaveBeenCalledOnce();

    await user.click(
      screen.getByRole("button", { name: "选择事件 impact，0.750 秒" })
    );

    expect(screen.getByLabelText("当前时间")).toHaveTextContent(
      "0.750s / 2.000s"
    );
    expect(screen.getByRole("button", { name: "事件 impact，0.750 秒" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(adapter.seek).toHaveBeenLastCalledWith(0.75);
  });
});
