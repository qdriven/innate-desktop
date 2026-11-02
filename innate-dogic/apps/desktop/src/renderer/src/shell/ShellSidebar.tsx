import type { JSX } from 'react'
import type { HarnessState } from '@dogic/core'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from '@innate/ui'
import type { PageDef } from '../pages'

interface ShellSidebarProps {
  pages: PageDef[]
  activeId: string | undefined
  harnessPhase: HarnessState['phase']
  onNavigate: (pageId: string) => void
  onSwitchMode: () => void
}

/**
 * 壳左栏（W1b.2）：导航注册与底部状态位。
 * chrome 由 @innate/ui Sidebar 原语承载（a11y/折叠/语义 token）；
 * .nav-item 类与 title 属性保持 W0 冒烟 DOM 契约不变。
 */
export default function ShellSidebar({
  pages,
  activeId,
  harnessPhase,
  onNavigate,
  onSwitchMode,
}: ShellSidebarProps): JSX.Element {
  return (
    <aside className="sidebar">
      <SidebarProvider
        className="sidebar-chrome"
        style={{ '--sidebar-width': '40px', '--sidebar-width-icon': '40px' } as React.CSSProperties}
      >
        <Sidebar className="w-full border-none bg-transparent">
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  {pages.map((page) => (
                    <SidebarMenuItem key={page.id}>
                      <SidebarMenuButton
                        render={
                          <button
                            type="button"
                            className={`nav-item ${activeId === page.id ? 'current' : ''}`}
                            data-current={activeId === page.id}
                            title={page.label}
                            aria-label={page.label}
                            onClick={() => onNavigate(page.id)}
                          />
                        }
                        isActive={activeId === page.id}
                        tooltip={page.label}
                      >
                        <span className="nav-icon" aria-hidden>{page.icon}</span>
                        <span className="nav-label">{page.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter>
            <span className={`dot ${harnessPhase === 'running' ? 'ok' : ''}`} aria-label={`Harness ${harnessPhase}`} />
            <button
              type="button"
              className="mode-switch"
              title="切换模式"
              aria-label="切换模式"
              onClick={onSwitchMode}
            >
              ⇄
            </button>
          </SidebarFooter>
        </Sidebar>
      </SidebarProvider>
    </aside>
  )
}
