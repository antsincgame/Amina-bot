// Re-export shared types
export type {
  Settings,
  Prompt,
  Conversation,
  Message,
  AnalyticsEvent,
  AnalyticsEventType,
  AIRequest,
  AIResponse,
  DashboardStats,
  SettingsUpdate,
} from '../../../shared/types/index.js';

// Admin-specific types
export interface AuthUser {
  id: string;
  email: string;
  role: 'admin' | 'viewer';
}

export interface NavItem {
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}

export interface StatCard {
  label: string;
  value: number;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  bgColor: string;
  format?: (value: number) => string;
}
