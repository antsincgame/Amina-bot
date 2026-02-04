import React, { Component, ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return {
      hasError: true,
      error,
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error('Error boundary caught error:', error, errorInfo);
    this.setState({
      errorInfo,
    });
  }

  handleReset = (): void => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
    window.location.href = '/';
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-black flex items-center justify-center p-4">
          <div className="card max-w-2xl">
            <div className="flex items-start gap-4">
              <div className="p-3 bg-red-500/10 rounded-lg">
                <AlertTriangle className="w-8 h-8 text-red-500" />
              </div>
              <div className="flex-1">
                <h1 className="text-2xl font-bold text-white mb-2">
                  Что-то пошло не так
                </h1>
                <p className="text-gray-400 mb-4">
                  Произошла непредвиденная ошибка. Попробуйте обновить страницу.
                </p>

                {this.state.error && (
                  <details className="mb-4">
                    <summary className="text-sm text-gray-500 cursor-pointer hover:text-gray-300 mb-2">
                      Техническая информация
                    </summary>
                    <div className="bg-gray-800 rounded-lg p-4 text-xs text-gray-400 overflow-auto max-h-64">
                      <div className="font-mono">
                        <div className="text-red-400 font-semibold mb-2">
                          {this.state.error.name}: {this.state.error.message}
                        </div>
                        <pre className="whitespace-pre-wrap">
                          {this.state.error.stack}
                        </pre>
                        {this.state.errorInfo && (
                          <pre className="whitespace-pre-wrap mt-2 pt-2 border-t border-gray-700">
                            {this.state.errorInfo.componentStack}
                          </pre>
                        )}
                      </div>
                    </div>
                  </details>
                )}

                <button
                  onClick={this.handleReset}
                  className="btn-primary inline-flex items-center gap-2"
                >
                  <RefreshCw className="w-4 h-4" />
                  Вернуться на главную
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
