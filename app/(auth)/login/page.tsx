'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { signIn } from 'next-auth/react';

import { AuthForm } from '@/components/auth-form';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/toast';

export default function LoginPage() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(formData: FormData) {
    setSubmitting(true);

    const res = await signIn('credentials', {
      email: formData.get('email'),
      password: formData.get('password'),
      redirect: false,
    });

    setSubmitting(false);

    if (res?.error) {
      toast({ type: 'error', description: 'Invalid credentials' });
    } else {
      router.replace('/');
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background">
      <Card
        className="
          w-full max-w-[478px]
          shadow-md
          border-l-[4px] border-[#D4AF37]
        "
      >
       <div className="flex flex-col items-center pt-6">
        <img src="/logo.svg" alt="Logo" className="h-32 w-auto" />
        <span className="mt-2 text-sm font-semibold text-primary uppercase tracking-wide">
          I am your financial analysis and financial due diligence assistant -  I am here to help you with undertanding the indutry you are about to work on.
          Please share some information on the industry you are working on I will will help you understand the industry value drivers and will also guide you with a list of information required to anlyse the target company.
        </span>
       </div>
        <CardContent className="space-y-6 p-8">
          {/* Google OAuth button */}
          <Button
            variant="outline"
            className="w-full py-3.5"
            onClick={() => signIn('google', { callbackUrl: '/' })}
          >
            <svg
              aria-hidden
              className="mr-2 size-5"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path d="M12 12v4.8h6.8A6.7 6.7 0 0 1 12 19.6 7.6 7.6 0 0 1 4.4 12 7.6 7.6 0 0 1 12 4.4a7.3 7.3 0 0 1 5.1 2l3.6-3.6A12 12 0 0 0 0 12a12 12 0 0 0 12 12c6.9 0 12-5 12-12 0-.8-.1-1.6-.2-2.4H12Z" />
            </svg>
            Continue with Google
          </Button>

          {/* divider */}
          <div className="relative flex items-center">
            <span className="grow border-t border-muted-foreground/20" />
            <span className="mx-3 text-xs uppercase text-muted-foreground">
              or
            </span>
            <span className="grow border-t border-muted-foreground/20" />
          </div>

          {/* Email / password inputs rendered by AuthForm */}
          <AuthForm action={handleSubmit}>
            <Button
              type="submit"
              className="w-full"
              disabled={submitting}
            >
              {submitting ? 'Signing in…' : 'Sign in'}
            </Button>
          </AuthForm>
        </CardContent>
      </Card>
    </main>
  );
}
