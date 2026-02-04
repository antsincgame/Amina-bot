import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../hooks/useAuth';
import {
  LayoutDashboard,
  Settings,
  MessageSquare,
  BarChart3,
  LogOut,
  Bot,
  AlertCircle,
  Mic,
  Users,
  Key,
} from 'lucide-react';

const Layout = () => {
  const { user, signOut } = useAuthStore();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    navigate('/login');
  };

  const navItems = [
    { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
    { to: '/users', icon: Users, label: 'Пользователи' },
    { to: '/api-keys', icon: Key, label: 'API Ключи' },
    { to: '/settings', icon: Settings, label: 'Настройки AI' },
    { to: '/multimodal', icon: Mic, label: 'Голос и Фото' },
    { to: '/prompts', icon: MessageSquare, label: 'Промпты' },
    { to: '/analytics', icon: BarChart3, label: 'Аналитика' },
    { to: '/logs', icon: AlertCircle, label: 'Логи' },
  ];

  return (
    <div className="min-h-screen flex" style={{ background: 'var(--void-black)' }}>
      {/* Sidebar */}
      <aside 
        className="w-64 flex flex-col border-r"
        style={{ 
          background: 'linear-gradient(180deg, var(--deep-space) 0%, var(--void-black) 100%)',
          borderColor: 'rgba(255, 215, 0, 0.1)',
        }}
      >
        {/* Logo */}
        <div 
          className="h-16 flex items-center gap-3 px-6 border-b"
          style={{ borderColor: 'rgba(255, 215, 0, 0.1)' }}
        >
          <div 
            className="w-9 h-9 rounded-lg flex items-center justify-center"
            style={{
              background: 'linear-gradient(135deg, rgba(255, 215, 0, 0.3), rgba(139, 92, 246, 0.3))',
              border: '1px solid rgba(255, 215, 0, 0.4)',
              boxShadow: '0 0 15px rgba(255, 215, 0, 0.2)',
            }}
          >
            <Bot className="w-5 h-5 text-amber-400" />
          </div>
          <span 
            className="font-semibold text-lg tracking-wider text-gradient-gold"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            AMINA
          </span>
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-4 space-y-1">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                isActive ? 'sidebar-link-active' : 'sidebar-link'
              }
            >
              <item.icon className="w-5 h-5" />
              <span style={{ fontFamily: 'var(--font-heading)' }}>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        {/* User section */}
        <div 
          className="p-4 border-t"
          style={{ borderColor: 'rgba(255, 215, 0, 0.1)' }}
        >
          <div className="flex items-center gap-3 mb-3">
            <div 
              className="w-9 h-9 rounded-full flex items-center justify-center"
              style={{
                background: 'rgba(255, 215, 0, 0.15)',
                border: '1px solid rgba(255, 215, 0, 0.3)',
              }}
            >
              <span className="text-sm font-medium text-amber-400">
                {user?.email?.charAt(0).toUpperCase()}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-300 truncate">{user?.email}</p>
            </div>
          </div>
          <button
            onClick={handleSignOut}
            className="sidebar-link w-full text-red-400 hover:bg-red-500/10 hover:text-red-300"
          >
            <LogOut className="w-5 h-5" />
            <span style={{ fontFamily: 'var(--font-heading)' }}>Выйти</span>
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main 
        className="flex-1 overflow-auto sacred-bg"
        style={{ background: 'var(--void-black)' }}
      >
        <Outlet />
      </main>
    </div>
  );
};

export default Layout;
