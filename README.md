# Spine Viewer

用于加载和检查本地 Spine 3.8.20–3.8.x 动画资源的 React 组件。

## 开发

```bash
npm install
npm run dev
```

浏览器中选择一组扁平资源文件：

- 一个 `.json` 或 `.skel`
- 一个 `.atlas`
- atlas 引用的全部纹理图片

文件只在浏览器内处理，不会上传服务器。

## 构建与测试

```bash
npm run typecheck
npm test
npm run build
```

## React 用法

```tsx
import { SpineViewer } from "@spine-viewer/react";
import "@spine-viewer/react/style.css";

export function Preview() {
  return <SpineViewer onError={console.error} />;
}
```

宿主也可以传入 `files` 并隐藏内置文件选择：

```tsx
<SpineViewer files={files} showUploader={false} />
```

组件通过 `ref` 提供 `play()`、`pause()`、`seek()`、`setAnimation()` 和
`setSkin()`。

## 限制

- 仅支持 Spine 3.8.20–3.8.x。
- 首版不支持 ZIP、文件夹或 atlas 中的嵌套纹理路径。
- 首版面向最新版桌面 Chrome、Edge 和 Safari。
- 使用和分发时必须遵守 `SPINE-RUNTIMES-LICENSE`。

详细需求见 [PRD.md](./PRD.md)。
