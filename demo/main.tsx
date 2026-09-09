import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SpineViewer } from "../src";
import "../src/styles.css";
import "./demo.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <main className="demo-shell">
      <div className="demo-intro">
        <span>INTERNAL TOOL</span>
        <h1>Spine 动画检查台</h1>
        <p>选择一组 Spine 3.8 资源，在浏览器中检查动画、皮肤和事件帧。</p>
      </div>
      <SpineViewer />
      <p className="demo-note">
        文件仅在当前浏览器标签页内处理，不会上传到服务器。
      </p>
    </main>
  </StrictMode>
);
