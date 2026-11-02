import type { JSX } from 'react'

/**
 * 模型配置页（W6.9 起）：magpie 控制台 surface 已摘除（原生视图遮挡与
 * 「点击没反应」根因），本页降级为占位说明；模型目录见「模型」页。
 */
export default function ConsolePage(): JSX.Element {
  return (
    <div className="console-page">
      <div className="workspace-empty">
        <h2>模型配置</h2>
        <p>
          magpie 控制台在本阶段未集成（原生视图曾遮挡主界面导致点击失效）。
          模型目录可在「模型」页查看；模型接线与配置后续版本再接入。
        </p>
      </div>
    </div>
  )
}
