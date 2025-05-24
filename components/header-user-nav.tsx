'use client';

import Image from 'next/image';
import { useTheme } from 'next-themes';
import { signOut, useSession } from 'next-auth/react';
import { Moon, Sun, LogOut } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { User } from 'next-auth';

export function HeaderUserNav({ user }: { user: User | undefined }) {
  const { theme, setTheme } = useTheme();
  const { status } = useSession();

  return (
    <div className="flex items-center gap-3">
      {/* Avatar */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Image
            src={`https://avatar.vercel.sh/${user?.email}`}
            alt="Avatar"
            width={28}
            height={28}
            className="rounded-full"
          />
        </TooltipTrigger>
        <TooltipContent>{user?.email}</TooltipContent>
      </Tooltip>

      {/* Theme toggle */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() =>
              setTheme(theme === 'dark' ? 'light' : 'dark')
            }
            className="hover:text-primary transition"
          >
            {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
          </button>
        </TooltipTrigger>
        <TooltipContent>
          Switch to {theme === 'light' ? 'dark' : 'light'} mode
        </TooltipContent>
      </Tooltip>

      {/* Sign out */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => signOut({ callbackUrl: '/login' })}
            className="hover:text-destructive transition"
            disabled={status === 'loading'}
          >
            <LogOut size={18} />
          </button>
        </TooltipTrigger>
        <TooltipContent>Sign out</TooltipContent>
      </Tooltip>
    </div>
  );
}
