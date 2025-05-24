'use client';

import { useState } from 'react';
import { Menu, ChevronLeft } from 'lucide-react';

import { SidebarConversations } from '@/components/sidebar-conversations';
import { SidebarUserNav } from '@/components/sidebar-user-nav';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function AppSidebar() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      className={cn(
        'flex h-full flex-col border-r bg-sidebar transition-all duration-300',
        collapsed ? 'w-16' : 'w-64',
      )}
    >
      {/* header with logo + collapse toggle */}
      <header className="flex h-12 items-center gap-2 px-4 text-lg font-semibold">
        {!collapsed && (
          <>
            <img src="/logo.svg" alt="Logo" className="h-6 w-6 shrink-0" />
            ValueDriver
          </>
        )}

        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => setCollapsed((p) => !p)}
        >
          {collapsed ? <Menu size={18} /> : <ChevronLeft size={18} />}
        </Button>
      </header>

      {/* conversations list */}
      <div className="flex-1 overflow-y-auto">
        <SidebarConversations collapsed={collapsed} />
      </div>

      {/* user footer */}
      <div className="border-t p-2">
        <SidebarUserNav />
      </div>
    </aside>
  );
}
