'use client';

import { signIn } from 'next-auth/react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { AuthForm } from '@/components/auth-form';

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-md rounded-2xl shadow-xl">
        <CardHeader>
          <h1 className="text-center text-2xl font-semibold">
            Sign in to your account
          </h1>
        </CardHeader>

        <CardContent className="flex flex-col gap-6">
          {/* Google OAuth button */}
          <Button
            variant="outline"
            className="w-full"
            onClick={() => signIn('google', { callbackUrl: '/' })}
          >
            {/* lightweight “G” logo */}
            <svg
              aria-hidden="true"
              className="mr-2 h-5 w-5"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path d="M21.6 12.227c0-.81-.073-1.593-.21-2.353H12v4.45h5.44a4.655 4.655 0 0 1-2.017 3.056v2.55h3.27c1.915-1.764 3.018-4.36 3.018-7.703Z" />
              <path d="M12 22c2.7 0 4.96-.893 6.614-2.425l-3.27-2.55c-.905.607-2.067.964-3.344.964-2.569 0-4.746-1.733-5.525-4.067H3.11v2.56A9.999 9.999 0 0 0 12 22Z" />
              <path d="M6.475 13.922A5.99 5.99 0 0 1 6 12c0-.667.108-1.312.308-1.922V7.518H3.11A10.002 10.002 0 0 0 2 12c0 1.64.393 3.188 1.11 4.482l3.365-2.56Z" />
              <path d="M12 6.5c1.47 0 2.79.505 3.833 1.496l2.874-2.874C17.0 3.435 14.7 2.5 12 2.5 7.42 2.5 3.55 5.37 2 9.18l3.308 2.56C4.98 9.26 8.18 6.5 12 6.5Z" />
            </svg>
            Continue with Google
          </Button>

          {/* Divider */}
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="h-px w-full bg-border" />
            </div>
            <span className="relative mx-auto block w-max bg-background px-3 text-sm text-muted-foreground">
              or
            </span>
          </div>

          {/* Email / password form */}
          <AuthForm />
        </CardContent>
      </Card>
    </main>
  );
}
