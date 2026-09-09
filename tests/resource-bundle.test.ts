import { describe, expect, it } from "vitest";
import {
  BundleValidationError,
  validateSpineResourceBundle
} from "../src/core/resource-bundle";

const file = (name: string, content: string, type = "") =>
  new File([content], name, { type });

const jsonSkeleton = (version = "3.8.99") =>
  file(
    "hero.json",
    JSON.stringify({
      skeleton: { spine: version },
      bones: [{ name: "root" }],
      slots: [],
      skins: {},
      animations: {}
    }),
    "application/json"
  );

const atlas = (page = "hero.png") =>
  file(
    "hero.atlas",
    `${page}
size: 32,32
format: RGBA8888
filter: Linear,Linear
repeat: none
body
  rotate: false
  xy: 0, 0
  size: 32, 32
  orig: 32, 32
  offset: 0, 0
  index: -1
`
  );

describe("validateSpineResourceBundle", () => {
  it("accepts a complete flat Spine 3.8 JSON resource bundle", async () => {
    const texture = file("hero.png", "image", "image/png");

    const bundle = await validateSpineResourceBundle([
      texture,
      atlas(),
      jsonSkeleton()
    ]);

    expect(bundle).toMatchObject({
      format: "json",
      version: "3.8.99",
      skeletonFile: { name: "hero.json" },
      atlasFile: { name: "hero.atlas" }
    });
    expect(bundle.textureFiles.get("hero.png")).toBe(texture);
    expect(bundle.atlasPages).toEqual(["hero.png"]);
  });

  it("rejects a bundle when an atlas texture is missing", async () => {
    await expect(
      validateSpineResourceBundle([jsonSkeleton(), atlas()])
    ).rejects.toMatchObject<Partial<BundleValidationError>>({
      code: "MISSING_TEXTURE",
      fileName: "hero.png"
    });
  });

  it("rejects nested atlas texture paths", async () => {
    await expect(
      validateSpineResourceBundle([
        jsonSkeleton(),
        atlas("textures/hero.png"),
        file("hero.png", "image")
      ])
    ).rejects.toMatchObject<Partial<BundleValidationError>>({
      code: "NESTED_TEXTURE_PATH"
    });
  });

  it("rejects Spine exports older than 3.8.20", async () => {
    await expect(
      validateSpineResourceBundle([
        jsonSkeleton("3.8.19"),
        atlas(),
        file("hero.png", "image")
      ])
    ).rejects.toMatchObject<Partial<BundleValidationError>>({
      code: "UNSUPPORTED_VERSION"
    });
  });

  it("accepts a binary skeleton for runtime version validation", async () => {
    const bundle = await validateSpineResourceBundle([
      file("hero.skel", "binary"),
      atlas(),
      file("hero.png", "image")
    ]);

    expect(bundle.format).toBe("skel");
    expect(bundle.version).toBeNull();
  });

  it("rejects files that are not part of the atlas resource bundle", async () => {
    await expect(
      validateSpineResourceBundle([
        jsonSkeleton(),
        atlas(),
        file("hero.png", "image"),
        file("notes.txt", "not an asset")
      ])
    ).rejects.toMatchObject<Partial<BundleValidationError>>({
      code: "UNSUPPORTED_FILE",
      fileName: "notes.txt"
    });
  });
});
