import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { account } from '../api/supabase';
import type { Models } from 'appwrite';

interface AuthState {
  user: Models.User<Models.Preferences> | null;
  isLoading: boolean;
  error: string | null;
  
  initialize: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  clearError: () => void;
  cleanup: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      isLoading: true,
      error: null,

      initialize: async () => {
        try {
          const user = await account.get();
          set({ user, isLoading: false });
        } catch {
          // No active session
          set({ user: null, isLoading: false });
        }
      },

      signIn: async (email: string, password: string) => {
        set({ isLoading: true, error: null });
        try {
          await account.createEmailPasswordSession(email, password);
          const user = await account.get();
          set({ user, isLoading: false });
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
          await account.deleteSession('current');
          set({ user: null, isLoading: false });
        } catch (error) {
          set({
            isLoading: false,
            error: error instanceof Error ? error.message : 'Sign out failed',
          });
        }
      },

      clearError: () => set({ error: null }),
      cleanup: () => {},
    }),
    {
      name: 'amina-auth',
      partialize: (state) => ({
        user: state.user,
      }),
    }
  )
);

// Initialize auth on import
useAuthStore.getState().initialize();
