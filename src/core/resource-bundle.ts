export const RESOURCE_LIMITS = {
  totalBytes: 100 * 1024 * 1024,
  skeletonBytes: 20 * 1024 * 1024,
  atlasBytes: 5 * 1024 * 1024,
  textureBytes: 32 * 1024 * 1024
} as const;

export type SkeletonFormat = "json" | "skel";

export type BundleValidationErrorCode =
  | "EMPTY_BUNDLE"
  | "INVALID_FILE_COUNT"
  | "UNSUPPORTED_FILE"
  | "DUPLICATE_FILE_NAME"
  | "BUNDLE_TOO_LARGE"
  | "FILE_TOO_LARGE"
  | "INVALID_JSON"
  | "UNSUPPORTED_VERSION"
  | "INVALID_ATLAS"
  | "NESTED_TEXTURE_PATH"
  | "MISSING_TEXTURE";

export class BundleValidationError extends Error {
  constructor(
    public readonly code: BundleValidationErrorCode,
    message: string,
    public readonly fileName?: string
  ) {
    super(message);
    this.name = "BundleValidationError";
  }
}

export interface ValidatedSpineResourceBundle {
  files: readonly File[];
  skeletonFile: File;
  atlasFile: File;
  textureFiles: ReadonlyMap<string, File>;
  atlasPages: readonly string[];
  format: SkeletonFormat;
  version: string | null;
  totalBytes: number;
}

const PAGE_METADATA = new Set(["size", "format", "filter", "repeat", "pma"]);

const extension = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
};

const readText = (file: Blob): Promise<string> => {
  if (typeof file.text === "function") return file.text();

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsText(file);
  });
};

export function parseAtlasPageNames(atlasText: string): string[] {
  const lines = atlasText.replace(/\r\n?/g, "\n").split("\n");
  const pages: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const candidate = raw.trim();
    if (!candidate || raw !== candidate || candidate.includes(":")) continue;

    let nextIndex = index + 1;
    while (nextIndex < lines.length && !lines[nextIndex].trim()) nextIndex += 1;
    const next = lines[nextIndex]?.trim() ?? "";
    const separator = next.indexOf(":");
    const key = separator === -1 ? "" : next.slice(0, separator).trim();
    const previousIsBlank =
      index === 0 || lines.slice(0, index).reverse().find((line) => line.trim()) === undefined
        ? true
        : !lines[index - 1].trim();

    if ((pages.length === 0 || previousIsBlank) && PAGE_METADATA.has(key)) {
      pages.push(candidate);
    }
  }

  return pages;
}

function assertUniqueNames(files: readonly File[]) {
  const names = new Set<string>();
  for (const file of files) {
    if (names.has(file.name)) {
      throw new BundleValidationError(
        "DUPLICATE_FILE_NAME",
        `存在同名文件“${file.name}”，无法确定 atlas 应使用哪一个文件。请只保留其中一份后重试。`,
        file.name
      );
    }
    names.add(file.name);
  }
}

function assertSizes(files: readonly File[], skeleton: File, atlas: File) {
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > RESOURCE_LIMITS.totalBytes) {
    throw new BundleValidationError(
      "BUNDLE_TOO_LARGE",
      "资源包总大小不能超过 100 MB。请压缩纹理或减少文件后重试。"
    );
  }
  if (skeleton.size > RESOURCE_LIMITS.skeletonBytes) {
    throw new BundleValidationError(
      "FILE_TOO_LARGE",
      `骨骼文件“${skeleton.name}”不能超过 20 MB。请降低导出数据体积后重试。`,
      skeleton.name
    );
  }
  if (atlas.size > RESOURCE_LIMITS.atlasBytes) {
    throw new BundleValidationError(
      "FILE_TOO_LARGE",
      `Atlas 文件“${atlas.name}”不能超过 5 MB。请检查或重新导出 atlas。`,
      atlas.name
    );
  }
  return total;
}

async function readJsonVersion(file: File): Promise<string> {
  let data: unknown;
  try {
    data = JSON.parse(await readText(file));
  } catch {
    throw new BundleValidationError(
      "INVALID_JSON",
      `无法解析 JSON 骨骼文件“${file.name}”。请从 Spine 3.8 重新导出该文件。`,
      file.name
    );
  }

  const version =
    typeof data === "object" &&
    data !== null &&
    "skeleton" in data &&
    typeof data.skeleton === "object" &&
    data.skeleton !== null &&
    "spine" in data.skeleton &&
    typeof data.skeleton.spine === "string"
      ? data.skeleton.spine
      : null;

  const match = version?.match(/^3\.8\.(\d+)(?:\D.*)?$/);
  if (!match || Number(match[1]) < 20) {
    throw new BundleValidationError(
      "UNSUPPORTED_VERSION",
      `“${file.name}”必须由 Spine 3.8.20–3.8.x 导出。`,
      file.name
    );
  }

  return version as string;
}

export async function validateSpineResourceBundle(
  inputFiles: Iterable<File>
): Promise<ValidatedSpineResourceBundle> {
  const files = Array.from(inputFiles);
  if (files.length === 0) {
    throw new BundleValidationError(
      "EMPTY_BUNDLE",
      "请选择一个骨骼文件、一个 atlas 文件及其全部纹理。"
    );
  }

  assertUniqueNames(files);

  const skeletonFiles = files.filter((file) =>
    [".json", ".skel"].includes(extension(file.name))
  );
  const atlasFiles = files.filter((file) => extension(file.name) === ".atlas");

  if (skeletonFiles.length !== 1 || atlasFiles.length !== 1) {
    throw new BundleValidationError(
      "INVALID_FILE_COUNT",
      "资源包必须恰好包含一个 .json 或 .skel 文件，以及一个 .atlas 文件。请重新选择完整资源包。"
    );
  }

  const skeletonFile = skeletonFiles[0];
  const atlasFile = atlasFiles[0];
  const totalBytes = assertSizes(files, skeletonFile, atlasFile);
  const atlasPages = parseAtlasPageNames(await readText(atlasFile));

  if (atlasPages.length === 0) {
    throw new BundleValidationError(
      "INVALID_ATLAS",
      `Atlas 文件“${atlasFile.name}”未包含可识别的纹理页。请从 Spine 3.8 重新导出 atlas。`,
      atlasFile.name
    );
  }

  const textureFiles = new Map<string, File>();
  for (const page of atlasPages) {
    if (page.includes("/") || page.includes("\\")) {
      throw new BundleValidationError(
        "NESTED_TEXTURE_PATH",
        `Atlas 纹理“${page}”包含目录路径。请将纹理与 atlas 放在同一目录，并移除 atlas 中的目录前缀。`,
        page
      );
    }
    const texture = files.find((file) => file.name === page);
    if (!texture) {
      throw new BundleValidationError(
        "MISSING_TEXTURE",
        `缺少 Atlas 引用的纹理文件“${page}”。请将该纹理加入本次文件选择。`,
        page
      );
    }
    if (texture.size > RESOURCE_LIMITS.textureBytes) {
      throw new BundleValidationError(
        "FILE_TOO_LARGE",
        `纹理文件“${page}”不能超过 32 MB。请压缩或缩小纹理后重试。`,
        page
      );
    }
    textureFiles.set(page, texture);
  }

  const resourceNames = new Set([
    skeletonFile.name,
    atlasFile.name,
    ...atlasPages
  ]);
  const unsupportedFile = files.find((file) => !resourceNames.has(file.name));
  if (unsupportedFile) {
    throw new BundleValidationError(
      "UNSUPPORTED_FILE",
      `文件“${unsupportedFile.name}”不是当前 atlas 使用的资源。请移除该文件后重试。`,
      unsupportedFile.name
    );
  }

  const format: SkeletonFormat = extension(skeletonFile.name) === ".json" ? "json" : "skel";
  const version = format === "json" ? await readJsonVersion(skeletonFile) : null;

  return {
    files,
    skeletonFile,
    atlasFile,
    textureFiles,
    atlasPages,
    format,
    version,
    totalBytes
  };
}
