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
  Sparkles,
  Newspaper,
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
    { to: '/news-sources', icon: Newspaper, label: 'Источники' },
    { to: '/analytics', icon: BarChart3, label: 'Аналитика' },
    { to: '/logs', icon: AlertCircle, label: 'Логи' },
  ];

  return (
    <div className="min-h-screen flex" style={{ background: 'var(--void-black)' }}>
      {/* Floating Particles Background */}
      <div className="particles">
        {[...Array(15)].map((_, i) => (
          <span
            key={i}
            className="particle"
            style={{
              left: `${Math.random() * 100}%`,
              animationDelay: `${Math.random() * 10}s`,
              animationDuration: `${10 + Math.random() * 10}s`,
            }}
          />
        ))}
      </div>

      {/* Sidebar */}
      <aside 
        className="w-72 flex flex-col relative z-10"
        style={{ 
          background: 'linear-gradient(180deg, rgba(15, 15, 25, 0.98) 0%, rgba(10, 10, 18, 0.99) 100%)',
          borderRight: '1px solid rgba(255, 215, 0, 0.1)',
          backdropFilter: 'blur(20px)',
        }}
      >
        {/* Sidebar Glow */}
        <div 
          className="absolute inset-0 pointer-events-none"
          style={{
            background: 'radial-gradient(ellipse at 50% 0%, rgba(255, 215, 0, 0.05) 0%, transparent 60%)',
          }}
        />

        {/* Logo */}
        <div 
          className="h-20 flex items-center gap-4 px-6 relative"
          style={{ borderBottom: '1px solid rgba(255, 215, 0, 0.1)' }}
        >
          {/* Logo Icon with Aura */}
          <div className="relative">
            <div 
              className="absolute inset-0 rounded-2xl animate-pulse-glow"
              style={{
                background: 'radial-gradient(circle, rgba(255, 215, 0, 0.3) 0%, transparent 70%)',
                filter: 'blur(8px)',
              }}
            />
            <div 
              className="relative w-12 h-12 rounded-2xl flex items-center justify-center"
              style={{
                background: 'linear-gradient(135deg, rgba(255, 215, 0, 0.2), rgba(139, 92, 246, 0.2))',
                border: '1px solid rgba(255, 215, 0, 0.4)',
                boxShadow: '0 0 20px rgba(255, 215, 0, 0.2), inset 0 0 20px rgba(255, 215, 0, 0.1)',
              }}
            >
              <Bot className="w-6 h-6 text-amber-400" />
            </div>
          </div>
          
          {/* Logo Text */}
          <div className="flex flex-col">
            <span 
              className="text-xl font-bold tracking-[0.15em] text-gradient-gold"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              AMINA
            </span>
            <span 
              className="text-[10px] tracking-[0.3em] text-gray-500 uppercase"
              style={{ fontFamily: 'var(--font-heading)' }}
            >
              Admin Panel
            </span>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-4 space-y-1.5 relative z-10">
          {navItems.map((item, index) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                isActive ? 'sidebar-link-active' : 'sidebar-link'
              }
              style={{ 
                animationDelay: `${index * 0.05}s`,
              }}
            >
              <item.icon className="w-5 h-5" />
              <span style={{ fontFamily: 'var(--font-heading)' }}>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        {/* Decorative Divider */}
        <div className="px-6">
          <div className="divider" />
        </div>

        {/* Version & Info */}
        <div className="px-6 py-3">
          <div className="flex items-center gap-2 text-xs text-gray-600">
            <Sparkles className="w-3 h-3" />
            <span style={{ fontFamily: 'var(--font-heading)' }}>Neon Wave v2.0</span>
          </div>
        </div>

        {/* User section */}
        <div 
          className="p-4 relative"
          style={{ borderTop: '1px solid rgba(255, 215, 0, 0.1)' }}
        >
          {/* User Card */}
          <div 
            className="p-3 rounded-xl mb-3"
            style={{
              background: 'linear-gradient(135deg, rgba(255, 215, 0, 0.05), rgba(139, 92, 246, 0.05))',
              border: '1px solid rgba(255, 215, 0, 0.1)',
            }}
          >
            <div className="flex items-center gap-3">
              {/* Avatar with glow */}
              <div className="relative">
                <div 
                  className="absolute inset-0 rounded-full"
                  style={{
                    background: 'radial-gradient(circle, rgba(255, 215, 0, 0.4) 0%, transparent 70%)',
                    filter: 'blur(4px)',
                  }}
                />
                <div 
                  className="relative w-10 h-10 rounded-full flex items-center justify-center"
                  style={{
                    background: 'linear-gradient(135deg, var(--gold-pure), var(--gold-warm))',
                    boxShadow: '0 0 15px rgba(255, 215, 0, 0.3)',
                  }}
                >
                  <span className="text-sm font-bold text-gray-900">
                    {user?.email?.charAt(0).toUpperCase()}
                  </span>
                </div>
              </div>
              
              {/* User Info */}
              <div className="flex-1 min-w-0">
                <p 
                  className="text-sm font-medium text-gray-200 truncate"
                  style={{ fontFamily: 'var(--font-heading)' }}
                >
                  {user?.email?.split('@')[0]}
                </p>
                <p className="text-xs text-gray-500 truncate">
                  {user?.email}
                </p>
              </div>
            </div>
          </div>

          {/* Logout Button */}
          <button
            onClick={handleSignOut}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl
                       text-red-400 text-sm font-medium
                       transition-all duration-300
                       hover:bg-red-500/10 hover:text-red-300"
            style={{ 
              border: '1px solid rgba(239, 68, 68, 0.2)',
              fontFamily: 'var(--font-heading)',
            }}
          >
            <LogOut className="w-4 h-4" />
            <span>Выйти</span>
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main 
        className="flex-1 overflow-auto sacred-bg relative z-10"
        style={{ minHeight: '100vh' }}
      >
        <Outlet />
      </main>
    </div>
  );
};

export default Layout;
