import { ArrowLeft } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { ExtensionUpdates } from "../components/ExtensionUpdates";

export function AboutPage() {
  const navigate = useNavigate();
  return (
    <div className="flex flex-col min-h-[500px] p-4 gap-4">
      <header>
        <button onClick={() => navigate(-1)} aria-label="返回">
          <ArrowLeft className="w-4 h-4" />
        </button>
      </header>
      <img
        src="/assets/icon-128.png"
        alt="Content Studio"
        className="w-16 h-16"
      />
      <h1 className="text-lg font-semibold">Content Studio</h1>
      <p>版本 {chrome.runtime.getManifest().version}</p>
      <p>本地内容工作台 · 账号核验、平台草稿与可追溯回执。</p>
      <p>草稿已保存后，请在 Content Studio 查看发布能力与任务状态。</p>
      <ExtensionUpdates />
      <a
        href="https://github.com/wingxking/content-studio"
        target="_blank"
        rel="noopener noreferrer"
      >
        源码与帮助
      </a>
      <section className="text-sm text-muted-foreground">
        <h2>开源来源</h2>
        <p>
          本扩展基于 fun / Wechatsync 2.0.9 恢复并修改，采用 GPL-3.0。Content
          Studio 为独立修改版本。
        </p>
        <a
          href="https://github.com/wechatsync/Wechatsync"
          target="_blank"
          rel="noopener noreferrer"
        >
          上游项目与许可
        </a>
      </section>
    </div>
  );
}
