import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { supabase } from '../api/supabase';
import type { User, Session } from '@supabase/supabase-js';

interface AuthState {
  user: User | null;
  session: Session | null;
  isLoading: boolean;
  error: string | null;
  subscription: ReturnType<typeof supabase.auth.onAuthStateChange>['data']['subscription'] | null;
  
  // Actions
  initialize: () => Promise<unknown>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  clearError: () => void;
  cleanup: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      session: null,
      isLoading: true,
      error: null,
      subscription: null,

      initialize: async () => {
        try {
          // Get current session
          const { data: { session }, error } = await supabase.auth.getSession();
          
          if (error) throw error;
          
          set({
            user: session?.user ?? null,
            session,
            isLoading: false,
          });

          // Listen for auth changes
          const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            set({
              user: session?.user ?? null,
              session,
            });
          });

          // Store subscription for cleanup
          set({ subscription });
          return subscription;
        } catch (error) {
          set({
            isLoading: false,
            error: error instanceof Error ? error.message : 'Auth initialization failed',
          });
        }
      },

      signIn: async (email: string, password: string) => {
        set({ isLoading: true, error: null });

        try {
          const { data, error } = await supabase.auth.signInWithPassword({
            email,
            password,
          });

          if (error) throw error;

          set({
            user: data.user,
            session: data.session,
            isLoading: false,
          });
        } catch (error) {
          set({
            isLoading: false,
            error: error instanceof Error ? error.message : 'Sign in failed',
          });
          throw error;
        }
      },

      signOut: async () => {
        set({ isLoading: true });

        try {
          // Cleanup subscription before signout
          const { subscription } = get();
          subscription?.unsubscribe();
          
          await supabase.auth.signOut();
          set({
            user: null,
            session: null,
            subscription: null,
            isLoading: false,
          });
        } catch (error) {
          set({
            isLoading: false,
            error: error instanceof Error ? error.message : 'Sign out failed',
          });
        }
      },

      clearError: () => set({ error: null }),

      cleanup: () => {
        const { subscription } = get();
        subscription?.unsubscribe();
        set({ subscription: null });
      },
    }),
    {
      name: 'amina-auth',
      partialize: (state) => ({
        // Only persist these fields
        user: state.user,
        session: state.session,
      }),
    }
  )
);

// Initialize auth on import
useAuthStore.getState().initialize();
