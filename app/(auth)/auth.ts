/* app/(auth)/auth.ts */
import { compare } from 'bcrypt-ts';
import NextAuth, { type DefaultSession } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import GoogleProvider from 'next-auth/providers/google';

import { getUser, createUser } from '@/lib/db/queries';
import { authConfig } from './auth.config';
import { DUMMY_PASSWORD } from '@/lib/constants';
import type { DefaultJWT } from 'next-auth/jwt';

export type UserType = 'guest' | 'regular';

/* ------------------------------------------------------------------ */
/*                                       Type augmentation for NextAuth */
/* ------------------------------------------------------------------ */
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
/*                                             NextAuth configuration */
/* ------------------------------------------------------------------ */
export const {
  handlers: { GET, POST },
  auth,
  signIn,
  signOut,
} = NextAuth({
  ...authConfig,

  providers: [
    /* ---- Google OAuth ------------------------------------------------ */
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),

    /* ---- E-mail / password  ----------------------------------------- */
    Credentials({
      credentials: {
        email:    { label: 'Email',    type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize({ email, password }: any) {
        if (!email || !password) return null;

        const [dbUser] = await getUser(email);
        if (!dbUser) return null;

        const ok = await compare(password, dbUser.password);
        if (!ok) return null;

        return { id: dbUser.id, email: dbUser.email, type: 'regular' } as any;
      },
    }),
  ],

  /* ---- Callbacks ---------------------------------------------------- */
  callbacks: {
    /* 1️⃣ Persist our own fields inside the JWT ----------------------- */
    async jwt({ token, user, account, profile }) {
      /* Credentials flow puts the user object here. */
      if (user) {
        token.id   = (user as any).id;
        token.type = (user as any).type;
      }

      /* First-time Google login: make sure the user exists in DB. */
      if (account?.provider === 'google' && profile?.email) {
        const [dbUser] = await getUser(profile.email);

        /* Upsert */
        if (!dbUser) {
          await createUser(profile.email, DUMMY_PASSWORD);
          const [inserted] = await getUser(profile.email);
          token.id = inserted?.id;
        } else {
          token.id = dbUser.id;
        }

        token.type = 'regular';
      }

      return token;
    },

    /* 2️⃣ Expose custom fields on the client Session object ----------- */
    async session({ session, token }) {
      if (session.user) {
        session.user.id   = token.id as string;
        session.user.type = token.type as UserType;
      }
      return session;
    },
  },
});
