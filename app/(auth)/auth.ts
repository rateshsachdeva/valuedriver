/* app/(auth)/auth.ts */
export const runtime = 'nodejs';

import NextAuth, { type DefaultSession } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import GoogleProvider from 'next-auth/providers/google';
import { compare } from 'bcrypt-ts';

import type { DefaultJWT } from 'next-auth/jwt';

import { authConfig } from './auth.config';
import { getUser, createUser } from '@/lib/db/queries';
import { DUMMY_PASSWORD } from '@/lib/constants'; // fallback hash for Google-only users

/* ------------------------------------------------------------------ */
/*                         Custom type fields                         */
/* ------------------------------------------------------------------ */
export type UserType = 'regular' | 'guest';

declare module 'next-auth' {
  interface Session extends DefaultSession {
    user: {
      id: string;
      type: UserType;
    } & DefaultSession['user'];
  }
}

declare module 'next-auth/jwt' {
  interface JWT extends DefaultJWT {
    id: string;
    type: UserType;
  }
}

/* ------------------------------------------------------------------ */
/*                       NextAuth configuration                       */
/* ------------------------------------------------------------------ */
export const {
  handlers: { GET, POST },
  auth,
  signIn,
  signOut,
} = NextAuth({
  ...authConfig,

  providers: [
    /* ---------- Google OAuth ---------- */
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),

    /* ------ E-mail / password --------- */
   Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials: { email?: string; password?: string } | undefined) {
        const email = credentials?.email;
        const password = credentials?.password;
    
        if (!email || !password) return null;
    
        const [dbUser] = await getUser(email);
        if (!dbUser || !dbUser.password) return null;
    
        const ok = await compare(password, dbUser.password);
        if (!ok) return null;
    
        return {
          id: dbUser.id,
          email: dbUser.email,
          type: 'regular',
        };
      },
    }),

  /* ----------------- Callbacks ----------------- */
  callbacks: {
    /** Persist our custom fields inside the JWT */
    async jwt({ token, user, account, profile }) {
      /* credentials flow puts user obj here */
      if (user) {
        token.id = (user as any).id;
        token.type = (user as any).type;
      }

      /* first-time Google login: upsert user row */
      if (account?.provider === 'google' && profile?.email) {
        const email = profile.email;
        const [dbUser] = await getUser(email);

        if (!dbUser) {
          await createUser(email, DUMMY_PASSWORD);
          const [inserted] = await getUser(email);
          token.id = inserted?.id;
        } else {
          token.id = dbUser.id;
        }
        token.type = 'regular';
      }

      return token;
    },

    /** Expose the custom fields on the client Session object */
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.type = token.type as UserType;
      }
      return session;
    },
  },
});
