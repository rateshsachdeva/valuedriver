'use client';

import type { User } from 'next-auth';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

import { PlusIcon } from '@/components/icons';
import { SidebarHistory } from '@/components/sidebar-history';
import { SidebarUserNav } from '@/components/sidebar-user-nav';
import { Button } from '@/components/ui/button';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  useSidebar,
} from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export function AppSidebar({ user }: { user: User | undefined }) {
  const router = useRouter();
  const { setOpenMobile } = useSidebar();

  return (
    <Sidebar className="group-data-[side=left]:border-r-0">
      {/* ───────────── header ───────────── */}
      <SidebarHeader>
        <SidebarMenu>
          <div className="flex items-center justify-between">
            <Link
              href="/"
              onClick={() => setOpenMobile(false)}
              className="flex items-center gap-3"
            >
              {/* brand logo + title */}
              <div className="flex items-center gap-2">
                {/* Light mode logo */}
                <img
                  src="/logo.svg"
                  alt="Logo"
                  className="h-12 w-auto block dark:hidden"
                />

                {/* Dark mode logo */}
                <img
                  src="/logo-dark.svg"
                  alt="Logo"
                  className="h-12 w-auto hidden dark:block"
                />

                <span className="text-lg font-semibold px-2 hover:bg-muted rounded-md cursor-pointer">
                  Understand Key Value drivers
                </span>
              </div>
            </Link>

            {/* new-chat button */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  type="button"
                  className="p-2 h-fit"
                  onClick={() => {
                    setOpenMobile(false);
                    router.push('/');
                    router.refresh();
                  }}
                >
                  <PlusIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent align="end">New Chat</TooltipContent>
            </Tooltip>
          </div>
        </SidebarMenu>
      </SidebarHeader>

      {/* ────────── chat history ────────── */}
      <SidebarContent>
        <SidebarHistory user={user} />
      </SidebarContent>

      {/* ─────────── footer nav ─────────── */}
      <SidebarFooter>
        <SidebarUserNav user={user} />
      </SidebarFooter>
    </Sidebar>
  );
}
